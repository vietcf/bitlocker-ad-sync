// Sync runs, ingest writes and sync metrics. Runs with all-branch scope (system work).

// ---- runs ---------------------------------------------------------------------------------

export async function lastSuccessfulRun(db) {
  const { rows } = await db.query(
    `SELECT id, mode, dc_name, highest_usn, finished_at FROM sync_run
      WHERE status = 'success' ORDER BY id DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function lastSuccessfulRunOfMode(db, mode) {
  const { rows } = await db.query(
    `SELECT id, finished_at FROM sync_run WHERE status = 'success' AND mode = $1 ORDER BY id DESC LIMIT 1`,
    [mode],
  );
  return rows[0] ?? null;
}

export async function insertRun(db, { mode, dcName, sinceUsn }) {
  const { rows } = await db.query(
    `INSERT INTO sync_run (mode, dc_name, since_usn) VALUES ($1, $2, $3) RETURNING id`,
    [mode, dcName, sinceUsn],
  );
  return rows[0].id;
}

export async function runningRun(db) {
  const { rows } = await db.query(`SELECT id, started_at FROM sync_run WHERE status = 'running'`);
  return rows[0] ?? null;
}

export async function getRunForUpdate(db, id) {
  const { rows } = await db.query('SELECT * FROM sync_run WHERE id = $1 FOR UPDATE', [id]);
  return rows[0] ?? null;
}

export async function finishRun(db, id, f) {
  await db.query(
    `UPDATE sync_run SET status = $2, finished_at = now(), highest_usn = $3, computers_seen = $4,
            keys_seen = $5, errors = $6, error_code = $7, pending = $8, anomalies = $9
      WHERE id = $1`,
    [
      id,
      f.status,
      f.highestUsn ?? null,
      f.computersSeen ?? null,
      f.keysSeen ?? null,
      f.errors ?? null,
      f.errorCode ?? null,
      f.pending ? JSON.stringify(f.pending) : null,
      f.anomalies ? JSON.stringify(f.anomalies) : null,
    ],
  );
}

export async function bumpRunCounters(db, id, { keysAdded = 0, keysEmptyPwd = 0 }) {
  await db.query(
    `UPDATE sync_run SET keys_added = coalesce(keys_added, 0) + $2, keys_empty_pwd = keys_empty_pwd + $3 WHERE id = $1`,
    [id, keysAdded, keysEmptyPwd],
  );
}

/** Runs stuck in 'running' for longer than `hours` become 'aborted'. Returns their ids. */
export async function abortStaleRuns(db, hours) {
  const { rows } = await db.query(
    `UPDATE sync_run SET status = 'aborted', finished_at = now(), error_code = 'timeout'
      WHERE status = 'running' AND started_at < now() - make_interval(hours => $1) RETURNING id`,
    [hours],
  );
  return rows.map((r) => r.id);
}

export async function listRuns(db, limit = 30) {
  const { rows } = await db.query(
    `SELECT id, started_at, finished_at, mode, dc_name, since_usn, highest_usn, computers_seen, keys_seen,
            keys_added, keys_empty_pwd, errors, error_code, status, anomalies, ack_by, ack_decision, ack_at
       FROM sync_run ORDER BY id DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function ackRun(db, id, { by, decision, status }) {
  await db.query(
    `UPDATE sync_run SET ack_by = $2, ack_decision = $3, ack_at = now(), status = $4 WHERE id = $1`,
    [id, by, decision, status],
  );
}

export async function countUnackedQuarantined(db) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM sync_run WHERE status = 'quarantined' AND ack_decision IS NULL`,
  );
  return rows[0].n;
}

// ---- computers and keys ---------------------------------------------------------------------

export async function loadBranchOus(db) {
  const { rows } = await db.query('SELECT branch_id, root_dn FROM branch_ou');
  return rows.map((r) => ({ branchId: r.branch_id, rootDn: r.root_dn }));
}

export async function findComputerByGuid(db, objectGuid) {
  const { rows } = await db.query(
    'SELECT id, branch_id, name, distinguished_name, deleted_in_ad_at FROM computer WHERE object_guid = $1 FOR UPDATE',
    [objectGuid],
  );
  return rows[0] ?? null;
}

export async function insertComputer(db, c) {
  const { rows } = await db.query(
    `INSERT INTO computer (object_guid, name, dns_name, distinguished_name, branch_id, os, when_changed, ad_created_at, last_seen_run, first_seen_run)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING id`,
    [c.objectGuid, c.name, c.dnsName ?? null, c.dn, c.branchId, c.os ?? null, c.whenChanged ?? null, c.whenCreated ?? null, c.runId],
  );
  return rows[0].id;
}

export async function updateComputer(db, id, c) {
  await db.query(
    `UPDATE computer SET name = $2, dns_name = $3, distinguished_name = $4, branch_id = $5, os = $6,
            when_changed = $7, ad_created_at = coalesce($8, ad_created_at), last_seen_run = $9, deleted_in_ad_at = NULL
      WHERE id = $1`,
    [id, c.name, c.dnsName ?? null, c.dn, c.branchId, c.os ?? null, c.whenChanged ?? null, c.whenCreated ?? null, c.runId],
  );
}

/** { id, name } of the computer with this DN, or null. */
/**
 * The computer a key belongs to, by its DN. Several rows can share a DN: a computer deleted from AD
 * and joined again under the same name is a new object (new objectGUID) while the old row stays
 * for its history. The key goes to the live one, the one seen most recently.
 */
export async function findComputerByDn(db, dn) {
  const { rows } = await db.query(
    `SELECT id, name FROM computer WHERE lower(distinguished_name) = lower($1)
      ORDER BY deleted_in_ad_at NULLS FIRST, last_seen_run DESC NULLS LAST, id DESC LIMIT 1`,
    [dn],
  );
  return rows[0] ?? null;
}

/**
 * Inserts a key unless its key_id is known (a key is never overwritten). For a known key whose
 * volume was not recorded yet (stored before volumes were tracked), records the volume.
 * Returns 'inserted' | 'volume_added' | 'unchanged'.
 */
export async function upsertKey(db, computerId, k) {
  const { rows } = await db.query(
    `INSERT INTO recovery_key (computer_id, key_id, recovery_password, ad_created_at, volume_guid, first_seen_run)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (key_id) DO UPDATE SET volume_guid = EXCLUDED.volume_guid
       WHERE recovery_key.volume_guid IS NULL AND EXCLUDED.volume_guid IS NOT NULL
     RETURNING (xmax = 0) AS inserted`,
    [computerId, k.keyId, k.recoveryPassword, k.whenCreated, k.volumeGuid ?? null, k.runId ?? null],
  );
  if (!rows[0]) return 'unchanged';
  return rows[0].inserted ? 'inserted' : 'volume_added';
}

/** Records the DN of the key object in AD (kept up to date; the key itself never changes). */
export async function setKeyDn(db, keyId, dn) {
  if (!dn) return;
  await db.query('UPDATE recovery_key SET ad_dn = $2 WHERE key_id = $1 AND ad_dn IS DISTINCT FROM $2', [keyId, dn]);
}

/**
 * Key status, per volume of each given computer: the newest key of a volume is 'active', older
 * keys of the SAME volume are 'superseded'. Keys of other volumes are not affected.
 * (Keys with no known volume form their own group.) Returns the keys whose status changed:
 * [{ key_id, computer_id, volume_guid, status }] (status = the new one).
 */
export async function recomputeKeyStatuses(db, computerIds) {
  if (computerIds.length === 0) return [];
  const { rows } = await db.query(
    `UPDATE recovery_key k
        SET status = s.status
       FROM (SELECT id, CASE WHEN row_number() OVER (
                              PARTITION BY computer_id, volume_guid ORDER BY ad_created_at DESC, id DESC) = 1
                            THEN 'active' ELSE 'superseded' END AS status
               FROM recovery_key WHERE computer_id = ANY($1::bigint[])) s
      WHERE k.id = s.id AND k.status <> s.status
      RETURNING k.key_id, k.computer_id, k.volume_guid, k.status`,
    [computerIds],
  );
  return rows;
}

/** Live computers a full run did not see (nor any later run). */
export async function countNotSeenSince(db, runId) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM computer
      WHERE deleted_in_ad_at IS NULL AND (last_seen_run IS NULL OR last_seen_run < $1)`,
    [runId],
  );
  return rows[0].n;
}

