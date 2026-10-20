import { z } from 'zod';
import { withAllBranches } from '../../db/scoped.js';
import { can } from '../../domain/scope.js';
import { badRequest, forbidden, notFound, featureDisabled } from '../../http/errors.js';
import { parse } from '../../http/validate.js';
import {
  ackRun,
  countUnackedQuarantined,
  finishRun,
  getRun,
  getRunForUpdate,
  plannedNotInAd,
  runMetrics,
  runNewObjects,
  listHeartbeats,
  listOpenDuplicates,
  listRuns,
  markNotSeenAsDeleted,
  recomputeKeyStatuses,
  getOpenDuplicate,
  moveKey,
  reviewDuplicate,
  settleKeyDuplicates,
  peekSyncRequest,
  setSyncRequest,
} from './sync.repo.js';
import { syncRunFields } from '../audit/event-log.js';
import { runRef } from './run-ref.js';
import { mailKeyDuplicates, notInAdEvents } from './ingest.service.js';

const ackInput = z.object({ decision: z.enum(['accept', 'reject']) });
const duplicateInput = z.object({ action: z.enum(['assign', 'share']) });
const alertAckInput = z.object({ note: z.string().trim().max(300).optional() });
const alertSnoozeInput = alertAckInput.extend({ days: z.coerce.number().int().refine((d) => [1, 7, 30].includes(d)) });
const requestInput = z.object({ mode: z.enum(['delta', 'full']) });

/** Admin HQ side of sync: health overview, manual run request, quarantine decisions. */
export class SyncAdminService {
  constructor({ pool, audit, alerts, settings, logger = null, eventLog = null }) {
    this.eventLog = eventLog;
    this.pool = pool;
    this.audit = audit;
    this.alerts = alerts;
    this.settings = settings;
    this.log = logger ? logger.child({ component: 'sync' }) : null;
  }

