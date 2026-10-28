import { z } from 'zod';
import { withAllBranches } from '../../db/scoped.js';
import { translate } from '../../i18n/index.js';
import { conflict, notFound } from '../../http/errors.js';
import { parse } from '../../http/validate.js';
import { branchForDn, parentDn } from '../branchmap/branchmap.js';
import { syncRunFields } from '../audit/event-log.js';
import { runRef } from './run-ref.js';
import { anomalyText, checkRun, loadThresholds } from './anomaly.js';
import {
  branchBaseline,
  bumpRunCounters,
  collectMetrics,
  countNotSeenSince,
  findComputerByGuid,
  findComputerByDn,
  findKeyOwner,
  finishRun,
  getRun,
  getRunForUpdate,
  insertComputer,
  insertMetric,
  insertRun,
  lastSuccessfulRun,
  loadBranchOus,
  markComputerReplaced,
  markNotSeenAsDeleted,
  moveKey,
  recomputeKeyStatuses,
  recordKeyDuplicate,
  setKeyDn,
  settleKeyDuplicates,
  takeUnnotifiedDuplicates,
  upsertKey,
  takeSyncRequest,
  updateComputer,
  upsertHeartbeat,
  touchRun,
  abortOrphanRuns,
} from './sync.repo.js';

export const MAX_BATCH = 500;
/** Worker im lang qua lau trong luot sync = da crash: giai phong luot de luot moi chay duoc. */
export const ORPHAN_RUN_MINUTES = 30;
const RECOVERY_PASSWORD = /^\d{6}(-\d{6}){7}$/;

/**
 * Mails the duplicate Key IDs not mailed yet (one mail listing them; each pair once).
 * Never throws: returns how many were mailed.
 */
export async function mailKeyDuplicates({ pool, alerts, log = null }) {
  try {
    const rows = await withAllBranches(pool, (tx) => takeUnnotifiedDuplicates(tx));
    if (!rows.length) return 0;
    const itemsFor = (lang) => {
      const t = (key, params) => translate(lang, key, params);
      return rows.map((d) => t('- Key ID {kid}…: máy {owner} (GUID {ownerGuid}) và máy {other} (GUID {otherGuid}){pw}', {
        kid: d.key_id.slice(0, 8).toUpperCase(), owner: d.owner_name, ownerGuid: d.owner_guid, other: d.other_name, otherGuid: d.other_guid,
        pw: d.same_password ? '' : t(', mật khẩu khôi phục khác nhau'),
      }));
    };
    await alerts.notifyOnce('key_duplicate', 'medium', (lang) => ({ count: rows.length, items: itemsFor(lang).join('\n') }));
    for (const d of rows) log?.warn({ keyId: d.key_id, ownerId: Number(d.owner_id), otherId: Number(d.other_id) }, 'duplicate key id mailed');
    return rows.length;
  } catch (err) {
    log?.error({ err }, 'duplicate key id mail failed');
    return 0;
  }
}

/** The DC=... part of a DN (the AD domain), lower case. */
const domainOf = (dn) => (String(dn ?? '').match(/(?:^|,)(dc=.*)$/i)?.[1] ?? '').toLowerCase();

/**
 * Two computer objects with the same name in the same domain cannot both be in AD (the account name
 * is unique): a new object with the name of the old one means the old one was removed (unjoin, rejoin).
 */
const sameAdName = (a, b) => a.name.toLowerCase() === b.name.toLowerCase() && domainOf(a.distinguished_name) === domainOf(b.dn);
const INGEST_ACTOR = { userSid: 'system:ingest', userUpn: 'sync-worker' };

const isoDate = z.coerce.date();
const runId = z.coerce.number().int().positive();

const openInput = z.object({ mode: z.enum(['full', 'delta']), dcName: z.string().trim().min(1).max(255) });

const computersInput = z.object({
  runId,
  items: z
    .array(
      z.object({
        objectGuid: z.string().guid(),
        name: z.string().trim().min(1).max(64),
        dnsName: z.string().max(255).nullish(),
        dn: z.string().min(3).max(2048),
        os: z.string().max(128).nullish(),
        usnChanged: z.coerce.number().int().nonnegative().optional(),
        whenChanged: isoDate.nullish(),
        whenCreated: isoDate.nullish(),
        lastLogon: isoDate.nullish(), // AD lastLogonTimestamp; older workers do not send it
      }),
    )
    .max(MAX_BATCH),
});

