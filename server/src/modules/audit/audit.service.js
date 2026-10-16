import { withScope } from '../../db/scoped.js';
import { branchesFor } from '../../domain/scope.js';
import { forbidden, featureDisabled } from '../../http/errors.js';
import { csvCell } from '../../http/csv.js';
import { appendLog, readChainPage, rowToEntry, searchLog } from './audit.repo.js';
import { GENESIS_HASH, verifyChain } from './chain.js';

export const AUDIT_ACTIONS = [
  'login',
  'login_failed',
  'password_change',
  'search',
  'view_computer',
  'reveal',
  'export_log',
  'export_computers',
  'export_keys',
  'export_report',
  'log_purge',
  'computer_edit',
  'admin_change',
  'computer_moved',
  'sync_manual',
  'sync_ack',
  'key_duplicate_review',
  'backup_run',
  'backup_download',
];

const EMPTY = {
  computerId: null,
  keyId: null,
  branchId: null,
  reason: null,
  reasonNote: null,
  ticketNo: null,
  clientIp: null,
  userAgent: null,
  detail: null,
};

export const PAGE_SIZE = 50;
const CSV_MAX_ROWS = 50_000;

export class AuditService {
  constructor({ pool, hmacKey, settings = null }) {
    this.pool = pool;
    this.hmacKey = hmacKey;
    this.settings = settings;
  }

  /** Writes inside the caller's transaction (so the row commits or rolls back with the action). */
  append(tx, entry) {
    return appendLog(tx, this.hmacKey, { ...EMPTY, ...entry });
  }

  /** Writes one row in its own transaction. */
  log(entry) {
    return withScope(this.pool, [], (tx) => this.append(tx, entry));
  }

  /** Who did it, from the signed-in scope, plus client info. */
  actor(scope, client = {}) {
    return { userSid: scope.userSid, userUpn: scope.upn, ...client };
  }

  async search(scope, filters, pageNo = 1) {
    const branches = branchesFor(scope, 'logs');
    if (branches !== 'all' && branches.length === 0) throw forbidden();
    const limit = PAGE_SIZE;
    const offset = (pageNo - 1) * limit;
    const result = await withScope(this.pool, branches, (tx) => searchLog(tx, branches, filters, { limit, offset }));
    return { ...result, page: pageNo, pageSize: limit, pages: Math.max(1, Math.ceil(result.total / limit)) };
  }

  /** CSV of the log (never contains a key). The export itself is logged. */
  async exportCsv(scope, filters, client) {
    const branches = branchesFor(scope, 'logs');
    if (branches !== 'all' && branches.length === 0) throw forbidden();
    if (this.settings && !(await this.settings.feature('feature.audit_export'))) throw featureDisabled();
    const { rows } = await withScope(this.pool, branches, async (tx) => {
      const r = await searchLog(tx, branches, filters, { limit: CSV_MAX_ROWS, offset: 0 });
      await this.append(tx, { ...this.actor(scope, client), action: 'export_log', detail: { filters, rows: r.rows.length } });
      return r;
    });
    const header = ['time_utc', 'user', 'action', 'branch', 'computer', 'key_id', 'reason', 'note', 'ticket', 'client_ip'];
    const lines = rows.map((r) =>
      [r.at.toISOString(), r.user_upn, r.action, r.branch_code, r.computer_name, r.key_id, r.reason, r.reason_note, r.ticket_no, r.client_ip]
        .map(csvCell)
        .join(','),
    );
    return [header.join(','), ...lines].join('\r\n') + '\r\n';
  }

  /** Branches the reader may filter the log by. */
  branchOptions(scope) {
    return logBranchOptions(this.pool, scope);
  }

  /**
   * Verifies the whole hash chain. Returns { ok, checked, brokenAtId?, problem? }.
   * After a retention purge the chain starts at the last checkpoint (access_log_purge): the first
   * remaining row must point to the hash of the last deleted one.
   */
  async verify() {
    return withScope(this.pool, 'all', async (tx) => {
      const cp = (await tx.query('SELECT up_to_id, last_hash FROM access_log_purge ORDER BY id DESC LIMIT 1')).rows[0];
      let prev = cp?.last_hash ?? GENESIS_HASH;
      let afterId = cp ? Number(cp.up_to_id) : 0;
      let checked = 0;
      for (;;) {
        const rows = await readChainPage(tx, afterId, 5000);
        if (rows.length === 0) return { ok: true, checked };
        const r = verifyChain(this.hmacKey, rows.map(rowToEntry), prev);
        if (!r.ok) return { ...r, checked: checked + r.checked };
        checked += r.checked;
        prev = r.lastHash;
        afterId = rows.at(-1).id;
      }
    });
  }
}


/** Branches a reader may filter the log by: [{ id, code, name }]. */
export async function logBranchOptions(pool, scope) {
  const set = branchesFor(scope, 'logs');
  const { rows } = await pool.query(
    `SELECT id, code, name FROM branch WHERE ($1::int[] IS NULL OR id = ANY($1::int[])) ORDER BY code`,
    [set === 'all' ? null : set],
  );
  return rows;
}
