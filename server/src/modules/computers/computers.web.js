import { Router } from 'express';
import { id, parse, uuid } from '../../http/validate.js';
import { clientInfo, noStore } from '../../http/security.js';
import { flash, formAction } from '../../web/middleware.js';
import { sendCsv } from '../../http/csv.js';
import { computerQuery } from './computers.api.js';

/** Home (search + computer list), computer detail, reveal form and result. */
export function computersWeb({ computers, keys }) {
  const r = Router();

  // Search box on top; below it, the search result or (no search term) every computer in scope.
  r.get('/', async (req, res) => {
    const { q, page: p, ...filters } = parse(computerQuery, req.query);
    const result = q.trim() ? await computers.search(req.scope, q, p, clientInfo(req)) : null;
    const list = result ? null : await computers.list(req.scope, filters, p);
    const canExportKeys = await keys.canExportKeys(req.scope);
    res.render('home', { title: 'Tìm máy', q, result, list, filters, query: req.query, canExportKeys });
  });

  // Same filters as the list on the home page.
  r.get('/computers/export.csv', noStore, async (req, res) => {
    const { q, page: p, ...filters } = parse(computerQuery, req.query); // eslint-disable-line no-unused-vars
    sendCsv(res, 'computers', await computers.exportCsv(req.scope, filters, clientInfo(req)));
  });

  // Export with recovery passwords: a form (reason, like a reveal), then the CSV download.
  const renderExportKeys = async (req, res, error) => {
    const source = req.method === 'POST' ? req.body : req.query;
    const { q, page: p, ...filters } = parse(computerQuery, source); // eslint-disable-line no-unused-vars
    const preview = await keys.exportPreview(req.scope, filters);
    const { branches } = await computers.list(req.scope, {}, 1);
    res.render('computers/export-keys', {
      title: 'Xuất kèm recovery key',
      filters,
      preview,
      branchName: branches.find((b) => b.id === filters.branchId)?.code ?? null,
      query: { branchId: source.branchId, status: source.status, includeDeleted: source.includeDeleted, activity: source.activity },
      reasons: await keys.reasons(),
      ticketRequired: await keys.ticketRequired(),
      form: req.method === 'POST' ? req.body : {},
      error,
    });
  };
  r.get('/computers/export-keys', noStore, (req, res) => renderExportKeys(req, res, null));
  r.post('/computers/export-keys', noStore, formAction(async (req, res) => {
    const { q, page: p, ...filters } = parse(computerQuery, req.body); // eslint-disable-line no-unused-vars
    const { csv } = await keys.exportKeys(req.scope, filters, req.body, clientInfo(req));
    sendCsv(res, 'recovery-keys', csv);
  }, renderExportKeys));

  r.get('/computers/:id', noStore, async (req, res) => {
    const { computer, keys: keyList, keyHistory } = await computers.get(req.scope, parse(id, req.params.id), clientInfo(req));
    res.render('computers/show', { title: computer.name, computer, keys: keyList, keyHistory, highlight: req.query.key ?? null });
  });

  // Machine serial and user e-mail of the computer (typed by IT, never from AD).
  const renderComputerInfo = async (req, res, error) => {
    const computer = await computers.getInfo(req.scope, parse(id, req.params.id));
    const form = error
      ? req.body
      : { deviceSerial: computer.device_serial ?? '', ownerEmail: computer.owner_email ?? '' };
    res.render('computers/edit-info', { title: `Thông tin máy · ${computer.name}`, computer, form, error });
  };
  r.get('/computers/:id/edit', (req, res) => renderComputerInfo(req, res, null));
  r.post('/computers/:id/edit', formAction(async (req, res) => {
    const computerId = parse(id, req.params.id);
    await computers.updateInfo(req.scope, computerId, req.body, clientInfo(req));
    flash(req, 'success', 'Đã lưu thông tin máy.');
    res.redirect(`/computers/${computerId}`);
  }, renderComputerInfo));

  const renderRevealForm = async (req, res, error) => {
    const computerId = parse(id, req.params.id);
    const keyId = parse(uuid, req.params.keyId);
    res.render('computers/reveal-form', {
      title: 'Hiện recovery key',
      computerId,
      keyId,
      reasons: await keys.reasons(),
      ticketRequired: await keys.ticketRequired(),
      form: req.body ?? {},
      error,
    });
  };

  r.get('/computers/:id/keys/:keyId/reveal', noStore, (req, res) => renderRevealForm(req, res, null));

  r.post(
    '/computers/:id/keys/:keyId/reveal',
    noStore,
    formAction(async (req, res) => {
      const result = await keys.reveal(req.scope, parse(uuid, req.params.keyId), req.body, clientInfo(req));
      res.render('computers/reveal', { title: `Recovery key · ${result.computerName}`, result });
    }, renderRevealForm),
  );

  return r;
}
