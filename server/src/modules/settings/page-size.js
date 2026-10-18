// How many rows a list shows on one page. Set under Quan tri > Tinh nang ("Hien thi"), read on every
// request (settings cache, 30 s), so a change applies at once without a restart. Defaults apply until changed.

export const PAGE_SIZE_LIMITS = [5, 200];

export const PAGE_SIZES = {
  computers: { key: 'ui.page_size.computers', default: 25, label: 'Tìm máy và danh sách máy' },
  audit: { key: 'ui.page_size.audit', default: 50, label: 'Nhật ký truy cập' },
  mail: { key: 'ui.page_size.mail', default: 50, label: 'Log email' },
  report: { key: 'ui.page_size.report', default: 20, label: 'Báo cáo: chi tiết theo chi nhánh' },
};

/** The page size of a list (a wrong stored value falls back to the default). settings may be null. */
export async function pageSize(settings, spec) {
  const v = Number(settings ? await settings.get(spec.key, spec.default) : spec.default);
  return Number.isInteger(v) && v >= PAGE_SIZE_LIMITS[0] && v <= PAGE_SIZE_LIMITS[1] ? v : spec.default;
}

/** One page of an in-memory list: { rows, page, pages, total, pageSize } (page is kept inside 1..pages). */
export function paginate(list, requestedPage, size) {
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(requestedPage)) || 1));
  return { rows: list.slice((page - 1) * size, page * size), page, pages, total, pageSize: size };
}
