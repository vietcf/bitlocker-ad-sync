import QRCode from 'qrcode';
import { AppError, badRequest } from '../../http/errors.js';
import { decryptSecret, encryptSecret } from '../mail/secret.js';
import { generateSecret, otpauthUri, verifyCode } from './totp.js';
import { loadLockoutPolicy } from './lockout.js';
import { burnPasswordCheck, checkPasswordPolicy, hashPassword, loadPasswordPolicy, verifyPassword } from './password.js';
import { DirectoryError } from './ldap.client.js';
import {
  bindAdGuid,
  fillEmailIfEmpty,
  findForLogin,
  findForLoginById,
  getPasswordHash,
  getTotp,
  loadPrincipal,
  recordFailure,
  recordSuccess,
  setPassword,
  setPendingTotpSecret,
  useTotpStep,
  userSid,
} from './users.repo.js';

const WRONG_CODE = () => new AppError(401, 'invalid_totp', 'Wrong or expired code. Type the 6-digit code shown in the authenticator app now.');
/** Name shown in the authenticator app. */
export const TOTP_ISSUER = 'BitLocker Keys';

const INVALID = () => new AppError(401, 'invalid_credentials', 'Wrong username or password.');
/** The locked-account error: details.minutes is 0 when only Admin HQ can unlock it. */
const LOCKED = (policy) => new AppError(423, 'account_locked',
  policy.lockMinutes === 0
    ? 'The account is locked after too many failed attempts. Ask Admin HQ to unlock it.'
    : `The account is temporarily locked after too many failed attempts. Try again in ${policy.lockMinutes} minutes.`,
  { minutes: policy.lockMinutes });

export const PASSWORD_POLICY_MESSAGES = {
  too_short: 'The new password is too short (see the minimum length).',
  missing_upper: 'The new password must contain an upper-case letter.',
  missing_lower: 'The new password must contain a lower-case letter.',
  missing_digit: 'The new password must contain a digit.',
  missing_special: 'The new password must contain a character that is not a letter or a digit.',
  too_long: 'The new password is too long.',
  contains_username: 'The new password must not contain the username.',
  same_as_current: 'The new password must differ from the current one.',
};

/**
 * Accepts what people type for an AD account: "nguyenvana", "CORP\nguyenvana" or
 * "nguyenvana@corp.local" (when the suffix is the configured AD domain) -> "nguyenvana".
 */
export function normalizeUsername(input, domain) {
  let u = input.trim();
  const slash = u.lastIndexOf('\\');
  if (slash >= 0) u = u.slice(slash + 1);
  const at = u.lastIndexOf('@');
  if (at > 0 && domain && u.slice(at + 1).toLowerCase() === domain.toLowerCase()) u = u.slice(0, at);
  return u;
}

/**
 * Sign-in and the per-request user scope. One form, one user table, two ways to check a password:
 *  - ldap:  the AD password, checked by binding to AD over LDAPS (nothing stored here);
 *  - local: a password hash stored here (e.g. the break-glass admin when AD is unreachable).
 * Only users an admin created here can sign in. Roles always come from this app (user_grant).
 */
export class AuthService {
  /** ldap: LdapAuthenticator or null; options: { domain, localLoginEnabled } */
  constructor({ pool, audit, ldap = null, options = {}, secretKey = null, settings = null }) {
    this.settings = settings;
    this.secretKey = secretKey;
    this.pool = pool;
    this.audit = audit;
    this.ldap = ldap;
    this.options = { domain: null, localLoginEnabled: true, ...options };
  }

  /** Password rules for local accounts now in force. */
  passwordPolicy() {
    return loadPasswordPolicy(this.settings);
  }

  get ldapEnabled() {
    return !!this.ldap;
  }

  /**
   * Returns { id, username, displayName, mustChangePassword, secondFactor }.
   * secondFactor null: signed in. 'code' / 'setup': the password is right but two-step sign-in is on;
   * the sign-in completes with completeSecondFactor() (after a first setup for 'setup').
   * Unknown users and wrong passwords fail with the same message.
   */
  async login(rawUsername, password, client) {
    const lock = await loadLockoutPolicy(this.settings);
    const username = normalizeUsername(rawUsername, this.options.domain);
    const user = await findForLogin(this.pool, username);
    const method = user?.auth_source ?? 'unknown';
    const fail = async (reason, error = INVALID()) => {
      await this.audit.log({
        userSid: user ? userSid(user.id) : 'unknown',
        userUpn: username.slice(0, 256),
        action: 'login_failed',
        detail: { reason, method },
        ...client,
      });
      throw error;
    };

    if (!user) {
      await burnPasswordCheck(password);
      return fail('unknown_user');
    }

    if (user.auth_source === 'local') {
      if (!this.options.localLoginEnabled) {
        await burnPasswordCheck(password);
        return fail('local_login_disabled');
      }
      if (!(await verifyPassword(password, user.password_hash))) {
        if (!user.is_active || user.is_locked) return fail(user.is_locked ? 'locked' : 'disabled');
        return fail((await recordFailure(this.pool, user.id, lock)) ? 'wrong_password_locked' : 'wrong_password');
      }
    } else {
      if (!this.ldap) {
        return fail('ldap_not_configured', new AppError(503, 'directory_not_configured', 'AD sign-in is not configured.'));
      }
      let account;
      try {
        account = await this.ldap.authenticate(user.username, password);
      } catch (err) {
        if (err instanceof DirectoryError && err.code === 'unavailable') {
          return fail('directory_unavailable', new AppError(503, 'directory_unavailable',
            'Cannot reach the AD server. Try again later.'));
        }
        if (!user.is_active || user.is_locked) return fail(user.is_locked ? 'locked' : 'disabled');
        return fail((await recordFailure(this.pool, user.id, lock)) ? 'wrong_password_locked' : 'wrong_password');
      }
      // Same name, different AD account (deleted and recreated, maybe for someone else).
      if (user.ad_object_guid && user.ad_object_guid !== account.objectGuid) {
        return fail('ad_account_mismatch', new AppError(403, 'ad_account_mismatch',
          'This AD account does not match the account registered in the system.'));
      }
      if (user.is_active && !user.is_locked && !user.ad_object_guid) await bindAdGuid(this.pool, user.id, account.objectGuid);
      if (account.mail) await fillEmailIfEmpty(this.pool, user.id, account.mail);
    }

    // Correct password: only now say why it still cannot sign in.
    if (!user.is_active) return fail('disabled');
    if (user.is_locked) return fail('locked', LOCKED(lock));

    const signedIn = {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      mustChangePassword: user.auth_source === 'local' && user.must_change_password,
    };
    // Two-step sign-in: not signed in yet; the code (or the first setup) comes next.
    if (user.totp_required) return { ...signedIn, method, secondFactor: user.totp_enrolled_at ? 'code' : 'setup' };

    await recordSuccess(this.pool, user.id);
    await this.audit.log({ userSid: userSid(user.id), userUpn: user.username, action: 'login', detail: { method }, ...client });
    return { ...signedIn, secondFactor: null };
  }

