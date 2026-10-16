import { z } from 'zod';
import { withAllBranches } from '../../db/scoped.js';
import { can } from '../../domain/scope.js';
import { badRequest, conflict, forbidden, notFound } from '../../http/errors.js';
import { checkbox, parse } from '../../http/validate.js';
import { normalizeDn } from '../branchmap/branchmap.js';
import { generatePassword, hashPassword, loadPasswordPolicy } from '../auth/password.js';
import {
  countActiveAdmins,
  createUser,
  getUser,
  listUsers,
  replaceGrants,
  setAuthSource,
  setPassword,
  unlinkAd,
  unlockUser,
  updateUser,
  resetTotp,
  setMustChangePassword,
  setTotpRequired,
} from '../auth/users.repo.js';
import {
  countUnmapped,
  getBranch,
  insertBranch,
  listBranches,
  ousOwnedElsewhere,
  previewOus,
  remapComputers,
  replaceOus,
  updateBranch,
  branchDeleteImpact,
  countBranchComputers,
  deleteBranch,
} from './branches.repo.js';

export const ROLES = ['it', 'lead', 'admin', 'auditor'];

// A DN like "OU=Computers,OU=HN,DC=corp,DC=local": RDNs separated by commas, ending in DC=.
const DN = /^(?:(?:ou|cn)=[^,=]+,)*dc=[^,=]+(?:,dc=[^,=]+)*$/;

/** Lines of a textarea (or an array from JSON) -> normalised, de-duplicated DNs. */
const ouList = z.preprocess(
  (v) => (Array.isArray(v) ? v : String(v ?? '').split(/\r?\n/)),
  z
    .array(z.string())
    .transform((list) => [...new Set(list.map((s) => normalizeDn(s)).filter(Boolean))])
    .pipe(z.array(z.string().max(512).regex(DN, 'invalid_dn')).max(20)),
);

const branchInput = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,16}$/, 'invalid_branch_code'),
  name: z.string().trim().min(1).max(128),
  isActive: checkbox,
  ous: ouList,
});

/** Grants come as "role:all" or "role:<branchId>" strings (form checkboxes and JSON alike). */
const grantList = z.preprocess(
  (v) => (v === undefined || v === '' ? [] : Array.isArray(v) ? v : [v]),
  z.array(
    z
      .string()
      // Only Admin HQ covers all branches; every other role is granted per branch.
      .regex(/^(admin:all|(it|lead|admin|auditor):\d+)$/, 'all_branches_admin_only')
      .transform((s) => {
        const [role, b] = s.split(':');
        return { role, branchId: b === 'all' || role === 'admin' ? null : Number(b) };
      }),
  ),
);

const LOCAL_USERNAME = /^[A-Za-z0-9._-]{2,64}$/;
// AD users sign in with their sAMAccountName (at most 20 characters in AD).
const SAM_ACCOUNT_NAME = /^[A-Za-z0-9._-]{1,20}$/;
const usernameOk = (authSource, username) =>
  authSource === 'ldap' ? SAM_ACCOUNT_NAME.test(username) : LOCAL_USERNAME.test(username);
const USERNAME_HELP = {
  ldap: 'invalid_ad_username',
  local: 'invalid_local_username',
};

const authSource = z.enum(['ldap', 'local']).default('ldap');
const email = z.string().trim().toLowerCase().max(254).pipe(z.email({ message: 'invalid_email' }));

const userCreateInput = z
  .object({
    // "CORP\nguyenvana" is accepted and stored as "nguyenvana".
    username: z.string().trim().max(128).transform((u) => u.slice(u.lastIndexOf('\\') + 1)),
    displayName: z.string().trim().min(1).max(256),
    email,
    authSource,
    grants: grantList,
    totpRequired: checkbox,
    // Local accounts: change the one-time password at the first sign-in (on unless unticked).
    mustChangePassword: z.preprocess((v) => (v === undefined ? 'on' : v), checkbox),
  })
  .superRefine((u, ctx) => {
    if (!usernameOk(u.authSource, u.username)) {
      ctx.addIssue({ code: 'custom', path: ['username'], message: USERNAME_HELP[u.authSource] });
    }
  });

