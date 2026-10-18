import { z } from 'zod';
import { withScope } from '../../db/scoped.js';
import { branchesFor } from '../../domain/scope.js';
import { isWithinWorkingHours } from '../../domain/time.js';
import { badRequest, forbidden } from '../../http/errors.js';
import { parse } from '../../http/validate.js';
import { toXlsx } from '../../http/xlsx.js';
import { REASON_LABELS } from '../keys/keys.service.js';
import { branchList, computersWithKey, computersWithoutKey, earliestDay, existingBranches, inventoryByBranch, revealsInPeriod, revealStats } from './reports.repo.js';

const MAX_DAYS = 366;
/** A computer recorded within this many days may still be waiting for BitLocker / the GPO: "new". */
export const NO_KEY_NEW_DAYS = 7;
const day = z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid_date').optional());

/** Query of the report page / API / Excel export. */
export const reportQuery = z.object({
  from: day,
  to: day,
  branchId: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional()),
  // 'all': all time (from the first day with data); from / to are then ignored.
  period: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['all']).optional()),
});

const dateIn = (date, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date); // YYYY-MM-DD
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const ratio = (a, b) => (b ? a / b : null);

/** Read-only reports for leads, Admin HQ and auditors (no key values anywhere). */
export class ReportsService {
  constructor({ pool, audit = null, settings = null, tz = 'Asia/Ho_Chi_Minh', now = () => new Date() }) {
    this.pool = pool;
    this.audit = audit;
    this.settings = settings;
    this.tz = tz;
    this.now = now;
  }