  /**
   * First setup of the authenticator app: a secret kept (encrypted) until the first code confirms it.
   * The same secret is shown again on reload. Returns { secret, uri, qrSvg }.
   */
  async beginTotpSetup(userId) {
    const user = await findForLoginById(this.pool, userId);
    const t = await getTotp(this.pool, userId);
    if (!user || !t?.totp_required) throw badRequest('totp_not_required', 'Two-step sign-in is not turned on for this user.');
    if (t.totp_enrolled_at) throw badRequest('totp_already_set_up', 'The authenticator app is already set up.');
    let secret = t.totp_secret ? decryptSecret(this.secretKey, t.totp_secret) : null;
    if (!secret) {
      secret = generateSecret();
      await setPendingTotpSecret(this.pool, userId, encryptSecret(this.secretKey, secret));
    }
    const uri = otpauthUri({ issuer: TOTP_ISSUER, account: user.username, secret });
    const qrSvg = await QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 200 });
    return { secret, uri, qrSvg };
  }

  /**
   * Second step: checks the 6-digit code (or confirms the setup with a first code). A wrong code counts
   * as a failed sign-in (locks after MAX_FAILED_ATTEMPTS). Returns the signed-in user, as login() does.
   */
  async completeSecondFactor(userId, code, client, method = 'password') {
    const lock = await loadLockoutPolicy(this.settings);
    const user = await findForLoginById(this.pool, userId);
    const t = await getTotp(this.pool, userId);
    const fail = async (reason, error = WRONG_CODE()) => {
      await this.audit.log({
        userSid: userSid(userId),
        userUpn: (user?.username ?? 'unknown').slice(0, 256),
        action: 'login_failed',
        detail: { reason, method, twoFactor: true },
        ...client,
      });
      throw error;
    };
    if (!user || !t?.totp_required || !t.totp_secret) return fail('totp_not_set_up', badRequest('totp_not_set_up', 'Sign in again.'));
    if (!user.is_active) return fail('disabled');
    if (user.is_locked) return fail('locked', LOCKED(lock));
    const enroll = !t.totp_enrolled_at;
    const step = verifyCode(decryptSecret(this.secretKey, t.totp_secret), code, { lastStep: t.totp_last_step === null ? null : Number(t.totp_last_step) });
    if (step === null || !(await useTotpStep(this.pool, userId, step, { enroll }))) {
      const locked = await recordFailure(this.pool, userId, lock);
      return fail(locked ? 'wrong_totp_locked' : 'wrong_totp', locked ? LOCKED(lock) : WRONG_CODE());
    }
    await recordSuccess(this.pool, user.id);
    await this.audit.log({
      userSid: userSid(user.id),
      userUpn: user.username,
      action: 'login',
      detail: { method, twoFactor: enroll ? 'totp_enrolled' : 'totp' },
      ...client,
    });
    return {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      mustChangePassword: user.auth_source === 'local' && user.must_change_password,
      secondFactor: null,
    };
  }

  /** The scope for one request, or null if the user is gone or disabled. */
  async loadScope(userId, authMethod = 'local') {
    const p = await loadPrincipal(this.pool, userId);
    if (!p) return null;
    return {
      userId: p.id,
      userSid: userSid(p.id),
      upn: p.username,
      displayName: p.display_name,
      email: p.email,
      grants: p.grants,
      authSource: p.auth_source,
      // Only local accounts have a password here, so only they can be forced to change it.
      mustChangePassword: p.auth_source === 'local' && p.must_change_password,
      authMethod,
    };
  }

  async changePassword(scope, currentPassword, newPassword, client) {
    if (scope.authSource !== 'local') {
      throw badRequest('directory_user', 'AD accounts change their password in Windows/AD, not here.');
    }
    if (!(await verifyPassword(currentPassword, await getPasswordHash(this.pool, scope.userId)))) {
      throw badRequest('wrong_current_password', 'The current password is wrong.');
    }
    const policy = await loadPasswordPolicy(this.settings);
    const problem = checkPasswordPolicy(newPassword, { username: scope.upn, current: currentPassword, policy });
    if (problem) throw badRequest('weak_password', PASSWORD_POLICY_MESSAGES[problem], { reason: problem, minLength: policy.minLength });
    await setPassword(this.pool, scope.userId, await hashPassword(newPassword), { mustChange: false });
    await this.audit.log({ ...this.audit.actor(scope, client), action: 'password_change' });
  }
}