/** Flags computers a full run did not see as "not in AD" (nothing is deleted). Returns them. */
export async function markNotSeenAsDeleted(db, runId) {
  const { rows } = await db.query(
    `UPDATE computer SET deleted_in_ad_at = now()
      WHERE deleted_in_ad_at IS NULL AND (last_seen_run IS NULL OR last_seen_run < $1)
      RETURNING id, name, object_guid, branch_id, last_seen_run`,
    [runId],
  );
  return rows;
}

// ---- metrics ----------------------------------------------------------------------------------

/** Per-branch (and overall, branch_id NULL) counts used by the anomaly checks and reports. */
export async function collectMetrics(db, runId) {
  const { rows } = await db.query(
    `WITH live AS (
       SELECT c.id, c.branch_id, c.last_seen_run, c.ad_created_at,
              EXISTS (SELECT 1 FROM recovery_key k WHERE k.computer_id = c.id) AS has_key,
              (SELECT count(*) FROM recovery_key k WHERE k.computer_id = c.id) AS keys
         FROM computer c WHERE c.deleted_in_ad_at IS NULL
     )
     SELECT GROUPING(l.branch_id) = 1 AS overall, l.branch_id, b.code AS branch_code,
            count(*) FILTER (WHERE l.last_seen_run = $1)::int AS computers_seen,
            count(*)::int AS computers_in_db,
            coalesce(sum(l.keys), 0)::int AS keys_expected,
            count(*) FILTER (WHERE l.ad_created_at BETWEEN now() - interval '7 days' AND now() - interval '48 hours')::int AS new_computers_7d,
            count(*) FILTER (WHERE l.ad_created_at BETWEEN now() - interval '7 days' AND now() - interval '48 hours' AND NOT l.has_key)::int AS new_without_key,
            round(100.0 * count(*) FILTER (WHERE NOT l.has_key) / greatest(count(*), 1), 2) AS pct_no_key
       FROM live l LEFT JOIN branch b ON b.id = l.branch_id
      GROUP BY GROUPING SETS ((l.branch_id, b.code), ())`,
    [runId],
  );
  return rows;
}

