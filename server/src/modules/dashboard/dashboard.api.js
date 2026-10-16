import { Router } from 'express';

/** /api/dashboard — the same numbers as the Tong quan page. */
export function dashboardApi({ dashboard }) {
  const r = Router();
  r.get('/', async (req, res) => res.json(await dashboard.get(req.scope)));
  return r;
}
