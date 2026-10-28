import { Router } from 'express';
import { clientInfo, noStore } from '../../http/security.js';
import { sendXlsx } from '../../http/xlsx.js';
import { PAGE_SIZES, pageSize, paginate } from '../settings/page-size.js';

/** /reports */
export function reportsWeb({ reports, settings }) {
  const r = Router();
  r.get('/', async (req, res) => {
    const report = await reports.summary(req.scope, req.query);
    // The table of branches lists every branch of the report (also those with no computer or key), page by page.
    const branchPage = paginate(report.branches, req.query.bpage, await pageSize(settings, PAGE_SIZES.report));
    res.render('reports/index', { title: req.t('Báo cáo'), report, branchPage, query: req.query });
  });
  r.get('/export.xlsx', noStore, async (req, res) => {
    const { buffer } = await reports.exportXlsx(req.scope, req.query, clientInfo(req));
    sendXlsx(res, 'bao-cao-bitlocker', buffer);
  });
  return r;
}