export async function insertMetric(db, runId, m) {
  await db.query(
    `INSERT INTO sync_metric (run_id, branch_id, computers_seen, computers_in_db, keys_seen, keys_expected,
                              keys_empty_pwd, new_computers_7d, new_without_key, pct_no_key, dc_highest_usn)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (run_id, branch_id) DO NOTHING`,
    [
      runId,
      m.branch_id,
      m.computers_seen,
      m.computers_in_db,
      m.keys_seen,
      m.keys_expected,
      m.keys_empty_pwd,
      m.new_computers_7d,
      m.new_without_key,
      m.pct_no_key,
      m.dc_highest_usn ?? null,
    ],
  );
}

/** computers_seen per branch over the last `n` accepted full runs: { [branchId]: number[] }. */
export async function branchBaseline(db, n = 7) {
  const { rows } = await db.query(
    `SELECT m.branch_id, array_agg(m.computers_seen ORDER BY m.run_id DESC) AS seen
       FROM sync_metric m
       JOIN (SELECT id FROM sync_run WHERE mode = 'full' AND status = 'success' ORDER BY id DESC LIMIT $1) r
         ON r.id = m.run_id
      WHERE m.branch_id IS NOT NULL
      GROUP BY m.branch_id`,
    [n],
  );
  return Object.fromEntries(rows.map((r) => [r.branch_id, r.seen]));
}

/** Overall metric rows of recent successful runs, newest first (watchdog trend checks). */
export async function recentOverallMetrics(db, sinceHours) {
  const { rows } = await db.query(
    `SELECT m.*, r.finished_at, r.mode FROM sync_metric m JOIN sync_run r ON r.id = m.run_id
      WHERE m.branch_id IS NULL AND r.status = 'success' AND r.finished_at > now() - make_interval(hours => $1)
      ORDER BY r.id DESC`,
    [sinceHours],
  );
  return rows;
}

/** pct_no_key per branch: latest run vs the latest run at least 7 days older. */
export async function noKeyTrend(db) {
  const { rows } = await db.query(
    `WITH latest AS (SELECT id, finished_at FROM sync_run WHERE status = 'success' ORDER BY id DESC LIMIT 1),
          weekago AS (SELECT r.id FROM sync_run r, latest
                       WHERE r.status = 'success' AND r.finished_at <= latest.finished_at - interval '7 days'
                       ORDER BY r.id DESC LIMIT 1)
     SELECT b.code AS branch_code, now_m.pct_no_key AS now_pct, old_m.pct_no_key AS old_pct
       FROM sync_metric now_m
       JOIN latest ON latest.id = now_m.run_id
       JOIN sync_metric old_m ON old_m.branch_id = now_m.branch_id AND old_m.run_id = (SELECT id FROM weekago)
       JOIN branch b ON b.id = now_m.branch_id`,
  );
  return rows;
}

// ---- heartbeat ------------------------------------------------------------------------------

