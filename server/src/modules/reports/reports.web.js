import { Router } from 'express';
import { clientInfo, noStore } from '../../http/security.js';
import { sendXlsx } from '../../http/xlsx.js';

/** /reports */
export function reportsWeb({ reports }) {
  const r = Router();
  r.get('/', async (req, res) => {
    const report = await reports.summary(req.scope, req.query);
    res.render('reports/index', { title: 'Báo cáo', report, query: req.query });
  });
  r.get('/export.xlsx', noStore, async (req, res) => {
    const { buffer } = await reports.exportXlsx(req.scope, req.query, clientInfo(req));
    sendXlsx(res, 'bao-cao-bitlocker', buffer);
  });
  return r;
}