const userUpdateInput = z.object({
  displayName: z.string().trim().min(1).max(256),
  email,
  isActive: checkbox,
  // No default here: leaving it out must never switch how an existing user signs in.
  authSource: z.enum(['ldap', 'local']).optional(),
  grants: grantList,
  // Left out (API): unchanged. The web form always sends them ('off' when unticked).
  totpRequired: checkbox.optional(),
  mustChangePassword: checkbox.optional(),
});

/** Admin HQ: branches/OUs and users. Every change is audited. */
export class AdminService {
  constructor({ pool, audit, settings = null }) {
    this.pool = pool;
    this.audit = audit;
    this.settings = settings;
  }

  /** A one-time password that meets the password policy in force. */
  async #oneTimePassword() {
    return generatePassword(await loadPasswordPolicy(this.settings));
  }

  #check(scope) {
    if (!can(scope, 'admin')) throw forbidden();
  }

  #log(tx, scope, client, detail) {
    return this.audit.append(tx, { ...this.audit.actor(scope, client), action: 'admin_change', detail });
  }

  // ---- branches -------------------------------------------------------------------------

  async listBranches(scope) {
    this.#check(scope);
    return withAllBranches(this.pool, async (tx) => ({ branches: await listBranches(tx), unmapped: await countUnmapped(tx) }));
  }

  async getBranch(scope, id) {
    this.#check(scope);
    const b = await withAllBranches(this.pool, (tx) => getBranch(tx, id));
    if (!b) throw notFound('Branch not found.');
    return b;
  }

  /** How many live computers the given OUs cover, by their current branch. */
  async previewOus(scope, rawOus) {
    this.#check(scope);
    const ous = parse(z.object({ ous: ouList }), { ous: rawOus }).ous;
    return withAllBranches(this.pool, (tx) => previewOus(tx, ous));
  }

  /**
   * Creates (id null) or updates a branch and its root OUs, then re-maps every computer to
   * its branch in the same transaction (a new branch picks up the computers in its OUs at once).
   * Returns { id, moved (computers whose branch changed), computers (live computers now in it) }.
   */
  async saveBranch(scope, id, raw, client = {}) {
    this.#check(scope);
    const input = parse(branchInput, raw);
    return withAllBranches(this.pool, async (tx) => {
      const taken = await ousOwnedElsewhere(tx, id, input.ous);
      if (taken.length) {
        throw conflict('ou_taken', 'An OU already belongs to another branch.', { taken: taken.map((t) => ({ ou: t.root_dn, branch: t.code })) });
      }
      let branchId = id;
      try {
        if (id) {
          if (!(await getBranch(tx, id))) throw notFound('Branch not found.');
          await updateBranch(tx, id, input);
        } else {
          branchId = await insertBranch(tx, input);
        }
      } catch (err) {
        if (err.code === '23505') throw conflict('code_taken', `Branch code ${input.code} already exists.`, { code: input.code });
        throw err;
      }
      await replaceOus(tx, branchId, input.ous);
      const moves = await remapComputers(tx);
      await this.#log(tx, scope, client, {
        op: id ? 'update_branch' : 'create_branch',
        branch: input.code,
        isActive: input.isActive,
        ous: input.ous,
        computersMoved: moves.length,
      });
      return { id: branchId, moved: moves.length, computers: await countBranchComputers(tx, branchId) };
    });
  }

  /** For the delete confirmation: the branch and what deleting it would touch. */
  async branchDeletePreview(scope, id) {
    this.#check(scope);
    return withAllBranches(this.pool, async (tx) => {
      const branch = await getBranch(tx, id);
      if (!branch) throw notFound('Branch not found.');
      return { branch, impact: await branchDeleteImpact(tx, id) };
    });
  }

  /**
   * Deletes a branch. The caller must repeat its code (confirmCode) so it is never deleted by a
   * stray click. Its computers go to N/A, then every computer is re-mapped (one inside an OU of
   * another branch moves there, the same as the next sync would do). Its OUs and the role grants on it
   * are removed. Past log rows keep the old branch id.
   * Returns { code, computers, toNa, toOther, grants }.
   */
  async deleteBranch(scope, id, raw, client = {}) {
    this.#check(scope);
    const { confirmCode } = parse(z.object({ confirmCode: z.string().trim().max(16).default('') }), raw ?? {});
    return withAllBranches(this.pool, async (tx) => {
      const branch = await getBranch(tx, id);
      if (!branch) throw notFound('Branch not found.');
      if (confirmCode.toUpperCase() !== branch.code.toUpperCase()) {
        throw badRequest('confirm_mismatch', 'Type the branch code to confirm the deletion.', { code: branch.code });
      }
      const impact = await branchDeleteImpact(tx, id);
      const { rows: before } = await tx.query('SELECT id FROM computer WHERE branch_id = $1', [id]);
      await deleteBranch(tx, id);
      const moves = await remapComputers(tx);
      const ids = new Set(before.map((r) => String(r.id)));
      const toOther = moves.filter((m) => ids.has(String(m.id)) && m.new_branch !== null).length;
      await this.#log(tx, scope, client, {
        op: 'delete_branch',
        branch: branch.code,
        name: branch.name,
        branchId: id,
        ous: branch.ous,
        computers: impact.computers + impact.computers_gone,
        computersToOtherBranch: toOther,
        grantsRemoved: impact.grants,
        usersLeftWithoutRole: impact.users_left_without_role,
      });
      const total = impact.computers + impact.computers_gone;
      return { code: branch.code, computers: total, toNa: total - toOther, toOther, grants: impact.grants };
    });
  }

  // ---- users ---------------------------------------------------------------------------------
  // People sign in with their AD password (authSource 'ldap', username = sAMAccountName) or, for
  // a few break-glass accounts, a password stored here. Roles are always set here, never from AD.

  async listUsers(scope) {
    this.#check(scope);
    return listUsers(this.pool);
  }

  async getUser(scope, id) {
    this.#check(scope);
    const u = await getUser(this.pool, id);
    if (!u) throw notFound('User not found.');
    return u;
  }

  /**
   * Returns { id, oneTimePassword }. Local users get a one-time password (shown once, changed at
   * first sign-in); AD users get none (oneTimePassword is null) and sign in with their AD password.
   */
  async createUser(scope, raw, client = {}) {
    this.#check(scope);
    const input = parse(userCreateInput, raw);
    const oneTimePassword = input.authSource === 'local' ? await this.#oneTimePassword() : null;
    const passwordHash = oneTimePassword ? await hashPassword(oneTimePassword) : null;
    return withAllBranches(this.pool, async (tx) => {
      try {
        const id = await createUser(tx, { ...input, passwordHash, mustChange: input.mustChangePassword });
        await this.#log(tx, scope, client, {
          op: 'create_user', user: input.username, email: input.email, authSource: input.authSource, grants: input.grants,
          totpRequired: input.totpRequired, mustChangePassword: input.authSource === 'local' ? input.mustChangePassword : undefined,
        });
        return { id, oneTimePassword };
      } catch (err) {
        if (err.code === '23505') throw conflict('username_taken', `Username ${input.username} already exists.`, { username: input.username });
        if (err.code === '23503') throw badRequest('invalid_branch', 'The branch does not exist.');
        throw err;
      }
    });
  }

  /**
   * Updates name, active flag, roles and (optionally) how the user signs in.
   * Switching to 'local' returns { oneTimePassword }; switching to 'ldap' removes the stored password.
   */
  async updateUser(scope, id, raw, client = {}) {
    this.#check(scope);
    const input = parse(userUpdateInput, raw);
    const before = await getUser(this.pool, id);
    if (!before) throw notFound('User not found.');
    const switchTo = input.authSource && input.authSource !== before.auth_source ? input.authSource : null;
    if (switchTo && !usernameOk(switchTo, before.username)) {
      throw badRequest('invalid_username', `The username is not valid for ${switchTo} sign-in; create a new user instead.`, { authSource: switchTo });
    }
    const oneTimePassword = switchTo === 'local' ? await this.#oneTimePassword() : null;
    const passwordHash = oneTimePassword ? await hashPassword(oneTimePassword) : null;

    return withAllBranches(this.pool, async (tx) => {
      const staysAdmin = input.isActive && input.grants.some((g) => g.role === 'admin');
      if (id === scope.userId && !staysAdmin) {
        throw badRequest('self_lockout', 'You cannot remove your own admin role or disable your own account.');
      }
      if (!staysAdmin && (await countActiveAdmins(tx, id)) === 0) {
        throw badRequest('last_admin', 'At least one active admin must remain.');
      }
      await updateUser(tx, id, input);
      await replaceGrants(tx, id, input.grants);
      if (switchTo) await setAuthSource(tx, id, switchTo, passwordHash);
      const totpChanged = input.totpRequired !== undefined && input.totpRequired !== before.totp_required;
      if (totpChanged) await setTotpRequired(tx, id, input.totpRequired);
      // Switching to a local password always asks for a change (one-time password); otherwise the box decides.
      const sourceAfter = switchTo ?? before.auth_source;
      const mustChangeChanged = !switchTo && sourceAfter === 'local' && input.mustChangePassword !== undefined
        && input.mustChangePassword !== before.must_change_password;
      if (mustChangeChanged) await setMustChangePassword(tx, id, input.mustChangePassword);
      await this.#log(tx, scope, client, {
        op: 'update_user',
        user: before.username,
        email: before.email !== input.email ? { from: before.email, to: input.email } : undefined,
        isActive: input.isActive,
        authSource: switchTo ? { from: before.auth_source, to: switchTo } : undefined,
        totpRequired: totpChanged ? { from: before.totp_required, to: input.totpRequired } : undefined,
        mustChangePassword: mustChangeChanged ? { from: before.must_change_password, to: input.mustChangePassword } : undefined,
        grantsBefore: before.grants.map(({ role, branchId }) => ({ role, branchId })),
        grantsAfter: input.grants,
      });
      return oneTimePassword ? { oneTimePassword } : {};
    });
  }

  async resetPassword(scope, id, client = {}) {
    this.#check(scope);
    const oneTimePassword = await this.#oneTimePassword();
    const hash = await hashPassword(oneTimePassword);
    return withAllBranches(this.pool, async (tx) => {
      const u = await getUser(tx, id);
      if (!u) throw notFound('User not found.');
      if (u.auth_source !== 'local') {
        throw badRequest('directory_user', 'This user signs in with AD; the password is managed by AD.');
      }
      await setPassword(tx, id, hash, { mustChange: true });
      await this.#log(tx, scope, client, { op: 'reset_password', user: u.username });
      return { oneTimePassword };
    });
  }

  /**
   * Forgets the AD account (objectGUID) bound at first sign-in. The next sign-in with this
   * username binds again: use it when the person's AD account was deleted and recreated.
   */
  async unlinkAd(scope, id, client = {}) {
    this.#check(scope);
    return withAllBranches(this.pool, async (tx) => {
      const u = await getUser(tx, id);
      if (!u) throw notFound('User not found.');
      await unlinkAd(tx, id);
      await this.#log(tx, scope, client, { op: 'unlink_ad', user: u.username, objectGuid: u.ad_object_guid });
    });
  }

  /** Lost phone / new phone: forgets the authenticator app; the user sets it up again at the next sign-in. */
  async resetTwoFactor(scope, id, client = {}) {
    this.#check(scope);
    return withAllBranches(this.pool, async (tx) => {
      const u = await getUser(tx, id);
      if (!u) throw notFound('User not found.');
      await resetTotp(tx, id);
      await this.#log(tx, scope, client, { op: 'reset_two_factor', user: u.username });
    });
  }

  async unlockUser(scope, id, client = {}) {
    this.#check(scope);
    return withAllBranches(this.pool, async (tx) => {
      const u = await getUser(tx, id);
      if (!u) throw notFound('User not found.');
      await unlockUser(tx, id);
      await this.#log(tx, scope, client, { op: 'unlock_user', user: u.username });
    });
  }
}
