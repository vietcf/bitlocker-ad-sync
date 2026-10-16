/** CSV cell with formula-injection protection (Excel treats =,+,-,@ as formulas). */
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV text (CRLF line ends) from a header and rows of values. */
export function toCsv(header, rows) {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Sends CSV as a download. The BOM makes Excel read it as UTF-8 (Vietnamese names). */
export function sendCsv(res, name, csv) {
  res.type('text/csv; charset=utf-8').attachment(`${name}-${new Date().toISOString().slice(0, 10)}.csv`).send(`﻿${csv}`);
}