export async function upsertHeartbeat(db, h) {
  await db.query(
    `INSERT INTO worker_heartbeat (worker_id, at, version, dc_name, ldap_ok, last_error_code, queue_len, dc_cert_expires_at, canary_value)
     VALUES ($1, now(), $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (worker_id) DO UPDATE SET at = now(), version = EXCLUDED.version, dc_name = EXCLUDED.dc_name,
       ldap_ok = EXCLUDED.ldap_ok, last_error_code = EXCLUDED.last_error_code, queue_len = EXCLUDED.queue_len,
       dc_cert_expires_at = EXCLUDED.dc_cert_expires_at, canary_value = EXCLUDED.canary_value`,
    [h.workerId, h.version ?? null, h.dcName ?? null, h.ldapOk ?? null, h.lastErrorCode ?? null, h.queueLen ?? null, h.dcCertExpiresAt ?? null, h.canaryValue ?? null],
  );
}

export async function listHeartbeats(db) {
  const { rows } = await db.query('SELECT * FROM worker_heartbeat ORDER BY at DESC');
  return rows;
}

// ---- manual sync request (Admin HQ -> worker, delivered on the next heartbeat) --------------

export async function setSyncRequest(db, request) {
  await db.query(
    `INSERT INTO app_setting (key, value) VALUES ('sync.requested', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(request)],
  );
}

/** Reads and clears the request atomically, so it is delivered to exactly one heartbeat. */
export async function takeSyncRequest(db) {
  const { rows } = await db.query(
    `WITH old AS (SELECT value FROM app_setting WHERE key = 'sync.requested' FOR UPDATE)
     UPDATE app_setting s SET value = 'null'::jsonb FROM old
      WHERE s.key = 'sync.requested' AND old.value <> 'null'::jsonb
     RETURNING old.value`,
  );
  return rows[0]?.value ?? null;
}

export async function peekSyncRequest(db) {
  const { rows } = await db.query(`SELECT value FROM app_setting WHERE key = 'sync.requested'`);
  const v = rows[0]?.value;
  return v && v !== null ? v : null;
}

// ---- key owner (unjoin / rejoin) and duplicate Key IDs -----------------------------------------

/**
 * The known key with this Key ID: its computer and whether the given password is the stored one.
 * Never returns the password. null when the key is new.
 */
export async function findKeyOwner(db, keyId, password) {
  const { rows } = await db.query(
    `SELECT k.computer_id, c.name, c.distinguished_name, c.deleted_in_ad_at, (k.recovery_password = $2) AS same_password
       FROM recovery_key k JOIN computer c ON c.id = k.computer_id
      WHERE k.key_id = $1`,
    [keyId, password],
  );
  return rows[0] ?? null;
}

/** Flags one computer as no longer in AD (replaced by a new AD object with the same name). */
export async function markComputerReplaced(db, computerId) {
  await db.query('UPDATE computer SET deleted_in_ad_at = now() WHERE id = $1 AND deleted_in_ad_at IS NULL', [computerId]);
}

/**
 * Moves a key to the computer that now holds it in AD (nothing is deleted) and records the change.
 * An open duplicate of this key on the new owner is closed as 'moved'.
 */
export async function moveKey(db, { keyId, fromId, toId, runId, reason }) {
  await db.query('UPDATE recovery_key SET computer_id = $3 WHERE key_id = $1 AND computer_id = $2', [keyId, fromId, toId]);
  await db.query(
    `INSERT INTO key_owner_change (key_id, from_computer_id, to_computer_id, run_id, reason) VALUES ($1, $2, $3, $4, $5)`,
    [keyId, fromId, toId, runId ?? null, reason],
  );
  await db.query(
    `UPDATE key_duplicate SET resolved_at = now(), resolution = 'moved'
      WHERE key_id = $1 AND computer_id = $2 AND resolved_at IS NULL`,
    [keyId, toId],
  );
}

/**
 * Records that a known Key ID was also seen under another computer. One row per (key, computer):
 * seen again => last_seen_at; a pair closed as 'gone' or 'moved' is opened again (and mailed again);
 * a pair Admin HQ marked 'reviewed' stays closed.
 */
export async function recordKeyDuplicate(db, { keyId, computerId, samePassword, runId }) {
  await db.query(
    `INSERT INTO key_duplicate (key_id, computer_id, same_password, first_seen_run) VALUES ($1, $2, $3, $4)
     ON CONFLICT (key_id, computer_id) DO UPDATE SET
       last_seen_at  = now(),
       same_password = EXCLUDED.same_password,
       notified_at   = CASE WHEN key_duplicate.resolution IN ('gone', 'moved') THEN NULL ELSE key_duplicate.notified_at END,
       resolved_at   = CASE WHEN key_duplicate.resolution IN ('gone', 'moved') THEN NULL ELSE key_duplicate.resolved_at END,
       resolution    = CASE WHEN key_duplicate.resolution IN ('gone', 'moved') THEN NULL ELSE key_duplicate.resolution END`,
    [keyId, computerId, samePassword, runId ?? null],
  );
}

/**
 * After a full run has flagged the computers that left AD: open duplicates whose key owner left AD
 * move the key to the other computer (same password only); duplicates whose other computer left AD
 * are closed as 'gone'. Returns { moved: [{ key_id, from_id, to_id }], gone }.
 */
export async function settleKeyDuplicates(db, runId) {
  const { rows: toMove } = await db.query(
    `SELECT d.key_id, k.computer_id AS from_id, d.computer_id AS to_id
       FROM key_duplicate d
       JOIN recovery_key k ON k.key_id = d.key_id
       JOIN computer owner ON owner.id = k.computer_id
       JOIN computer other ON other.id = d.computer_id
      WHERE d.resolved_at IS NULL AND d.same_password
        AND owner.deleted_in_ad_at IS NOT NULL AND other.deleted_in_ad_at IS NULL
      ORDER BY d.id`,
  );
  const moved = [];
  const done = new Set();
  for (const m of toMove) {
    if (done.has(m.key_id)) continue; // a key moves once, to the first live computer seen with it
    done.add(m.key_id);
    await moveKey(db, { keyId: m.key_id, fromId: m.from_id, toId: m.to_id, runId, reason: 'old_not_in_ad' });
    moved.push(m);
  }
  const { rowCount: gone } = await db.query(
    `UPDATE key_duplicate d SET resolved_at = now(), resolution = 'gone'
       FROM computer c
      WHERE c.id = d.computer_id AND d.resolved_at IS NULL AND c.deleted_in_ad_at IS NOT NULL`,
  );
  return { moved, gone };
}

const DUPLICATE_COLUMNS = `
  d.id, d.key_id, d.same_password, d.detected_at, d.last_seen_at, d.notified_at, d.resolved_at, d.resolution, d.resolved_by,
  d.computer_id AS other_id, other.name AS other_name, other.object_guid AS other_guid,
  k.computer_id AS owner_id, owner.name AS owner_name, owner.object_guid AS owner_guid`;
const DUPLICATE_FROM = `
  FROM key_duplicate d
  JOIN recovery_key k ON k.key_id = d.key_id
  JOIN computer owner ON owner.id = k.computer_id
  JOIN computer other ON other.id = d.computer_id`;

/** Open duplicates not mailed yet; marks them mailed. */
export async function takeUnnotifiedDuplicates(db) {
  const { rows } = await db.query(
    `SELECT ${DUPLICATE_COLUMNS} ${DUPLICATE_FROM}
      WHERE d.resolved_at IS NULL AND d.notified_at IS NULL ORDER BY d.id`,
  );
  if (rows.length) await db.query('UPDATE key_duplicate SET notified_at = now() WHERE id = ANY($1::bigint[])', [rows.map((r) => r.id)]);
  return rows;
}

/** Open duplicates (Quan tri > Sync AD). */
export async function listOpenDuplicates(db) {
  const { rows } = await db.query(`SELECT ${DUPLICATE_COLUMNS} ${DUPLICATE_FROM} WHERE d.resolved_at IS NULL ORDER BY d.detected_at`);
  return rows;
}

/** Admin HQ has looked at a duplicate: closed as 'reviewed' (stays closed). Returns the row or null. */
export async function reviewDuplicate(db, id, by) {
  const { rows } = await db.query(
    `UPDATE key_duplicate SET resolved_at = now(), resolution = 'reviewed', resolved_by = $2
      WHERE id = $1 AND resolved_at IS NULL RETURNING id, key_id, computer_id`,
    [id, by],
  );
  return rows[0] ?? null;
}

/** For a computer's page: keys moved to / from it, and Key IDs it shares with another computer. */
export async function keyHistoryOf(db, computerId) {
  const { rows: moves } = await db.query(
    `SELECT m.key_id, m.at, m.reason, m.from_computer_id, f.name AS from_name, f.object_guid AS from_guid,
            m.to_computer_id, t.name AS to_name, t.object_guid AS to_guid
       FROM key_owner_change m
       LEFT JOIN computer f ON f.id = m.from_computer_id
       LEFT JOIN computer t ON t.id = m.to_computer_id
      WHERE m.from_computer_id = $1 OR m.to_computer_id = $1
      ORDER BY m.at DESC`,
    [computerId],
  );
  const { rows: duplicates } = await db.query(
    `SELECT ${DUPLICATE_COLUMNS} ${DUPLICATE_FROM}
      WHERE d.resolved_at IS NULL AND (d.computer_id = $1 OR k.computer_id = $1)`,
    [computerId],
  );
  return { moves, duplicates };
}
