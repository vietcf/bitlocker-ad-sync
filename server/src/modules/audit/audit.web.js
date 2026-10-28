import { Router } from 'express';
import { parse } from '../../http/validate.js';
import { clientInfo, noStore } from '../../http/security.js';
import { auditFilters } from './audit.api.js';
import { AUDIT_ACTIONS } from './audit.service.js';

/** /audit (log search) and /audit/export.csv */
export function auditWeb({ audit }) {
  const r = Router();

  r.get('/', noStore, async (req, res) => {
    const { page, ...filters } = parse(auditFilters, req.query);
    const [result, branches] = await Promise.all([audit.search(req.scope, filters, page), audit.branchOptions(req.scope)]);
    res.render('audit/index', { title: req.t('Nhật ký truy cập'), result, filters, branches, actions: AUDIT_ACTIONS, query: req.query });
  });

  r.get('/export.csv', noStore, async (req, res) => {
    const { page, ...filters } = parse(auditFilters, req.query); // eslint-disable-line no-unused-vars
    const csv = await audit.exportCsv(req.scope, filters, clientInfo(req));
    res.type('text/csv; charset=utf-8').attachment(`access-log-${new Date().toISOString().slice(0, 10)}.csv`).send(`﻿${csv}`);
  });

  return r;
}
