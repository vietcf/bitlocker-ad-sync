// Server-side geometry for small SVG charts (no client JS). Templates only draw what this returns.

/** "Nice" upper bound and tick step for a 0-based axis: 0, step, 2*step ... >= max. */
export function niceScale(max, maxTicks = 4) {
  if (max <= 0) return { top: 4, step: 1 };
  const raw = max / maxTicks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const stepInt = Math.max(1, Math.round(step));
  return { top: Math.ceil(max / stepInt) * stepInt, step: stepInt };
}

/** Nice [lo, hi] and step around [min, max] for an axis that need not start at 0 (lo >= 0). */
export function niceRange(min, max, maxTicks = 4) {
  if (max <= min) {
    const { step } = niceScale(Math.max(1, max), maxTicks);
    const lo = Math.max(0, Math.floor(min / step) * step - step);
    return { lo, hi: lo + step * 2, step };
  }
  const { step } = niceScale(max - min, maxTicks);
  const lo = Math.max(0, Math.floor(min / step) * step);
  const hi = Math.ceil(max / step) * step;
  return { lo, hi: hi > lo ? hi : lo + step, step };
}

/**
 * Line chart over evenly spaced days, one series.
 * points: [{ label, value, tip }]. zeroBased: the axis starts at 0 (counts of events); otherwise it
 * fits the data, so a small change in a large total stays visible (inventory).
 * -> { width, height, plot, line, points: [{ cx, cy, hit, tipBox }], ticks, labels, last }
 */
export function lineChart(points, { zeroBased = true, width = 720, height = 220, left = 48, right = 16, top = 16, bottom = 28 } = {}) {
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const base = top + plotH;
  const values = points.map((p) => p.value);
  let lo = 0;
  let hi;
  let step;
  if (zeroBased) ({ top: hi, step } = niceScale(Math.max(0, ...values)));
  else ({ lo, hi, step } = niceRange(Math.min(...values), Math.max(...values)));
  const n = points.length;
  const gap = n > 1 ? plotW / (n - 1) : 0;
  const yOf = (v) => base - ((v - lo) / (hi - lo)) * plotH;

  const pts = points.map((p, i) => {
    const cx = n > 1 ? left + gap * i : left + plotW / 2;
    const cy = yOf(p.value);
    const hitW = n > 1 ? gap : plotW; // hover target: the plot column around this day
    const w = 120; // tooltip box 120 x 36, kept inside the chart
    const x = Math.min(Math.max(cx - w / 2, left), width - right - w);
    const y = cy - 46 < 0 ? cy + 10 : cy - 46;
    return { ...p, cx, cy, hit: { x: cx - hitW / 2, w: hitW }, tipBox: { x, y, w, h: 36 } };
  });
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join('');

  const ticks = [];
  for (let v = lo; v <= hi; v += step) ticks.push({ value: v, y: yOf(v) });

  // About one label per 48px, counted back from the last day (always labelled).
  const every = Math.max(1, Math.ceil(48 / Math.max(gap, 1)));
  const labels = pts
    .map((p, i) => ({ text: p.label, x: p.cx, show: (n - 1 - i) % every === 0 }))
    .filter((l) => l.show);

  return { width, height, plot: { left, right: width - right, top, base }, line, points: pts, ticks, labels, last: pts.at(-1) ?? null };
}
