// Checks that run when a sync reports success but its data may be wrong
// (design doc: "Phat hien du lieu bat thuong khi sync van bao thanh cong").
// Pure functions: metrics in, list of findings out.

/** Median of a list of numbers (null for an empty list). */
export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * metrics:  { mode, overall: {computers_seen, computers_in_db, keys_seen, keys_expected, keys_empty_pwd},
 *             branches: [{ branch_id, branch_code, computers_seen }], plannedDeletes, liveComputers }
 * baseline: { branchSeen: { [branchId]: number[] } }  (computers_seen of the last accepted full runs)
 * t:        thresholds from app_setting (anomaly.* and full_sync.max_delete_ratio)
 * Returns [{ code, message, detail }]: `message` is English (API, logs); anomalyText() gives the Vietnamese UI text.
 */
export function checkRun(metrics, baseline, t) {
  const found = [];
  const o = metrics.overall;

  if (o.keys_empty_pwd > 0) {
    found.push({
      code: 'key_attr_unreadable',
      message: `${o.keys_empty_pwd} keys were read without their password: the sync account may have lost read access to the confidential attribute.`,
      detail: { keysEmptyPwd: o.keys_empty_pwd },
    });
  }

  if (metrics.mode !== 'full') return found;

  if (o.computers_in_db > 0) {
    const ratio = o.computers_seen / o.computers_in_db;
    if (ratio < t.minComputerRatio) {
      found.push({
        code: 'computers_drop',
        message: `The full run saw only ${o.computers_seen}/${o.computers_in_db} computers (${pct(ratio)}), below the ${pct(t.minComputerRatio)} threshold.`,
        detail: { seen: o.computers_seen, inDb: o.computers_in_db, threshold: t.minComputerRatio },
      });
    }
  }

  if (o.keys_expected > 0) {
    const ratio = o.keys_seen / o.keys_expected;
    if (ratio < t.minKeyRatio) {
      found.push({
        code: 'keys_drop',
        message: `The full run saw only ${o.keys_seen}/${o.keys_expected} keys (${pct(ratio)}), below the ${pct(t.minKeyRatio)} threshold.`,
        detail: { seen: o.keys_seen, expected: o.keys_expected, threshold: t.minKeyRatio },
      });
    }
  }

  for (const b of metrics.branches) {
    const base = median(baseline.branchSeen[b.branch_id] ?? []);
    if (base === null || base === 0) continue;
    const drop = base - b.computers_seen;
    if (drop > t.branchDropMin && drop / base > t.branchDropRatio) {
      found.push({
        code: 'branch_drop',
        message: `Branch ${b.branch_code}: ${b.computers_seen} computers seen, usually ${base} (down ${pct(drop / base)}).`,
        detail: { branch: b.branch_code, seen: b.computers_seen, baseline: base },
      });
    }
  }

  if (metrics.liveComputers > 0 && metrics.plannedDeletes / metrics.liveComputers > t.maxDeleteRatio) {
    found.push({
      code: 'mass_delete',
      message: `The full run did not see ${metrics.plannedDeletes}/${metrics.liveComputers} computers (over ${pct(t.maxDeleteRatio)}); if accepted they are flagged "no longer in the monitored scope" (no data is deleted, keys are kept).`,
      detail: { planned: metrics.plannedDeletes, live: metrics.liveComputers, threshold: t.maxDeleteRatio },
    });
  }
  return found;
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

/** Vietnamese text of a finding for the web UI and alert e-mails (falls back to the English message). */
export function anomalyText(a) {
  const d = a.detail ?? {};
  const limit = d.threshold === undefined ? '' : `, ngưỡng ${pct(d.threshold)}`;
  switch (a.code) {
    case 'key_attr_unreadable':
      return `${d.keysEmptyPwd} key đọc được nhưng mật khẩu rỗng: tài khoản sync có thể đã mất quyền đọc thuộc tính confidential.`;
    case 'computers_drop':
      return `Lượt full chỉ thấy ${d.seen}/${d.inDb} máy (${pct(d.seen / d.inDb)}${limit}).`;
    case 'keys_drop':
      return `Lượt full chỉ thấy ${d.seen}/${d.expected} key (${pct(d.seen / d.expected)}${limit}).`;
    case 'branch_drop':
      return `Chi nhánh ${d.branch}: thấy ${d.seen} máy, mức bình thường ${d.baseline}.`;
    case 'mass_delete':
      return `Lượt full không thấy ${d.planned}/${d.live} máy trong phạm vi giám sát (${pct(d.planned / d.live)}${limit}); nếu chấp nhận, các máy này được gắn nhãn "Không còn trong phạm vi giám sát" (không xóa dữ liệu, key vẫn giữ).`;
    default:
      return a.message;
  }
}

/** Reads thresholds from settings with the design-doc defaults. */
export async function loadThresholds(settings) {
  const n = async (key, d) => Number(await settings.get(key, d));
  return {
    minComputerRatio: await n('anomaly.min_computer_ratio', 0.95),
    branchDropRatio: await n('anomaly.branch_drop_ratio', 0.2),
    branchDropMin: await n('anomaly.branch_drop_min', 10),
    minKeyRatio: await n('anomaly.min_key_ratio', 0.95),
    escrowRatio: await n('anomaly.escrow_ratio', 0.5),
    escrowMinNew: await n('anomaly.escrow_min_new', 5),
    noKeyPpIncrease: await n('anomaly.no_key_pp_increase', 5),
    usnStallHours: await n('anomaly.usn_stall_hours', 6),
    canaryMaxAgeMinutes: await n('anomaly.canary_max_age_minutes', 90),
    maxDeleteRatio: await n('full_sync.max_delete_ratio', 0.05),
  };
}