const keysInput = z.object({
  runId,
  items: z
    .array(
      z.object({
        keyId: z.string().guid(),
        // objectGUID of the computer that owns the key: the preferred link (names and DNs change,
        // and a computer joined again under the same name has the same DN but a new objectGUID).
        computerObjectGuid: z.string().guid().nullish(),
        // DN of the computer that owns the key (parent of the msFVE-RecoveryInformation object).
        // `dn` (the key object's own DN) is accepted too; the parent is computed here.
        computerDn: z.string().min(3).max(2048).optional(),
        dn: z.string().min(3).max(2048).optional(),
        // Empty when the worker could read the object but not the confidential attribute.
        recoveryPassword: z.string().max(64).default(''),
        // msFVE-VolumeGuid: which encrypted volume (C:, D:...) the key protects.
        volumeGuid: z.string().guid().nullish(),
        whenCreated: isoDate,
      }).refine((k) => k.computerDn || k.dn, 'computerDn or dn is required'),
    )
    .max(MAX_BATCH),
});

const completeInput = z.object({
  status: z.enum(['success', 'failed']),
  highestUsn: z.coerce.number().int().nonnegative().nullish(),
  computersSeen: z.coerce.number().int().nonnegative().nullish(),
  keysSeen: z.coerce.number().int().nonnegative().nullish(),
  errors: z.coerce.number().int().nonnegative().default(0),
  errorCode: z.string().max(32).nullish(),
  dcHighestUsn: z.coerce.number().int().nonnegative().nullish(),
});

const heartbeatInput = z.object({
  workerId: z.string().trim().min(1).max(64),
  version: z.string().max(32).nullish(),
  dcName: z.string().max(255).nullish(),
  ldapOk: z.boolean().nullish(),
  lastErrorCode: z.string().max(32).nullish(),
  queueLen: z.coerce.number().int().nonnegative().nullish(),
  dcCertExpiresAt: isoDate.nullish(),
  canaryValue: isoDate.nullish(),
});

// Worker error codes (design doc table) -> alert severity.
export const ERROR_SEVERITY = {
  ldap_unreachable: 'high',
  ldap_tls_failed: 'high',
  ldap_bind_failed: 'high',
  ldap_search_base_failed: 'high',
  key_attr_unreadable: 'high',
  ldap_timeout: 'medium',
  usn_regressed: 'medium',
};

