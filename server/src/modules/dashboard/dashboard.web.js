import { Router } from 'express';
import { lineChart } from '../../web/charts.js';

const dayLabel = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
/** Branches shown in "Theo chi nhanh" before "Xem tat ca". */
const BRANCH_LIMIT = 10;
const num = (n) => Number(n).toLocaleString('vi-VN');

/** /dashboard */
export function dashboardWeb({ dashboard }) {
  const r = Router();
  r.get('/', async (req, res) => {
    const data = await dashboard.get(req.scope);
    const series = (rows, key, unit, opts) =>
      lineChart(rows.map((d) => ({ label: dayLabel(d.day), value: d[key], tip: `${num(d[key])} ${unit}` })), opts);
    const charts = {
      reveals: data.activity ? series(data.activity.daily, 'reveals', 'lượt hiện key', { zeroBased: true }) : null,
      computers: series(data.inventoryDaily, 'computers', 'máy', { zeroBased: false, width: 480, height: 220 }),
      keys: series(data.inventoryDaily, 'keys', 'key', { zeroBased: false, width: 480, height: 220 }),
    };
    res.render('dashboard', {
      title: 'Tổng quan', ...data, charts, branchLimit: BRANCH_LIMIT, allBranches: req.query.branches === 'all',
    });
  });
  return r;
}
