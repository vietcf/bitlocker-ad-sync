import { withAllBranches } from '../db/scoped.js';
import { tk, translate } from '../i18n/index.js';
import { loadThresholds } from '../modules/sync/anomaly.js';
import {
  abortStaleRuns,
  lastSuccessfulRun,
  lastSuccessfulRunOfMode,
  listHeartbeats,
  noKeyTrend,
  recentOverallMetrics,
} from '../modules/sync/sync.repo.js';

const minutesSince = (d) => (d ? (Date.now() - new Date(d).getTime()) / 60_000 : Infinity);
/** "2026-10-13 15:04" in the app's time zone, for mail templates. */
const when = (d) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: process.env.APP_TZ ?? 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'short' }).format(new Date(d));

/**
 * Sync watchdog (design doc: "Phat hien loi dong bo AD"). Runs in Node, not in the worker, so a dead
 * or hung worker is still noticed. Each check records its alert (shown in the app, no mail of its own)
 * or clears it silently. The checks fall in two groups, each with ONE summary mail, sent when the
 * problem starts and then at most once per calendar day, and nothing once it is over:
 *  - worker_offline: the sync worker (agent) sends no heartbeat. Checks that need a running worker
 *    (sync age, LDAP state, canary, USN) say nothing then: they would only repeat that the worker is down.
 *  - sync_problem: the worker runs, but AD or the sync is not right (cannot read AD / DC offline,
 *    no successful run for too long, runs stuck, canary or USN stalled, DC certificate expiring,
 *    keys not escrowed, no-key share rising).
 * Returns { raised, workerOffline, problems } (raised: alert types currently on).
 */
