import { Router } from 'express';
import { parse, uuid } from '../../http/validate.js';
import { clientInfo, noStore } from '../../http/security.js';
import { sendCsv } from '../../http/csv.js';
import { computerQuery } from '../computers/computers.api.js';

/** /api/keys/:keyId/reveal and /api/keys/export. POST + no-store (never cached or proxied). */
export function keysApi({ keys }) {
  const r = Router();

  r.get('/reveal-options', async (req, res) => {
    res.json({ reasons: await keys.reasons(), ticketRequired: await keys.ticketRequired() });
  });

  // Keys with their passwords for the computers matching the list filters (Quan tri > Tinh nang decides who).
  // Body: { branchId?, status?, includeDeleted?, reason, reasonNote?, ticketNo? }. Answers CSV.
  r.post('/export', noStore, async (req, res) => {
    const { q, page: p, ...filters } = parse(computerQuery, req.body ?? {}); // eslint-disable-line no-unused-vars
    const { csv } = await keys.exportKeys(req.scope, filters, req.body, clientInfo(req));
    sendCsv(res, 'recovery-keys', csv);
  });

  r.post('/:keyId/reveal', noStore, async (req, res) => {
    res.json(await keys.reveal(req.scope, parse(uuid, req.params.keyId), req.body, clientInfo(req)));
  });

  return r;
}
