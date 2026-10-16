import { Router } from 'express';
import { z } from 'zod';
import { checkbox, id, page, parse } from '../../http/validate.js';
import { clientInfo, noStore } from '../../http/security.js';
import { sendCsv } from '../../http/csv.js';

const day = z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid_date').optional());

/** Query string of the computer list / search (shared by the page and the API). */
export const computerQuery = z.object({
  q: z.string().max(100).default(''),
  page,
  // A branch id, or "na": computers in no branch (outside every branch OU; Admin HQ only).
  branchId: z.preprocess(
    (v) => (v === '' ? undefined : typeof v === 'string' ? v.toLowerCase() : v),
    z.union([z.literal('na'), z.coerce.number().int().positive()]).optional(),
  ),
  status: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['all', 'no_key']).default('all')),
  includeDeleted: checkbox,
  // Appeared between from and to (YYYY-MM-DD, inclusive, in APP_TZ), by the date recorded in this
  // system ("seen", default) or the creation date in AD ("ad").
  dateField: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['seen', 'ad']).default('seen')),
  from: day,
  to: day,
});

const keySearchQuery = z.object({ keyId: z.string().min(2).max(40) });

/** /api/computers, /api/keys/search — metadata only, never key values. */
export function computersApi({ computers }) {
  const r = Router();

  // With ?q=: search (Key ID or name prefix, logged). Without: list everything in scope, filtered.
  // ?format=csv: the whole filtered list as CSV (logged).
  r.get('/computers', noStore, async (req, res) => {
    const { q, page: p, ...filters } = parse(computerQuery, req.query);
    if (req.query.format === 'csv') return sendCsv(res, 'computers', await computers.exportCsv(req.scope, filters, clientInfo(req)));
    if (q.trim()) return res.json(await computers.search(req.scope, q, p, clientInfo(req)));
    const { branches, ...list } = await computers.list(req.scope, filters, p); // eslint-disable-line no-unused-vars
    res.json(list);
  });

  r.get('/keys/search', async (req, res) => {
    const { keyId } = parse(keySearchQuery, req.query);
    res.json(await computers.search(req.scope, keyId, 1, clientInfo(req)));
  });

  r.get('/computers/:id', async (req, res) => {
    res.json(await computers.get(req.scope, parse(id, req.params.id), clientInfo(req)));
  });

  // Hand-entered fields: { deviceSerial, ownerEmail } (empty / null clears one).
  r.put('/computers/:id/info', async (req, res) =>
    res.json(await computers.updateInfo(req.scope, parse(id, req.params.id), req.body, clientInfo(req))),
  );

  return r;
}
