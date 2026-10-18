// Data retention (Quan tri > Luu tru). The data-retention job runs it nightly; Admin HQ can also
// run it now. What it deletes:
//   - mail_outbox: sent / failed mails older than mail.retention_days (pending mail is kept);
//   - sync history: finished runs, their metrics and resolved alerts older than retention.sync_days
//     (the last successful run and the last successful full run are always kept: delta sync and
//     the anomaly baseline need them);
//   - access_log: only when retention.access_log_days is set (>= 1 day, any value the admin chooses; default: keep forever),
//     through purge_access_log(), which keeps the hash chain verifiable. The purge is itself logged.

export const RETENTION_DEFAULTS = { mailDays: 90, syncDays: 180, accessLogDays: null };
export const RETENTION_LIMITS = { mailDays: [1, 3650], syncDays: [30, 3650], accessLogDays: [1, 36500] };

export class RetentionService {
  constructor({ pool, settings, mail, audit }) {
    this.pool = pool;
    this.settings = settings;
    this.mail = mail;
    this.audit = audit;
  }

  async values() {
    return {
      mailDays: Number(await this.settings.get('mail.retention_days', RETENTION_DEFAULTS.mailDays)),
      syncDays: Number(await this.settings.get('retention.sync_days', RETENTION_DEFAULTS.syncDays)),
      accessLogDays: (await this.settings.get('retention.access_log_days', null)) ?? null,
    };
  }

  /** Runs every purge. `by` is recorded with an access-log purge. Returns the counts. */
  async run(by = 'system') {
    const v = await this.values();
    const mail = (await this.mail.purge()).deleted;
    const sync = await this.#purgeSync(v.syncDays);
    const accessLog = v.accessLogDays ? await this.#purgeAccessLog(v.accessLogDays, by) : 0;
    return { mail, ...sync, accessLog };
  }

  async #purgeSync(days) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT r.id FROM sync_run r
          WHERE r.status <> 'running' AND coalesce(r.finished_at, r.started_at) < now() - make_interval(days => $1)
            AND r.id NOT IN (
              SELECT coalesce(max(id) FILTER (WHERE status = 'success'), 0) FROM sync_run
              UNION ALL
              SELECT coalesce(max(id) FILTER (WHERE status = 'success' AND mode = 'full'), 0) FROM sync_run)`,
        [days],
      );
      const ids = rows.map((r) => r.id);
      let runs = 0;
      if (ids.length) {
        await client.query('DELETE FROM sync_metric WHERE run_id = ANY($1::bigint[])', [ids]);
        runs = (await client.query('DELETE FROM sync_run WHERE id = ANY($1::bigint[])', [ids])).rowCount;
      }
      const alerts = (await client.query(
        'DELETE FROM sync_alert WHERE resolved_at IS NOT NULL AND resolved_at < now() - make_interval(days => $1)',
        [days],
      )).rowCount;
      await client.query('COMMIT');
      return { syncRuns: runs, alerts };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async #purgeAccessLog(days, by) {
    const { rows } = await this.pool.query('SELECT deleted, up_to_id FROM purge_access_log($1, $2)', [days, by]);
    const deleted = Number(rows[0].deleted);
    if (deleted) {
      await this.audit.log({
        userSid: 'system',
        userUpn: by,
        action: 'log_purge',
        detail: { deleted, upToId: Number(rows[0].up_to_id), retentionDays: days },
      });
    }
    return deleted;
  }
}
