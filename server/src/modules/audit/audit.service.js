import { withScope } from '../../db/scoped.js';
import { branchesFor } from '../../domain/scope.js';
import { forbidden, featureDisabled } from '../../http/errors.js';
import { csvCell } from '../../http/csv.js';
import { appendLog, searchLog } from './audit.repo.js';

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
  'alert_ack',
  'alert_snooze',
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

import { PAGE_SIZES, pageSize } from '../settings/page-size.js';
const CSV_MAX_ROWS = 50_000;

export class AuditService {
  constructor({ pool, settings = null, eventLog = null, tz = process.env.APP_TZ ?? 'Asia/Ho_Chi_Minh' }) {
    this.tz = tz;
    this.pool = pool;
    this.settings = settings;
    this.eventLog = eventLog;
  }

  /**
   * Writes inside the caller's transaction (so the row commits or rolls back with the action). Once it is
   * committed the row also goes to the event log (stdout), in the background.
   */
  async append(tx, entry) {
    const row = { ...EMPTY, ...entry };
    const written = await appendLog(tx, row);
    if (this.eventLog?.enabled) {
      if (tx.afterCommit) tx.afterCommit(() => this.#emit(written, row));
      else this.#emit(written, row);
    }
  }

  /** One event line for a row of the Nhat ky: the fields the screen shows (branch code and computer name looked up). */
  async #emit({ id, at }, e) {
    try {
      let branchCode = null;
      let computerName = null;
      if (e.branchId !== null || e.computerId !== null) {
        const { rows } = await withScope(this.pool, 'all', (tx) => tx.query(
          'SELECT (SELECT code FROM branch WHERE id = $1) AS branch_code, (SELECT name FROM computer WHERE id = $2) AS computer_name',
          [e.branchId, e.computerId],
        ));
        branchCode = rows[0].branch_code;
        computerName = rows[0].computer_name;
      }
      this.eventLog.emit('audit', {
        time: at,
        id,
        user_sid: e.userSid,
        user_upn: e.userUpn,
        action: e.action,
        computer_id: e.computerId === null ? null : Number(e.computerId),
        computer_name: computerName,
        key_id: e.keyId,
        branch_id: e.branchId,
        branch_code: branchCode,
        reason: e.reason,
        reason_note: e.reasonNote,
        ticket_no: e.ticketNo,
        client_ip: e.clientIp,
        user_agent: e.userAgent,
        detail: e.detail,
      });
    } catch {
      // never let the event line get in the way of the action
    }
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
    const limit = await pageSize(this.settings, PAGE_SIZES.audit);
    const offset = (pageNo - 1) * limit;
    const result = await withScope(this.pool, branches, (tx) => searchLog(tx, branches, filters, { limit, offset, tz: this.tz }));
    return { ...result, page: pageNo, pageSize: limit, pages: Math.max(1, Math.ceil(result.total / limit)) };
  }

  /** CSV of the log (never contains a key). The export itself is logged. */
  async exportCsv(scope, filters, client) {
    const branches = branchesFor(scope, 'logs');
    if (branches !== 'all' && branches.length === 0) throw forbidden();
    if (this.settings && !(await this.settings.feature('feature.audit_export'))) throw featureDisabled();
    const { rows } = await withScope(this.pool, branches, async (tx) => {
      const r = await searchLog(tx, branches, filters, { limit: CSV_MAX_ROWS, offset: 0, tz: this.tz });
      const day = (d) => (d ? d.toISOString().slice(0, 10) : d);
      await this.append(tx, { ...this.actor(scope, client), action: 'export_log', detail: { filters: { ...filters, from: day(filters.from), to: day(filters.to) }, rows: r.rows.length } });
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