  #branches(scope) {
    const branches = branchesFor(scope, 'reports');
    if (branches !== 'all' && branches.length === 0) throw forbidden();
    return branches;
  }

  noKey(scope) {
    const branches = this.#branches(scope);
    return withScope(this.pool, branches, (tx) => computersWithoutKey(tx, branches));
  }

  reveals(scope, days = 30) {
    const branches = this.#branches(scope);
    // Reading the log needs the log scope, which equals the reports scope for every role.
    return withScope(this.pool, branches, (tx) => revealStats(tx, branches, days));
  }

  /**
   * Normalised filters: the last 30 days by default; at most MAX_DAYS; a branch only within scope.
   * period=all: all time up to today (from is set by summary() to the first day with data).
   */
  filters(rawQuery) {
    const q = parse(reportQuery, rawQuery ?? {});
    const today = dateIn(this.now(), this.tz);
    if (q.period === 'all') return { all: true, from: null, to: today, branchId: q.branchId ?? null };
    const to = q.to ?? today;
    const from = q.from ?? addDays(to, -29);
    if (from > to) throw badRequest('invalid_request', 'The start date is after the end date.');
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 > MAX_DAYS) {
      throw badRequest('invalid_request', `The period is longer than ${MAX_DAYS} days.`);
    }
    return { from, to, branchId: q.branchId ?? null };
  }

  /**
   * The report: totals, one row per branch (inventory now + changes and reveals in the period),
   * reveals per branch and user, and the computers without a key. Only within the caller's scope,
   * narrowed to one branch when branchId is set (a branch outside the scope gives an empty report).
   */
  async summary(scope, rawQuery, { withKeyList = false } = {}) {
    const all = this.#branches(scope);
    const f = this.filters(rawQuery);
    const inScope = all === 'all' || (f.branchId && all.includes(f.branchId));
    const branches = f.branchId ? (inScope ? [f.branchId] : []) : all;
    const hours = this.settings ? await this.settings.get('reveal.working_hours', null) : null;

    const data = branches.length === 0
      ? { list: [], existing: [], inventory: [], reveals: [], noKey: [], options: [] }
      : await withScope(this.pool, branches, async (tx) => {
        if (f.all) f.from = (await earliestDay(tx, branches, this.tz)) ?? f.to;
        const period = { from: f.from, to: f.to, tz: this.tz };
        const list = await branchList(tx, branches);
        return {
          options: await branchList(tx, all),
          list,
          existing: await existingBranches(tx, branches),
          inventory: await inventoryByBranch(tx, branches, period),
          reveals: await revealsInPeriod(tx, branches, period),
          noKey: await computersWithoutKey(tx, branches),
          // Computers that have keys, with their key counts: for the Excel file of one branch only.
          withKey: withKeyList && (f.branchId || list.length <= 1) ? await computersWithKey(tx, branches) : null,
        };
      });
    f.from ??= f.to;

    // One row per active branch in scope, plus N/A when computers or reveals have no branch.
    const fresh = (id, code = null, name = null) => ({
      branch_id: id, branch_code: code, branch_name: name,
      computers: 0, with_key: 0, no_key: 0, keys: 0, new_computers: 0, new_keys: 0, left_ad: 0,
      reveals: 0, exported: 0, out_of_hours: hours ? 0 : null, users: new Set(), devices: new Set(), reasons: {},
    });
    const rows = new Map(data.list.map((b) => [b.id, fresh(b.id, b.code, b.name)]));
    // The access log keeps the id of a branch that was deleted since: every such id is counted in the
    // one N/A row (like the computers the deletion moved to no branch), not one N/A row per old id.
    const existing = new Map(data.existing.map((b) => [b.id, b]));
    const row = (rawId) => {
      const id = rawId !== null && existing.has(rawId) ? rawId : null;
      if (!rows.has(id)) {
        const b = id === null ? null : existing.get(id);
        rows.set(id, fresh(id, b?.code ?? null, b?.name ?? null));
      }
      return rows.get(id);
    };
    for (const inv of data.inventory) Object.assign(row(inv.branch_id), inv);

    const users = new Map();
    for (const l of data.reveals) {
      const r = row(l.branch_id);
      r.reveals += 1;
      if (l.exported) r.exported += 1;
      if (hours && !isWithinWorkingHours(new Date(l.at), hours)) r.out_of_hours += 1;
      r.users.add(l.user_upn);
      if (l.computer_id) r.devices.add(String(l.computer_id));
      if (l.reason) r.reasons[l.reason] = (r.reasons[l.reason] ?? 0) + 1;
      const uk = `${r.branch_id ?? 'na'}|${l.user_upn}`;
      const u = users.get(uk) ?? { branch_id: r.branch_id, user_upn: l.user_upn, reveals: 0, devices: new Set(), last_at: null };
      u.reveals += 1;
      if (l.computer_id) u.devices.add(String(l.computer_id));
      u.last_at = l.at;
      users.set(uk, u);
    }

    const byBranch = [...rows.values()]
      .map(({ users: us, devices, reasons, ...r }) => {
        const top = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0];
        return {
          ...r,
          coverage: ratio(r.with_key, r.computers),
          reveal_users: us.size,
          reveal_computers: devices.size,
          reasons,
          top_reason: top ? top[0] : null,
        };
      })
      .sort((a, b) => b.computers - a.computers || b.reveals - a.reveals || String(a.branch_code ?? '~').localeCompare(String(b.branch_code ?? '~')));

    const codeOf = new Map(byBranch.map((b) => [b.branch_id, b]));
    const revealUsers = [...users.values()]
      .map(({ devices, ...u }) => ({ ...u, branch_code: codeOf.get(u.branch_id)?.branch_code ?? null, computers: devices.size }))
      .sort((a, b) => String(a.branch_code ?? '~').localeCompare(String(b.branch_code ?? '~')) || b.reveals - a.reveals);

    const sum = (k) => byBranch.reduce((n, b) => n + (b[k] ?? 0), 0);
    const totals = {
      branches: data.list.length,
      computers: sum('computers'),
      withKey: sum('with_key'),
      noKey: sum('no_key'),
      keys: sum('keys'),
      newComputers: sum('new_computers'),
      newKeys: sum('new_keys'),
      leftAd: sum('left_ad'),
      reveals: data.reveals.length,
      exported: sum('exported'),
      outOfHours: hours ? sum('out_of_hours') : null,
      revealUsers: new Set(data.reveals.map((l) => l.user_upn)).size,
      revealComputers: new Set(data.reveals.filter((l) => l.computer_id).map((l) => String(l.computer_id))).size,
    };
    totals.coverage = ratio(totals.withKey, totals.computers);

    // Computers without a key: days since recorded, "new" (may still be waiting for the GPO) or not,
    // and a summary per branch (the page lists the computers only for one branch).
    const nowMs = this.now().getTime();
    const noKey = data.noKey.map((c) => {
      const days = Math.floor((nowMs - new Date(c.first_seen_at).getTime()) / 86_400_000);
      return { ...c, days_without_key: days, is_new: days <= NO_KEY_NEW_DAYS };
    });
    const nk = new Map();
    for (const c of noKey) {
      const k = c.branch_id ?? 'na';
      const b = nk.get(k) ?? { branch_id: c.branch_id, branch_code: c.branch_code, branch_name: c.branch_name, total: 0, recent: 0, older: 0 };
      b.total += 1;
      b[c.is_new ? 'recent' : 'older'] += 1;
      nk.set(k, b);
    }
    const noKeyByBranch = [...nk.values()].sort((a, b) => b.older - a.older || b.total - a.total
      || String(a.branch_code ?? '~').localeCompare(String(b.branch_code ?? '~')));

    return {
      period: { all: Boolean(f.all), from: f.from, to: f.to, days: (Date.parse(f.to) - Date.parse(f.from)) / 86_400_000 + 1 },
      branchId: f.branchId,
      branchOptions: data.options,
      workingHours: hours,
      generatedAt: this.now(),
      totals,
      branches: byBranch,
      revealUsers,
      noKey,
      noKeyByBranch,
      noKeyNewDays: NO_KEY_NEW_DAYS,
      // List computers only when the report covers one branch; across branches, the summary only.
      noKeyDetail: Boolean(f.branchId) || data.list.length <= 1,
      ...(withKeyList ? { withKey: data.withKey } : {}),
    };
  }

  /** The report as an Excel workbook (no key values). Logged as export_report. Returns { buffer, report }. */
  async exportXlsx(scope, rawQuery, client = {}) {
    const report = await this.summary(scope, rawQuery, { withKeyList: true });
    const buffer = toXlsx(workbook(report, scope), { tz: this.tz });
    if (this.audit) {
      await withScope(this.pool, this.#branches(scope), (tx) => this.audit.append(tx, {
        ...this.audit.actor(scope, client),
        action: 'export_report',
        detail: { all: report.period.all, from: report.period.from, to: report.period.to, branchId: report.branchId, branches: report.branches.length },
      }));
    }
    return { buffer, report };
  }
}

const vnDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const code = (b) => b.branch_code ?? 'N/A';
const H = (v) => ({ v, s: 'header' });
const T = (v) => ({ v, s: 'total' });
const TI = (v) => ({ v, s: 'totalInt' });
const P = (v) => ({ v, s: 'pct' });

function workbook(r, scope) {
  const t = r.totals;
  const period = `${r.period.all ? 'Toàn bộ thời gian, ' : ''}${vnDate(r.period.from)} – ${vnDate(r.period.to)} (${r.period.days} ngày)`;
  const scopeText = r.branchId
    ? `Chi nhánh ${r.branches.find((b) => b.branch_id === r.branchId)?.branch_code ?? r.branchId}`
    : 'Tất cả chi nhánh trong phạm vi của người xuất';
  const reasons = Object.keys(REASON_LABELS);

  const overview = {
    name: 'Tổng quan',
    widths: [40, 18, 60],
    rows: [
      [{ v: 'Báo cáo BitLocker recovery key', s: 'title' }],
      [{ v: `Kỳ báo cáo: ${period}`, s: 'muted' }],
      [{ v: `Phạm vi: ${scopeText}`, s: 'muted' }],
      [{ v: `Người xuất: ${scope.upn} · lúc`, s: 'muted' }, r.generatedAt],
      [],
      [H('Chỉ số'), H('Giá trị'), H('Ghi chú')],
      ['Số chi nhánh', t.branches, 'Chi nhánh đang hoạt động trong phạm vi'],
      ['Máy được giám sát', t.computers, 'Hiện tại, không tính máy đã gắn nhãn "Không còn trong phạm vi giám sát"'],
      ['Máy đã có key', t.withKey],
      ['Máy chưa có key', t.noKey, r.noKeyDetail ? 'Danh sách ở sheet "Máy chưa có key"' : 'Theo chi nhánh ở sheet "Máy chưa có key"; chọn một chi nhánh để xuất danh sách máy'],
      ['Tỉ lệ máy có key', P(t.coverage)],
      ['Số key', t.keys, 'Key của các máy còn trong phạm vi giám sát'],
      [`Máy mới ghi nhận trong kỳ`, t.newComputers],
      [`Key mới ghi nhận trong kỳ`, t.newKeys],
      [`Máy rời phạm vi giám sát trong kỳ`, t.leftAd, 'Gắn nhãn "Không còn trong phạm vi giám sát" trong kỳ'],
      ['Lượt hiện key trong kỳ', t.reveals, 'Kể cả key xuất kèm file'],
      ['  trong đó xuất kèm file', t.exported],
      ['  trong đó ngoài giờ làm việc', t.outOfHours ?? 'Chưa cấu hình giờ làm việc'],
      ['Số người xem key', t.revealUsers],
      ['Số máy được xem key', t.revealComputers],
    ],
  };

  const branchSheet = {
    name: 'Theo chi nhánh',
    widths: [12, 30, 12, 12, 14, 12, 12, 12, 12, 12, 14],
    freeze: 1,
    filterRow: 1,
    rows: [
      [H('Chi nhánh'), H('Tên'), H('Máy'), H('Có key'), H('Chưa có key'), H('% có key'), H('Số key'), H('Máy mới'), H('Key mới'), H('Rời phạm vi'), H('Lượt hiện key')],
      ...r.branches.map((b) => [code(b), b.branch_name ?? 'Máy chưa thuộc chi nhánh nào', b.computers, b.with_key, b.no_key, P(b.coverage), b.keys, b.new_computers, b.new_keys, b.left_ad, b.reveals]),
      [T('Tổng'), T(''), TI(t.computers), TI(t.withKey), TI(t.noKey), { v: t.coverage, s: 'pct' }, TI(t.keys), TI(t.newComputers), TI(t.newKeys), TI(t.leftAd), TI(t.reveals)],
    ],
  };

  const revealSheet = {
    name: 'Xem key theo CN',
    widths: [12, 30, 12, 12, 14, 14, 12, ...reasons.map(() => 16)],
    freeze: 1,
    filterRow: 1,
    rows: [
      [H('Chi nhánh'), H('Tên'), H('Lượt hiện key'), H('Người xem'), H('Máy được xem'), H('Ngoài giờ'), H('Xuất file'), ...reasons.map((k) => H(REASON_LABELS[k]))],
      ...r.branches.map((b) => [code(b), b.branch_name ?? '', b.reveals, b.reveal_users, b.reveal_computers, b.out_of_hours, b.exported, ...reasons.map((k) => b.reasons[k] ?? 0)]),
      [T('Tổng'), T(''), TI(t.reveals), TI(t.revealUsers), TI(t.revealComputers), TI(t.outOfHours), TI(t.exported),
        ...reasons.map((k) => TI(r.branches.reduce((n, b) => n + (b.reasons[k] ?? 0), 0)))],
    ],
  };

  const userSheet = {
    name: 'Người xem key',
    widths: [12, 36, 14, 14, 20],
    freeze: 1,
    filterRow: 1,
    rows: [
      [H('Chi nhánh'), H('Người dùng'), H('Lượt hiện key'), H('Số máy'), H('Lần gần nhất')],
      ...r.revealUsers.map((u) => [u.branch_code ?? 'N/A', u.user_upn, u.reveals, u.computers, new Date(u.last_at)]),
    ],
  };

  const noKeySheet = {
    name: 'Máy chưa có key',
    widths: [12, 24, 28, 18, 30, 16, 16, 14, 60],
    freeze: 1,
    filterRow: 1,
    rows: [
      [H('Chi nhánh'), H('Máy'), H('Hệ điều hành'), H('Serial'), H('Email người dùng'), H('Tạo trên AD'), H('Ghi nhận'), H('Số ngày chưa có key'), H('DN')],
      ...r.noKey.map((c) => [c.branch_code ?? 'N/A', c.name, c.os, c.device_serial, c.owner_email,
        c.ad_created_at ? { v: new Date(c.ad_created_at), s: 'date' } : null, { v: new Date(c.first_seen_at), s: 'date' }, c.days_without_key, c.distinguished_name]),
    ],
  };

  // Mot chi nhanh: cac may da co key va so key cua tung may (dat truoc sheet may chua co key)
  const withKeySheet = r.withKey ? {
    name: 'Máy đã có key',
    widths: [12, 24, 28, 18, 30, 10, 18, 16, 16, 60],
    freeze: 1,
    filterRow: 1,
    rows: [
      [H('Chi nhánh'), H('Máy'), H('Hệ điều hành'), H('Serial'), H('Email người dùng'), H('Số key'), H('Key mới nhất (tạo trên AD)'), H('Tạo trên AD'), H('Ghi nhận'), H('DN')],
      ...r.withKey.map((c) => [c.branch_code ?? 'N/A', c.name, c.os, c.device_serial, c.owner_email, c.keys,
        c.latest_key_at ? { v: new Date(c.latest_key_at), s: 'date' } : null,
        c.ad_created_at ? { v: new Date(c.ad_created_at), s: 'date' } : null, { v: new Date(c.first_seen_at), s: 'date' }, c.distinguished_name]),
      [T('Tổng'), TI(r.withKey.length), T(''), T(''), T(''), TI(r.withKey.reduce((n, c) => n + c.keys, 0)), T(''), T(''), T(''), T('')],
    ],
  } : null;

  // Tat ca chi nhanh: chi tong hop theo chi nhanh, khong liet ke tung may (giong trang bao cao)
  const noKeySummarySheet = {
    name: 'Máy chưa có key',
    widths: [12, 30, 14, 18, 18],
    freeze: 1,
    filterRow: 1,
    rows: [
      [H('Chi nhánh'), H('Tên'), H('Chưa có key'), H(`Lâu hơn ${r.noKeyNewDays} ngày`), H(`Mới (≤ ${r.noKeyNewDays} ngày)`)],
      ...r.noKeyByBranch.map((b) => [code(b), b.branch_name ?? 'Máy chưa thuộc chi nhánh nào', b.total, b.older, b.recent]),
      [T('Tổng'), T(''), TI(r.noKey.length), TI(r.noKeyByBranch.reduce((n, b) => n + b.older, 0)), TI(r.noKeyByBranch.reduce((n, b) => n + b.recent, 0))],
    ],
  };

  return [overview, branchSheet, revealSheet, userSheet, ...(r.noKeyDetail && withKeySheet ? [withKeySheet] : []), r.noKeyDetail ? noKeySheet : noKeySummarySheet];
}