export async function runSyncWatchdog({ pool, alerts, settings }) {
  const t = await loadThresholds(settings);
  const n = async (k, d) => Number(await settings.get(k, d));
  const heartbeatMax = await n('watchdog.heartbeat_max_minutes', 15);
  const deltaMax = await n('watchdog.delta_max_minutes', 60);
  const fullMaxHours = await n('watchdog.full_max_hours', 26);
  const runningMaxHours = await n('watchdog.running_max_hours', 2);

  const raised = [];
  const problems = []; // { type, subject, severity } of the sync_problem group
  // Each alert's text is the mail template named like its type (templates/mail-templates.yaml).
  const flag = async (type, severity, vars) => {
    if (!(await settings.alertEnabled(type))) return quiet(type); // switched off by Admin HQ: not watched, an open one is closed quietly
    // "Handled" by Admin HQ: leave this type alone until the grace period is over, then look again
    const graceUntil = await settings.get(`alert_grace.${type}`, null);
    if (graceUntil && new Date(graceUntil) > new Date()) return quiet(type);
    raised.push(type);
    const subject = await alerts.record(type, severity, vars);
    // a data alert marked handled / snoozed by Admin HQ no longer counts as a sync problem
    if (type !== 'worker_silent' && !(await alerts.isSilenced(type))) problems.push({ type, subject, severity });
  };
  const quiet = (type) => alerts.clear(type, {}, { announce: false });
  const check = async (type, isBad, severity, vars) => (isBad ? flag(type, severity, vars) : quiet(type));

  const [heartbeats, last, lastFull, aborted, recent, trend] = await withAllBranches(pool, async (tx) => [
    await listHeartbeats(tx),
    await lastSuccessfulRun(tx),
    await lastSuccessfulRunOfMode(tx, 'full'),
    await abortStaleRuns(tx, runningMaxHours),
    await recentOverallMetrics(tx, Math.max(t.usnStallHours * 2, 24)),
    await noKeyTrend(tx),
  ]);

  // ---- Group 1: the worker (agent) itself ----
  const hb = heartbeats[0] ?? null; // the newest heartbeat of any worker
  const hbAge = minutesSince(hb?.at);
  const workerOffline = hbAge > heartbeatMax;
  await check('worker_silent', workerOffline, 'high', {
    worker: hb?.worker_id ?? '—',
    lastHeartbeatAt: hb ? when(hb.at) : '—',
    minutesAgo: hb ? Math.round(hbAge) : '—',
  });

  // ---- Group 2: AD and the sync, judged only while the worker runs ----
  const WORKER_DEPENDENT = ['sync_stale', 'full_stale', 'sync_run_aborted', 'ldap_error', 'canary_stale', 'dc_usn_stalled'];
  if (workerOffline) {
    for (const type of WORKER_DEPENDENT) await quiet(type);
  } else {
    // Recent successful runs?
    const lastAge = minutesSince(last?.finished_at);
    await check('sync_stale', lastAge > deltaMax, 'high', {
      maxMinutes: deltaMax,
      lastRunId: last?.id ?? '—',
      lastRunAt: last ? when(last.finished_at) : '—',
    });
    const fullAge = minutesSince(lastFull?.finished_at);
    await check('full_stale', fullAge > fullMaxHours * 60, 'medium', {
      maxHours: fullMaxHours,
      lastRunId: lastFull?.id ?? '—',
      lastRunAt: lastFull ? when(lastFull.finished_at) : '—',
    });
    // Runs stuck in "running" (always aborted above; flagged while the worker runs).
    if (aborted.length) {
      await flag('sync_run_aborted', 'medium', { runs: aborted.map((id) => `#${id}`).join(', '), maxHours: runningMaxHours });
    } else if (lastAge <= deltaMax) {
      await quiet('sync_run_aborted'); // cleared once runs complete normally again
    }
    // The worker cannot read AD (DC offline / unreachable, credentials, TLS...).
    await check('ldap_error', hb.ldap_ok === false, 'high', {
      worker: hb.worker_id ?? '', errorCode: hb.last_error_code ?? 'unknown', dc: hb.dc_name ?? '',
    });
    // End-to-end canary (only once the worker has ever reported one).
    if (hb.canary_value) {
      const canaryAge = minutesSince(hb.canary_value);
      await check('canary_stale', canaryAge > t.canaryMaxAgeMinutes, 'high', { ageMinutes: Math.round(canaryAge), maxMinutes: t.canaryMaxAgeMinutes });
    }
    // DC stopped receiving changes: highest committed USN flat for usnStallHours.
    const usnRows = recent.filter((r) => r.dc_highest_usn !== null);
    const windowStart = Date.now() - t.usnStallHours * 3600_000;
    const inWindow = usnRows.filter((r) => r.finished_at.getTime() >= windowStart);
    const olderThanWindow = usnRows.find((r) => r.finished_at.getTime() < windowStart);
    const flat = olderThanWindow && inWindow.length > 0 && inWindow.every((r) => r.dc_highest_usn === olderThanWindow.dc_highest_usn);
    await check('dc_usn_stalled', !!flat, 'high', { hours: t.usnStallHours, usn: olderThanWindow?.dc_highest_usn ?? '' });
  }

  // Checks on stored data: valid whether or not the worker runs now.
  const certDays = hb?.dc_cert_expires_at ? (new Date(hb.dc_cert_expires_at) - Date.now()) / 86_400_000 : Infinity;
  await check('dc_cert_expiring', certDays < 30, 'medium', { dc: hb?.dc_name ?? '', days: Math.floor(certDays) });
  const latest = recent[0];
  const escrowBad =
    latest && latest.new_computers_7d >= t.escrowMinNew && latest.new_without_key / latest.new_computers_7d > t.escrowRatio;
  await check('escrow_broken', !!escrowBad, 'medium', { withoutKey: latest?.new_without_key ?? 0, created: latest?.new_computers_7d ?? 0 });
  const rising = trend.filter((r) => Number(r.now_pct) - Number(r.old_pct) > t.noKeyPpIncrease);
  await check('no_key_rising', rising.length > 0, 'medium', {
    branches: rising.map((r) => `${r.branch_code}: ${r.old_pct}% -> ${r.now_pct}%`).join('; '),
  });

  // ---- One mail per group, at most once a day while it lasts ----
  if (workerOffline && (await settings.alertEnabled('worker_silent'))) {
    await alerts.raise('worker_offline', 'high', (lang) => ({
      worker: hb?.worker_id ?? '—',
      lastHeartbeatAt: hb ? when(hb.at) : translate(lang, tk('chưa bao giờ')),
      minutesAgo: hb ? Math.round(hbAge) : '—',
      maxMinutes: heartbeatMax,
      checkedAt: when(new Date()),
    }), {}, { daily: true });
  } else {
    await quiet('worker_offline');
  }
  if (problems.length) {
    await alerts.raise('sync_problem', problems.some((p) => p.severity === 'high') ? 'high' : 'medium', (lang) => ({
      count: problems.length,
      conditions: problems.map((p) => `- ${p.subject[lang]}`).join('\n'),
      checkedAt: when(new Date()),
    }), { conditions: problems.map((p) => p.type) }, { daily: true });
  } else {
    await quiet('sync_problem');
  }
  await quiet('sync_offline'); // the former single summary (before worker_offline / sync_problem)

  return { raised, workerOffline, problems: problems.map((p) => p.type) };
}

