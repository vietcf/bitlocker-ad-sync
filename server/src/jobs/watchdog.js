import { withAllBranches } from '../db/scoped.js';
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
 * Sync watchdog (design doc: "Phat hien loi dong bo AD"). Runs in Node, not in the worker,
 * so a dead or hung worker is still noticed. Each check records its alert (shown in the app, no mail)
 * or clears it silently. While any condition holds the sync is "offline": one sync_offline mail
 * listing the conditions, sent when it goes offline and then at most once per calendar day; nothing
 * more once every condition has cleared (back online).
 * Returns the list of alert types that are currently raised.
 */
export async function runSyncWatchdog({ pool, alerts, settings }) {
  const t = await loadThresholds(settings);
  const n = async (k, d) => Number(await settings.get(k, d));
  const heartbeatMax = await n('watchdog.heartbeat_max_minutes', 15);
  const deltaMax = await n('watchdog.delta_max_minutes', 60);
  const fullMaxHours = await n('watchdog.full_max_hours', 26);
  const runningMaxHours = await n('watchdog.running_max_hours', 2);

  const raised = [];
  const found = []; // subjects of the conditions met, for the sync_offline mail
  let high = false;
  // Each alert's text is the mail template named like its type (templates/mail-templates.yaml).
  const flag = async (type, severity, vars) => {
    raised.push(type);
    found.push(await alerts.record(type, severity, vars));
    if (severity === 'high') high = true;
  };
  const check = async (type, isBad, severity, vars) => {
    if (isBad) await flag(type, severity, vars);
    else await alerts.clear(type, {}, { announce: false });
  };

  const [heartbeats, last, lastFull, aborted, recent, trend] = await withAllBranches(pool, async (tx) => [
    await listHeartbeats(tx),
    await lastSuccessfulRun(tx),
    await lastSuccessfulRunOfMode(tx, 'full'),
    await abortStaleRuns(tx, runningMaxHours),
    await recentOverallMetrics(tx, Math.max(t.usnStallHours * 2, 24)),
    await noKeyTrend(tx),
  ]);

  // 1. Worker alive?
  const hb = heartbeats[0] ?? null;
  const hbAge = minutesSince(hb?.at);
  await check('worker_silent', hbAge > heartbeatMax, 'high', {
    worker: hb?.worker_id ?? '—',
    lastHeartbeatAt: hb ? when(hb.at) : '—',
    minutesAgo: hb ? Math.round(hbAge) : '—',
  });

  // 2. Recent successful runs?
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

  // 3. Runs stuck in "running".
  if (aborted.length) {
    await flag('sync_run_aborted', 'medium', { runs: aborted.map((id) => `#${id}`).join(', '), maxHours: runningMaxHours });
  } else if (lastAge <= deltaMax) {
    // Cleared once runs complete normally again.
    await alerts.clear('sync_run_aborted', {}, { announce: false });
  }

  // 4. Worker-reported LDAP state and the DC certificate.
  await check('ldap_error', hb && hb.ldap_ok === false, 'high', {
    worker: hb?.worker_id ?? '', errorCode: hb?.last_error_code ?? 'unknown', dc: hb?.dc_name ?? '',
  });
  const certDays = hb?.dc_cert_expires_at ? (new Date(hb.dc_cert_expires_at) - Date.now()) / 86_400_000 : Infinity;
  await check('dc_cert_expiring', certDays < 30, 'medium', { dc: hb?.dc_name ?? '', days: Math.floor(certDays) });

  // 5. End-to-end canary (only once the worker has ever reported one).
  if (hb?.canary_value) {
    const canaryAge = minutesSince(hb.canary_value);
    await check('canary_stale', canaryAge > t.canaryMaxAgeMinutes, 'high', { ageMinutes: Math.round(canaryAge), maxMinutes: t.canaryMaxAgeMinutes });
  }

  // 6. DC stopped receiving changes: highest committed USN flat for usnStallHours.
  const usnRows = recent.filter((r) => r.dc_highest_usn !== null);
  const windowStart = Date.now() - t.usnStallHours * 3600_000;
  const inWindow = usnRows.filter((r) => r.finished_at.getTime() >= windowStart);
  const olderThanWindow = usnRows.find((r) => r.finished_at.getTime() < windowStart);
  const flat = olderThanWindow && inWindow.length > 0 && inWindow.every((r) => r.dc_highest_usn === olderThanWindow.dc_highest_usn);
  await check('dc_usn_stalled', !!flat, 'high', { hours: t.usnStallHours, usn: olderThanWindow?.dc_highest_usn ?? '' });

  // 7. Escrow: new machines older than 48h without any key.
  const latest = recent[0];
  const escrowBad =
    latest && latest.new_computers_7d >= t.escrowMinNew && latest.new_without_key / latest.new_computers_7d > t.escrowRatio;
  await check('escrow_broken', !!escrowBad, 'medium', { withoutKey: latest?.new_without_key ?? 0, created: latest?.new_computers_7d ?? 0 });

  // 8. Share of machines without a key rising in a branch, week over week.
  const rising = trend.filter((r) => Number(r.now_pct) - Number(r.old_pct) > t.noKeyPpIncrease);
  await check('no_key_rising', rising.length > 0, 'medium', {
    branches: rising.map((r) => `${r.branch_code}: ${r.old_pct}% -> ${r.now_pct}%`).join('; '),
  });

  // 9. One mail for everything: offline while any condition holds, at most once a day.
  if (raised.length) {
    await alerts.raise('sync_offline', high ? 'high' : 'medium', {
      count: raised.length,
      conditions: found.map((x) => `- ${x}`).join('\n'),
      checkedAt: when(new Date()),
    }, { conditions: raised }, { daily: true });
  } else {
    await alerts.clear('sync_offline', {}, { announce: false });
  }

  return raised;
}

/** Daily audit-chain verification. */
export async function runChainCheck({ audit, alerts }) {
  const r = await audit.verify();
  if (r.ok) {
    await alerts.clear('audit_chain_broken', { rows: r.checked });
  } else {
    await alerts.raise('audit_chain_broken', 'high', { rowId: r.brokenAtId, problem: r.problem }, { brokenAtId: r.brokenAtId });
  }
  return r;
}
