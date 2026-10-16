import { Router } from 'express';
import { z } from 'zod';
import { clientInfo, noStore } from '../../http/security.js';
import { parse } from '../../http/validate.js';
import { sendXlsx } from '../../http/xlsx.js';

/** /api/reports/* */
export function reportsApi({ reports }) {
  const r = Router();
  r.get('/summary', noStore, async (req, res) => {
    if (req.query.format === 'xlsx') {
      const { buffer } = await reports.exportXlsx(req.scope, req.query, clientInfo(req));
      return sendXlsx(res, 'bao-cao-bitlocker', buffer);
    }
    const { branchOptions, ...report } = await reports.summary(req.scope, req.query); // eslint-disable-line no-unused-vars
    res.json(report);
  });
  r.get('/no-key', async (req, res) => res.json({ items: await reports.noKey(req.scope) }));
  r.get('/reveals', async (req, res) => {
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
    res.json(await reports.reveals(req.scope, days));
  });
  return r;
}