  #check(scope) {
    if (!can(scope, 'admin')) throw forbidden();
  }

  async status(scope) {
    this.#check(scope);
    const [runs, heartbeats, openAlerts, requested, duplicates] = await Promise.all([
      listRuns(this.pool, 30),
      listHeartbeats(this.pool),
      this.alerts.listOpen(),
      peekSyncRequest(this.pool),
      withAllBranches(this.pool, (tx) => listOpenDuplicates(tx)),
    ]);
    const lastSuccess = runs.find((r) => r.status === 'success') ?? null;
    // Online: a heartbeat within the watchdog limit (Quan tri > Nguong canh bao), the same rule as the watchdog.
    const heartbeatMax = Number(await this.settings.get('watchdog.heartbeat_max_minutes', 15));
    const workers = heartbeats.map((hb) => {
      const minutesAgo = Math.floor((Date.now() - new Date(hb.at).getTime()) / 60_000);
      return { ...hb, minutesAgo, online: minutesAgo <= heartbeatMax };
    });
    const withRef = runs.map((r) => ({ ...r, run_ref: runRef(r.id, r.started_at) }));
    return { runs: withRef, heartbeats: workers, heartbeatMax, openAlerts, requested, lastSuccess, duplicates };
  }

  /**
   * Admin HQ decides a duplicate Key ID (Quan tri > Sync AD):
   *  - assign: compares the AD creation time of the two computers; the newer one is the current machine
   *    (unjoin + rejoin, reinstall) so the key moves to it, the old one keeps its history. Refused (pair stays open)
   *    when the passwords differ (the stored password belongs to the old machine), a creation time is unknown,
   *    or the key holder is already the newer one.
   *  - share: the key stays where it is; both computers show a note that the Key ID is shared. No permission change.
   */
  async reviewKeyDuplicate(scope, id, raw, client = {}) {
    this.#check(scope);
    const { action } = parse(duplicateInput, raw);
    return withAllBranches(this.pool, async (tx) => {
      const d = await getOpenDuplicate(tx, id);
      if (!d) throw notFound('Duplicate not found or already closed.');
      if (action === 'assign') {
        if (!d.same_password) throw badRequest('The two computers have different passwords for this Key ID: the key cannot be moved.');
        if (!d.owner_created || !d.other_created) throw badRequest('AD creation time of a computer is unknown: cannot tell which one is newer.');
        if (new Date(d.other_created) <= new Date(d.owner_created)) throw badRequest('The computer holding the key is already the newer one: nothing to move.');
        await moveKey(tx, { keyId: d.key_id, fromId: d.owner_id, toId: d.other_id, runId: null, reason: 'review_newer' });
      } else {
        await reviewDuplicate(tx, id, scope.upn, 'shared');
      }
      const result = action === 'assign' ? 'moved' : 'shared';
      await this.audit.append(tx, {
        ...this.audit.actor(scope, client),
        action: 'key_duplicate_review',
        computerId: String(result === 'moved' ? d.other_id : d.owner_id),
        detail: { keyId: d.key_id, duplicateId: Number(d.id), result, from: d.owner_name, to: d.other_name, samePassword: d.same_password },
      });
      return { id: Number(d.id), result, from: d.owner_name, to: d.other_name };
    });
  }

  /** "Handled" on an alert (Quan tri > Sync AD). A data alert goes quiet until it clears; others only record who looked. */
  async ackAlert(scope, id, raw, client = {}) {
    this.#check(scope);
    const { note } = parse(alertAckInput, raw);
    const a = await this.alerts.acknowledge(id, { by: scope.upn, note });
    if (!a) throw notFound('Alert not found or already closed.');
    await this.audit.log({ ...this.audit.actor(scope, client), action: 'alert_ack', detail: { alertId: Number(a.id), type: a.type, silences: a.silences, note: note ?? null } });
    return a;
  }

  /** "Skip for N days" on a data alert. */
  async snoozeAlert(scope, id, raw, client = {}) {
    this.#check(scope);
    const { days, note } = parse(alertSnoozeInput, raw);
    const a = await this.alerts.snooze(id, { by: scope.upn, days, note });
    if (!a) throw badRequest('Only alerts computed from data (not live sync errors) can be skipped.');
    await this.audit.log({ ...this.audit.actor(scope, client), action: 'alert_snooze', detail: { alertId: Number(a.id), type: a.type, days, note: note ?? null } });
    return a;
  }

  /** Queues a run; the worker picks it up on its next heartbeat (within ~5 minutes). */
  async requestSync(scope, raw, client = {}) {
    this.#check(scope);
    const { mode } = parse(requestInput, raw);
    if (!(await this.settings.feature('feature.manual_sync'))) throw featureDisabled();
    await setSyncRequest(this.pool, { mode, by: scope.upn, at: new Date().toISOString() });
    await this.audit.log({ ...this.audit.actor(scope, client), action: 'sync_manual', detail: { mode } });
    return { mode };
  }

  /**
   * What a run did and, for a quarantined run still waiting, what accepting it would change: the reasons
   * it was held, its figures against the database, the computers that would be flagged "Khong con trong pham vi giam sat"
   * (with their keys, never deleted), the USN that would be saved, and what the run already stored.
   */
  async runPreview(scope, runId) {
    this.#check(scope);
    return withAllBranches(this.pool, async (tx) => {
      const run = await getRun(tx, runId);
      if (!run) throw notFound('Sync run not found.');
      const waiting = run.status === 'quarantined' && !run.ack_decision;
      return {
        run: { ...run, run_ref: runRef(run.id, run.started_at) },
        waiting,
        metrics: await runMetrics(tx, runId),
        planned: waiting && run.pending?.markDeleted ? await plannedNotInAd(tx, runId) : { total: 0, byBranch: [], rows: [] },
        stored: await runNewObjects(tx, runId),
      };
    });
  }

  /**
   * Decision on a quarantined run. accept: the change was real (e.g. a batch of machines was
   * retired) -> apply what was held back and count the run as normal. reject: the cause was
   * fixed -> nothing is applied and the run never enters the baseline.
   */
  async ack(scope, runId, raw, client = {}) {
    this.#check(scope);
    const { decision } = parse(ackInput, raw);
    const result = await withAllBranches(this.pool, async (tx) => {
      const run = await getRunForUpdate(tx, runId);
      if (!run) throw notFound('Sync run not found.');
      if (run.status !== 'quarantined' || run.ack_decision) {
        throw badRequest('not_quarantined', 'This sync run is not waiting for a decision.');
      }
      let notInAd = [];
      if (decision === 'accept') {
        if (run.pending?.markDeleted) {
          notInAd = await markNotSeenAsDeleted(tx, runId);
          const settled = await settleKeyDuplicates(tx, runId);
          if (settled.moved.length) await recomputeKeyStatuses(tx, [...new Set(settled.moved.flatMap((m) => [m.from_id, m.to_id]))]);
        }
        await finishRun(tx, runId, {
          status: 'success',
          highestUsn: run.pending?.highestUsn ?? null,
          computersSeen: run.computers_seen,
          keysSeen: run.keys_seen,
          errors: run.errors,
          anomalies: run.anomalies,
          // duyet muon: giu gio ket thuc cua luot, khong coi la vua sync xong (healthz, watchdog)
          keepFinishedAt: true,
        });
        await ackRun(tx, runId, { by: scope.upn, decision, status: 'success' });
      } else {
        await ackRun(tx, runId, { by: scope.upn, decision, status: 'quarantined' });
      }
      await this.audit.append(tx, {
        ...this.audit.actor(scope, client),
        action: 'sync_ack',
        detail: { runId: Number(runId), decision, markedDeleted: notInAd.length },
      });
      return { decision, markedDeleted: notInAd.length, notInAd, remaining: await countUnackedQuarantined(tx) };
    });
    if (this.log) {
      for (const { msg, ...data } of notInAdEvents(Number(runId), result.notInAd)) this.log.info(data, msg);
      this.log.info({ runId: Number(runId), decision, by: scope.upn, markedNotInAd: result.markedDeleted }, 'quarantined sync run decided');
    }
    delete result.notInAd;
    try {
      const decided = await getRun(this.pool, runId);
      if (decided) this.eventLog?.emit('sync_run', { event: 'decided', decision, decided_by: scope.upn, marked_not_in_ad: result.markedDeleted, ...syncRunFields(decided) });
    } catch (err) {
      this.log?.warn({ err }, 'cannot write the sync decision to the event log');
    }
    if (result.remaining === 0) {
      await this.alerts.clear('sync_anomaly', { user: scope.upn });
    }
    if (decision === 'accept') await mailKeyDuplicates({ pool: this.pool, alerts: this.alerts, log: this.log });
    return result;
  }
}
