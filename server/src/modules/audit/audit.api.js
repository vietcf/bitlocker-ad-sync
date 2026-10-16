import { Router } from 'express';
import { z } from 'zod';
import { optionalDate, optionalText, page, parse } from '../../http/validate.js';
import { clientInfo, noStore } from '../../http/security.js';
import { AUDIT_ACTIONS } from './audit.service.js';

export const auditFilters = z.object({
  branchId: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional()),
  user: optionalText(256),
  action: z.preprocess((v) => (v === '' ? undefined : v), z.enum(AUDIT_ACTIONS).optional()),
  computer: optionalText(64),
  from: optionalDate,
  to: optionalDate,
  page,
});

/** /api/audit — log search; ?format=csv downloads the matching rows. */
export function auditApi({ audit }) {
  const r = Router();
  r.get('/', noStore, async (req, res) => {
    const { page: p, ...filters } = parse(auditFilters, req.query);
    if (req.query.format === 'csv') {
      const csv = await audit.exportCsv(req.scope, filters, clientInfo(req));
      res.type('text/csv; charset=utf-8').attachment(`access-log-${new Date().toISOString().slice(0, 10)}.csv`).send(`﻿${csv}`);
      return;
    }
    res.json(await audit.search(req.scope, filters, p));
  });
  return r;
}
