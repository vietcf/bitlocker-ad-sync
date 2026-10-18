import { withAllBranches, withScope } from '../../db/scoped.js';
import { branchesFor, can } from '../../domain/scope.js';
import { forbidden } from '../../http/errors.js';
import { lastSuccessfulRun, listHeartbeats } from '../sync/sync.repo.js';
import { inventoryByBranch, inventoryPerDay, revealsByBranch, revealsPerDay, topRevealers } from './dashboard.repo.js';

export const TREND_DAYS = 14;
export const INVENTORY_DAYS = 30;

/**
 * Quick statistics, always within the viewer's own scope:
 *  - inventory (computers, key coverage, computers and keys per day): anyone with keys or reports;
 *  - reveal activity (from the audit log): only roles that may read reports;
 *  - sync health: Admin HQ only.
 */
export class DashboardService {
  constructor({ pool, alerts, settings = null, tz = 'Asia/Ho_Chi_Minh' }) {
    this.pool = pool;
    this.alerts = alerts;
    this.settings = settings;
    this.tz = tz;
  }

  /**
   * How fresh the data is, for everyone who sees Tong quan: when the last successful sync finished
   * and whether that is older than the watchdog threshold (keys created since may be missing).
   */
  async #freshness() {
    const last = await withAllBranches(this.pool, (tx) => lastSuccessfulRun(tx));
    const maxMinutes = Number((await this.settings?.get('watchdog.delta_max_minutes', 60)) ?? 60);
    const at = last?.finished_at ?? null;
    const ageMinutes = at ? Math.floor((Date.now() - new Date(at).getTime()) / 60_000) : null;
    return { lastSyncAt: at, ageMinutes, maxMinutes, stale: at === null || ageMinutes > maxMinutes };
  }

  async get(scope) {
    const canReports = can(scope, 'reports');
    if (!canReports && !can(scope, 'keys')) throw forbidden();
    const branches = branchesFor(scope, canReports ? 'reports' : 'keys');

    const result = await withScope(this.pool, branches, async (tx) => {
      const inventory = await inventoryByBranch(tx, branches);
      const trend = await inventoryPerDay(tx, branches, INVENTORY_DAYS, this.tz);
      if (!canReports) return { inventory, trend, activity: null };
      const [daily, byBranch, top] = [
        await revealsPerDay(tx, branches, TREND_DAYS, this.tz),
        await revealsByBranch(tx, branches, 30),
        await topRevealers(tx, branches, 7, 5),
      ];
      return { inventory, trend, activity: { daily, byBranch, top } };
    });

    // Merge the 30-day reveal count into the branch rows.
    const reveals30 = new Map((result.activity?.byBranch ?? []).map((r) => [r.branch_id, r.reveals]));
    const rows = result.inventory.map((r) => ({ ...r, reveals_30d: result.activity ? reveals30.get(r.branch_id) ?? 0 : null }));
    const sum = (k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
    const computers = sum('computers');
    const noKey = sum('no_key');
    const keys = sum('keys');

    let activity = null;
    if (result.activity) {
      const daily = result.activity.daily;
      const last7 = daily.slice(-7);
      activity = {
        daily,
        today: daily.at(-1)?.reveals ?? 0,
        reveals7d: last7.reduce((s, d) => s + d.reveals, 0),
        top: result.activity.top,
      };
    }

    let sync = null;
    if (can(scope, 'admin')) {
      const [last, heartbeats, openAlerts] = await Promise.all([
        withAllBranches(this.pool, (tx) => lastSuccessfulRun(tx)),
        withAllBranches(this.pool, (tx) => listHeartbeats(tx)),
        this.alerts.listOpen(),
      ]);
      // worker_offline and sync_problem are the watchdog's summaries of the other alerts: two statuses
      // (the worker, and AD / the sync), not more alerts.
      const SUMMARY = ['worker_offline', 'sync_problem', 'sync_offline'];
      const offline = openAlerts.find((a) => a.type === 'worker_offline') ?? null;
      const problem = openAlerts.find((a) => a.type === 'sync_problem') ?? null;
      const others = openAlerts.filter((a) => !SUMMARY.includes(a.type));
      sync = {
        lastSuccessAt: last?.finished_at ?? null,
        lastHeartbeatAt: heartbeats[0]?.at ?? null,
        workerOfflineSince: offline?.opened_at ?? null,
        problemSince: problem?.opened_at ?? null,
        openAlerts: others.length,
        highAlerts: others.filter((a) => a.severity === 'high').length,
      };
    }

    return {
      freshness: await this.#freshness(),
      totals: {
        computers,
        withKey: computers - noKey,
        noKey,
        keys,
        coveragePct: computers ? Math.round(((computers - noKey) / computers) * 1000) / 10 : null,
      },
      branches: rows,
      inventoryDaily: result.trend,
      activity,
      sync,
    };
  }
}