/** The ingest API's logic: the .NET worker pushes AD data; this decides what is written. */
export class IngestService {
  /** The state of a run after a change (same columns as the Tinh trang sync list). */
  async #emitRun(event, id) {
    if (!this.eventLog?.enabled) return;
    try {
      const run = await getRun(this.pool, id);
      if (run) this.eventLog.emit('sync_run', { event, ...syncRunFields(run) });
    } catch (err) {
      this.log?.warn({ err }, 'cannot write the sync run to the event log');
    }
  }

  constructor({ pool, audit, alerts, settings, newObjects = null, logger = null, eventLog = null }) {
    this.eventLog = eventLog;
    this.pool = pool;
    this.audit = audit;
    this.alerts = alerts;
    this.settings = settings;
    this.newObjects = newObjects;
    this.logger = logger;
    // Sync trace: one line per change, written after commit (see logEvents).
    this.log = logger ? logger.child({ component: 'sync' }) : null;
  }

  /**
   * Writes the changes of a committed transaction to the app log: one line per change (computer
   * added / moved / renamed / back in AD, key added / volume filled / status changed / skipped,
   * computer out of the monitored scope) and one summary line. Unchanged objects are only counted. Never a password.
   */
  logEvents(events, summary) {
    if (!this.log) return;
    for (const { level = 'info', msg, ...data } of events) this.log[level](data, msg);
    if (summary) this.log.info(summary.data, summary.msg);
  }

  async lastRun() {
    const r = await lastSuccessfulRun(this.pool);
    return r ? { runId: Number(r.id), dcName: r.dc_name, highestUsn: Number(r.highest_usn ?? 0), finishedAt: r.finished_at } : null;
  }

  /** Opens a run. A delta against a different DC than last time becomes a full run (USNs are per DC). */
  async openRun(raw) {
    const input = parse(openInput, raw);
    const opened = await withAllBranches(this.pool, async (tx) => {
      const orphans = await abortOrphanRuns(tx, ORPHAN_RUN_MINUTES);
      if (orphans.length) this.log?.warn({ runs: orphans.map(Number) }, 'sync run released: the worker was silent too long');
      const last = await lastSuccessfulRun(tx);
      let mode = input.mode;
      let sinceUsn = 0;
      if (mode === 'delta') {
        if (!last || last.dc_name.toLowerCase() !== input.dcName.toLowerCase()) mode = 'full';
        else sinceUsn = Number(last.highest_usn ?? 0);
      }
      try {
        const id = await insertRun(tx, { mode, dcName: input.dcName, sinceUsn });
        return { runId: Number(id), runRef: runRef(id, new Date()), mode, sinceUsn };
      } catch (err) {
        if (err.code === '23505') throw conflict('run_in_progress', 'Another sync run is in progress.');
        throw err;
      }
    });
    await this.#emitRun('opened', opened.runId);
    this.logEvents([], {
      msg: 'sync run opened',
      data: { runId: opened.runId, requestedMode: input.mode, mode: opened.mode, dc: input.dcName, sinceUsn: opened.sinceUsn },
    });
    return opened;
  }

  async #openRunOrThrow(tx, id) {
    const run = await getRunForUpdate(tx, id);
    if (!run) throw notFound('Run not found.');
    if (run.status !== 'running') throw conflict('run_closed', 'This sync run is already closed.');
    await touchRun(tx, id);
    return run;
  }

  /** Upserts computers by objectGUID and maps each to its branch from the DN. Idempotent. */
  async ingestComputers(raw) {
    const input = parse(computersInput, raw);
    const runId = input.runId;
    const events = [];
    const counts = { received: input.items.length, added: 0, moved: 0, changed: 0, backInAd: 0, unchanged: 0, unmapped: 0 };
    const result = await withAllBranches(this.pool, async (tx) => {
      await this.#openRunOrThrow(tx, runId);
      const ous = await loadBranchOus(tx);
      for (const item of input.items) {
        const branchId = branchForDn(item.dn, ous);
        if (branchId === null) counts.unmapped++;
        const c = { ...item, objectGuid: item.objectGuid.toLowerCase(), branchId, runId };
        const ref = { runId, objectGuid: c.objectGuid, name: c.name };
        const existing = await findComputerByGuid(tx, c.objectGuid);
        if (!existing) {
          const id = await insertComputer(tx, c);
          counts.added++;
          events.push({ msg: 'computer added', ...ref, computerId: Number(id), dn: c.dn, branchId });
          continue;
        }
        await updateComputer(tx, existing.id, c);
        const computerId = Number(existing.id);
        let changed = false;
        if (existing.branch_id !== branchId) {
          counts.moved++;
          changed = true;
          events.push({ msg: 'computer moved to another branch', ...ref, computerId, fromBranchId: existing.branch_id, toBranchId: branchId, dn: c.dn });
          await this.audit.append(tx, {
            ...INGEST_ACTOR,
            action: 'computer_moved',
            computerId: String(existing.id),
            branchId,
            detail: { fromBranchId: existing.branch_id, toBranchId: branchId, name: c.name },
          });
        }
        const renamed = existing.name !== c.name;
        const dnChanged = existing.distinguished_name.toLowerCase() !== c.dn.toLowerCase();
        if (renamed || (dnChanged && existing.branch_id === branchId)) {
          counts.changed++;
          changed = true;
          events.push({
            msg: 'computer renamed or moved in AD',
            ...ref,
            computerId,
            ...(renamed ? { fromName: existing.name } : {}),
            ...(dnChanged ? { fromDn: existing.distinguished_name, dn: c.dn } : {}),
          });
        }
        if (existing.deleted_in_ad_at) {
          counts.backInAd++;
          changed = true;
          events.push({ msg: 'computer back in AD', ...ref, computerId, notInAdSince: existing.deleted_in_ad_at });
        }
        if (!changed) counts.unchanged++;
      }
      return { upserted: input.items.length, moved: counts.moved, unmapped: counts.unmapped };
    });
    this.logEvents(events, { msg: 'computer batch stored', data: { runId, ...counts } });
    return result;
  }

  /**
   * Inserts keys not seen before (never overwrites or deletes) and records the volume of known
   * keys that lacked it. Then, per volume, the newest key is 'active' and older ones 'superseded'.
   * Keys whose computer is unknown come back as `orphans`.
   */
  async ingestKeys(raw) {
    const input = parse(keysInput, raw);
    const runId = input.runId;
    const events = [];
    const counts = { received: input.items.length, added: 0, volumeFilled: 0, unchanged: 0, emptyPassword: 0, malformed: 0, orphans: 0, statusChanged: 0, moved: 0, duplicates: 0 };
    const result = await withAllBranches(this.pool, async (tx) => {
      await this.#openRunOrThrow(tx, runId);
      let inserted = 0;
      let skipped = 0;
      let emptyPwd = 0;
      const orphans = [];
      const touched = new Map(); // computer id -> name, for the status recompute and the log
      for (const item of input.items) {
        const keyId = item.keyId.toLowerCase();
        if (!item.recoveryPassword) {
          emptyPwd++;
          counts.emptyPassword++;
          events.push({ level: 'warn', msg: 'key without a readable password (not stored)', runId, keyId, dn: item.dn });
          continue;
        }
        if (!RECOVERY_PASSWORD.test(item.recoveryPassword)) {
          skipped++;
          counts.malformed++;
          events.push({ level: 'warn', msg: 'key with a malformed password (not stored)', runId, keyId, dn: item.dn });
          continue;
        }
        // The owner: by objectGUID when the worker sends it (AD's own, stable id), else by DN.
        const computerDn = item.computerDn ?? parentDn(item.dn);
        const computerGuid = item.computerObjectGuid?.toLowerCase() ?? null;
        const computer = computerGuid ? await findComputerByGuid(tx, computerGuid) : await findComputerByDn(tx, computerDn);
        if (!computer) {
          orphans.push(item.keyId);
          counts.orphans++;
          events.push({ msg: 'key for an unknown computer (sent back as orphan)', runId, keyId, computerDn, computerObjectGuid: computerGuid });
          continue;
        }
        // The Key ID is already known under another computer.
        const owner = await findKeyOwner(tx, keyId, item.recoveryPassword);
        if (owner && String(owner.computer_id) !== String(computer.id)) {
          const ref = { runId, keyId, computerId: Number(computer.id), computer: computer.name, ownerId: Number(owner.computer_id), owner: owner.name };
          const sameName = sameAdName(owner, { name: computer.name, dn: computerDn });
          if (owner.same_password && (owner.deleted_in_ad_at || sameName)) {
            // Unjoin + rejoin: the old computer object is gone from AD, the key now sits under the new one.
            if (!owner.deleted_in_ad_at) {
              await markComputerReplaced(tx, owner.computer_id);
              events.push({ msg: 'computer replaced by a new AD object with the same name (unjoin and rejoin)', ...ref });
            }
            await moveKey(tx, {
              keyId, fromId: owner.computer_id, toId: computer.id, runId,
              reason: owner.deleted_in_ad_at ? 'old_not_in_ad' : 'rejoin_same_name',
            });
            await setKeyDn(tx, keyId, item.dn);
            counts.moved++;
            touched.set(owner.computer_id, owner.name);
            touched.set(computer.id, computer.name);
            events.push({ msg: 'key moved to the computer that now holds it in AD', ...ref });
          } else {
            // Both computers still in AD (e.g. a cloned image), or another password: keep the key where
            // it is, record the duplicate (mailed once, after a full run confirms it).
            await recordKeyDuplicate(tx, { keyId, computerId: computer.id, samePassword: owner.same_password, runId });
            counts.duplicates++;
            events.push({
              level: 'warn',
              msg: owner.same_password ? 'key id also under another computer still in AD (duplicate recorded)' : 'key id known with another password (not stored, duplicate recorded)',
              ...ref,
            });
          }
          skipped++;
          continue;
        }
        const volumeGuid = item.volumeGuid?.toLowerCase() ?? null;
        const result = await upsertKey(tx, computer.id, { ...item, keyId, volumeGuid, runId });
        await setKeyDn(tx, keyId, item.dn);
        const ref = { runId, keyId, computerId: Number(computer.id), computer: computer.name, volumeGuid };
        if (result === 'inserted') {
          inserted++;
          counts.added++;
          events.push({ msg: 'key added', ...ref, createdInAd: item.whenCreated });
        } else {
          skipped++; // already known: never overwritten
          if (result === 'volume_added') {
            counts.volumeFilled++;
            events.push({ msg: 'key volume recorded', ...ref });
          } else {
            counts.unchanged++;
          }
        }
        if (result !== 'unchanged') touched.set(computer.id, computer.name);
      }
      const statusChanges = await recomputeKeyStatuses(tx, [...touched.keys()]);
      for (const k of statusChanges) {
        counts.statusChanged++;
        events.push({
          msg: k.status === 'superseded' ? 'key superseded by a newer key of the same volume' : 'key is the active key of its volume',
          runId,
          keyId: k.key_id,
          computerId: Number(k.computer_id),
          computer: touched.get(k.computer_id) ?? touched.get(String(k.computer_id)),
          volumeGuid: k.volume_guid,
          status: k.status,
        });
      }
      await bumpRunCounters(tx, runId, { keysAdded: inserted, keysEmptyPwd: emptyPwd });
      return { inserted, skipped, emptyPassword: emptyPwd, orphans };
    });
    this.logEvents(events, { msg: 'key batch stored', data: { runId, ...counts } });
    return result;
  }

  /**
   * Closes a run. A failed run raises an alert. A successful one is checked for anomalies:
   * if any, it is quarantined (no deletions, USN not advanced) until Admin HQ decides;
   * otherwise a full run marks computers it did not see as deleted in AD.
   */
  /** Log lines for the end of a run (after commit). */
  #logCompletion(id, input, outcome) {
    const base = { runId: id, mode: outcome.run.mode, dc: outcome.run.dc_name };
    if (outcome.status === 'failed') {
      this.logEvents([], { msg: 'sync run failed', data: { ...base, errorCode: input.errorCode ?? 'unknown', errors: input.errors } });
      return;
    }
    const totals = {
      ...base,
      computersSeen: outcome.overall?.computers_seen,
      computersInDb: outcome.overall?.computers_in_db,
      keysSeen: input.keysSeen,
      keysAdded: outcome.run.keys_added,
      highestUsn: input.highestUsn,
    };
    if (outcome.status === 'quarantined') {
      this.logEvents(
        outcome.anomalies.map((a) => ({ level: 'warn', msg: 'sync anomaly', runId: id, code: a.code, detail: a.detail })),
        { msg: 'sync run quarantined (changes held until Admin HQ decides)', data: { ...totals, plannedNotInAd: outcome.plannedDeletes } },
      );
      return;
    }
    const moved = (outcome.settled?.moved ?? []).map((m) => ({ msg: 'key moved: its old computer left the monitored scope', runId: id, keyId: m.key_id, fromId: Number(m.from_id), toId: Number(m.to_id) }));
    this.logEvents([...notInAdEvents(id, outcome.notInAd), ...moved], {
      msg: 'sync run completed',
      data: { ...totals, markedNotInAd: outcome.markedDeleted, keysMoved: moved.length, duplicatesClosed: outcome.settled?.gone ?? 0 },
    });
  }

  /**
   * Duplicate Key IDs confirmed by a full run (both computers still in AD): one mail listing the new
   * ones, once per pair. Never fails the API call.
   */
  async notifyKeyDuplicates() {
    return mailKeyDuplicates({ pool: this.pool, alerts: this.alerts, log: this.log });
  }

  /** New computers / keys of the run are mailed (Settings > Thong bao). Never fails the API call. */
  async #notifyNewObjects(run) {
    if (!this.newObjects) return;
    try {
      await this.newObjects.afterRun(run);
    } catch (err) {
      this.logger?.error({ err, runId: run.id }, 'new-object notification failed');
    }
  }

  async completeRun(id, raw) {
    const input = parse(completeInput, raw);
    const outcome = await withAllBranches(this.pool, async (tx) => {
      const run = await this.#openRunOrThrow(tx, id);
      if (input.status === 'failed') {
        await finishRun(tx, id, { status: 'failed', errors: input.errors, errorCode: input.errorCode ?? 'unknown' });
        return { status: 'failed', run };
      }

      const rows = await collectMetrics(tx, id);
      const overallRow = rows.find((r) => r.overall);
      const overall = {
        ...overallRow,
        computers_seen: run.mode === 'full' ? overallRow.computers_seen : input.computersSeen ?? overallRow.computers_seen,
        keys_seen: input.keysSeen ?? 0,
        keys_empty_pwd: run.keys_empty_pwd,
        dc_highest_usn: input.dcHighestUsn ?? null,
      };
      const branches = rows.filter((r) => !r.overall && r.branch_id !== null);
      const plannedDeletes = run.mode === 'full' ? await countNotSeenSince(tx, id) : 0;
      const thresholds = await loadThresholds(this.settings);
      const anomalies = checkRun(
        { mode: run.mode, overall, branches, plannedDeletes, liveComputers: overallRow.computers_in_db },
        { branchSeen: await branchBaseline(tx) },
        thresholds,
      );

      await insertMetric(tx, id, { ...overall, branch_id: null });
      for (const b of branches) {
        await insertMetric(tx, id, { ...b, keys_seen: 0, keys_empty_pwd: 0, dc_highest_usn: null });
      }

      const common = { highestUsn: input.highestUsn, computersSeen: overall.computers_seen, keysSeen: input.keysSeen, errors: input.errors };
      if (anomalies.length) {
        await finishRun(tx, id, {
          ...common,
          status: 'quarantined',
          highestUsn: null,
          pending: { highestUsn: input.highestUsn ?? null, markDeleted: run.mode === 'full', plannedDeletes },
          anomalies,
        });
        return { status: 'quarantined', run, anomalies, plannedDeletes, overall };
      }
      const notInAd = run.mode === 'full' ? await markNotSeenAsDeleted(tx, id) : [];
      // Keys whose old computer has just left AD go to the computer that now holds them.
      const settled = run.mode === 'full' ? await settleKeyDuplicates(tx, id) : { moved: [], gone: 0 };
      if (settled.moved.length) await recomputeKeyStatuses(tx, [...new Set(settled.moved.flatMap((m) => [m.from_id, m.to_id]))]);
      await finishRun(tx, id, { ...common, status: 'success', markedNotInAd: notInAd.length });
      return { status: 'success', run, markedDeleted: notInAd.length, notInAd, overall, settled };
    });

    await this.#emitRun(outcome.status === 'quarantined' ? 'quarantined' : outcome.status === 'failed' ? 'failed' : 'finished', id);
    this.#logCompletion(id, input, outcome);

    // Alerts after commit (they send messages and must not hold the transaction).
    if (outcome.status === 'failed') {
      const code = input.errorCode ?? 'unknown';
      // The worker was stopped on purpose (service stop, update): not a sync failure.
      if (code === 'cancelled') return { status: 'failed' };
      await this.alerts.raise(
        'sync_failed',
        ERROR_SEVERITY[code] ?? 'high',
        { runId: id, runRef: runRef(id, outcome.run.started_at), mode: outcome.run.mode, dc: outcome.run.dc_name, errorCode: code },
        { runId: id, runRef: runRef(id, outcome.run.started_at), errorCode: code },
      );
      return { status: 'failed' };
    }
    if (outcome.status === 'quarantined') {
      await this.alerts.raise(
        'sync_anomaly',
        'high',
        {
          runId: id,
          runRef: runRef(id, outcome.run.started_at),
          anomalies: outcome.anomalies.map((a) => `- ${a.message}`).join('\n'),
          anomaliesVi: outcome.anomalies.map((a) => `- ${anomalyText(a)}`).join('\n'),
        },
        { runId: id, runRef: runRef(id, outcome.run.started_at) },
      );
      await this.#notifyNewObjects(outcome.run);
      return { status: 'quarantined', anomalies: outcome.anomalies.map(({ code, message }) => ({ code, message })) };
    }
    await this.alerts.clear('sync_failed', { runId: id, runRef: runRef(id, outcome.run.started_at) });
    await this.#notifyNewObjects(outcome.run);
    if (outcome.run.mode === 'full') await this.notifyKeyDuplicates();
    return { status: 'success', markedDeleted: outcome.markedDeleted };
  }

  /** Records a worker heartbeat; returns a pending manual sync request (once). */
  async heartbeat(raw) {
    const input = parse(heartbeatInput, raw);
    await upsertHeartbeat(this.pool, input);
    const requested = await takeSyncRequest(this.pool);
    return { syncRequested: requested?.mode ?? null };
  }
}

/** One log line per computer flagged "out of the monitored scope" (nothing is deleted). */
export function notInAdEvents(runId, computers) {
  return computers.map((c) => ({
    msg: 'computer not seen by the full run: flagged out of the monitored scope',
    runId,
    computerId: Number(c.id),
    objectGuid: c.object_guid,
    name: c.name,
    branchId: c.branch_id,
    lastSeenRun: c.last_seen_run === null ? null : Number(c.last_seen_run),
  }));
}
