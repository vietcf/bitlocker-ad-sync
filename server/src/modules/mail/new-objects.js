import { withAllBranches } from '../../db/scoped.js';
import { runRef } from '../sync/run-ref.js';
import { adminEmails, branchStaff, grantsWithoutEmail } from './mail.repo.js';

export const NEW_OBJECTS_DEFAULTS = {
  computers: false, // mail when a sync finds computers not seen before
  keys: false, // mail when a sync finds keys not seen before
  branchUsers: true, // to IT / lead users of the computer's branch
  admins: true, // to every Admin HQ user
  skipFirstFull: true, // the first full sync finds everything: send nothing for it
  maxItems: 100, // lines per section in one mail
};

/**
 * After a sync run: one mail per recipient listing the computers and keys this run stored for
 * the first time, limited to what that recipient may see. Never contains a recovery password.
 */
export class NewObjectsNotifier {
  constructor({ pool, settings, mail, templates }) {
    this.pool = pool;
    this.settings = settings;
    this.mail = mail;
    this.templates = templates;
  }

  async options() {
    return { ...NEW_OBJECTS_DEFAULTS, ...(await this.settings.get('notify.new_objects', {})) };
  }

  /**
   * Returns the number of mails queued. People who see the same new computers / keys share one mail;
   * each mail records who it was sent to and who should have got it but has no e-mail address
   * (missing_recipients). A mail with nobody to send it to is kept as 'no_recipient', with the reason.
   */
  async afterRun(run) {
    const o = await this.options();
    if (!o.computers && !o.keys) return 0;
    if (!o.branchUsers && !o.admins) return 0;
    const appUrl = ((await this.settings.get('mail.smtp', {})).appUrl ?? '').replace(/\/+$/, '');

    return withAllBranches(this.pool, async (tx) => {
      if (o.skipFirstFull && run.mode === 'full') {
        const { rows } = await tx.query(
          `SELECT EXISTS (SELECT 1 FROM sync_run WHERE mode = 'full' AND id < $1 AND status IN ('success', 'quarantined')) AS seen`,
          [run.id],
        );
        if (!rows[0].seen) return 0;
      }
      const computers = o.computers
        ? (await tx.query(
            `SELECT c.id, c.name, c.distinguished_name, c.branch_id, b.code AS branch_code
               FROM computer c LEFT JOIN branch b ON b.id = c.branch_id
              WHERE c.first_seen_run = $1 ORDER BY lower(c.name)`,
            [run.id],
          )).rows
        : [];
      const keys = o.keys
        ? (await tx.query(
            `SELECT c.id, c.name, c.branch_id, b.code AS branch_code, k.key_id, k.key_id_prefix, k.ad_created_at
               FROM recovery_key k JOIN computer c ON c.id = k.computer_id LEFT JOIN branch b ON b.id = c.branch_id
              WHERE k.first_seen_run = $1 ORDER BY lower(c.name), k.ad_created_at`,
            [run.id],
          )).rows
        : [];
      if (!computers.length && !keys.length) return 0;

      // Everyone who should be told: Admin HQ users (all branches) and IT / lead users (their
      // branches), with or without an e-mail address. scope = 'all' or a Set of branch ids.
      const people = new Map(); // key -> { email | null, username | null, scope }
      const widen = (key, init, branchId) => {
        const p = people.get(key) ?? { ...init, scope: new Set() };
        if (p.scope !== 'all') p.scope = branchId === null ? 'all' : p.scope.add(branchId);
        people.set(key, p);
      };
      if (o.admins) for (const e of await adminEmails(tx)) widen(`e:${e}`, { email: e, username: null }, null);
      if (o.branchUsers) for (const s of await branchStaff(tx)) widen(`e:${s.email}`, { email: s.email, username: null }, s.branch_id);
      const roles = [...(o.admins ? ['admin'] : []), ...(o.branchUsers ? ['it', 'lead'] : [])];
      for (const g of await grantsWithoutEmail(tx, roles)) {
        widen(`u:${g.username}`, { email: null, username: g.username }, g.role === 'admin' ? null : g.branch_id);
      }

      // One mail per distinct content: people who see the same computers and keys share it. Each
      // mail records who it went to and who should have got it but has no e-mail address.
      const seesIn = (scope) => (x) => scope === 'all' || (x.branch_id !== null && scope.has(x.branch_id));
      const groups = new Map();
      for (const p of people.values()) {
        const sees = seesIn(p.scope);
        const myComputers = computers.filter(sees);
        const myKeys = keys.filter(sees);
        if (!myComputers.length && !myKeys.length) continue;
        const id = [...myComputers.map((c) => `c${c.id}`), ...myKeys.map((k) => `k${k.id}:${k.key_id_prefix}`)].join(',');
        const g = groups.get(id) ?? { to: [], missing: [], computers: myComputers, keys: myKeys };
        if (p.email) g.to.push(p.email);
        else g.missing.push(p.username);
        groups.set(id, g);
      }

      if (!groups.size) {
        // Nobody covers these computers (e.g. computers in no branch while Admin HQ is not notified).
        const who = [o.admins && 'Admin HQ', o.branchUsers && 'IT / lead of the branch'].filter(Boolean).join(' or ');
        await this.mail.enqueue({
          kind: 'new_objects', to: [],
          reason: `No recipient: no ${who} user covers these computers.`,
          ...compose(this.templates, run, computers, keys, o.maxItems, appUrl),
        }, tx);
        return 0;
      }
      let queued = 0;
      for (const g of groups.values()) {
        const res = await this.mail.enqueue({
          kind: 'new_objects', to: g.to, missing: g.missing,
          reason: `Not sent: no e-mail address for ${g.missing.join(', ')} (Quan tri > Nguoi dung).`,
          ...compose(this.templates, run, g.computers, g.keys, o.maxItems, appUrl),
        }, tx);
        if (res?.queued) queued++;
      }
      return queued;
    });
  }
}

const branchLabel = (code) => code ?? 'N/A';

/** One mail (people who see the same computers / keys): template new_objects and its parts (templates/mail-templates.yaml). */
function compose(templates, run, computers, keys, maxItems, appUrl) {
  const part = (piece, vars) => templates.part('new_objects', piece, vars);
  const parts = [];
  if (computers.length) parts.push(part('summary_computers', { count: computers.length }));
  if (keys.length) parts.push(part('summary_keys', { count: keys.length }));
  const link = (c) => (appUrl ? part('link', { url: `${appUrl}/computers/${c.id}` }) : '');
  const section = (title, rows, line) => {
    if (!rows.length) return '';
    const lines = rows.slice(0, maxItems).map(line);
    if (rows.length > maxItems) lines.push(part('more_line', { more: rows.length - maxItems }));
    return `${part(title)}\n${lines.join('\n')}\n\n`;
  };
  return templates.render('new_objects', {
    runId: run.id,
    runRef: runRef(run.id, run.started_at),
    mode: run.mode,
    dc: run.dc_name,
    summary: parts.join(part('summary_join')),
    computerCount: computers.length,
    keyCount: keys.length,
    computers: section('computers_title', computers, (c) =>
      part('computer_line', { name: c.name, branch: branchLabel(c.branch_code), link: link(c) })),
    keys: section('keys_title', keys, (k) =>
      part('key_line', { name: k.name, branch: branchLabel(k.branch_code), keyId: k.key_id.toUpperCase(), keyIdPrefix: k.key_id_prefix, link: link(k) })),
  });
}
