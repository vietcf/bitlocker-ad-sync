import { Router } from 'express';
import { id, parse } from '../../http/validate.js';
import { clientInfo } from '../../http/security.js';
import { flash } from '../../web/middleware.js';

/** /admin/sync — sync health, manual run request, quarantine decisions. */
export function syncWeb({ syncAdmin }) {
  const r = Router();

  r.get('/', async (req, res) => {
    res.render('admin/sync', { title: 'Tình trạng sync', ...(await syncAdmin.status(req.scope)) });
  });

  r.post('/request', async (req, res) => {
    const { mode } = await syncAdmin.requestSync(req.scope, { mode: req.body.mode }, clientInfo(req));
    flash(req, 'success', `Đã yêu cầu sync ${mode}. Worker sẽ chạy ở lần heartbeat tới (tối đa ~5 phút).`);
    res.redirect('/admin/sync');
  });

  r.post('/runs/:id/ack', async (req, res) => {
    const result = await syncAdmin.ack(req.scope, parse(id, req.params.id), { decision: req.body.decision }, clientInfo(req));
    flash(
      req,
      'success',
      result.decision === 'accept'
        ? `Đã chấp nhận lượt sync. ${result.markedDeleted} máy được gắn nhãn "Không còn trong AD" (dữ liệu và key vẫn giữ).`
        : 'Đã bác bỏ lượt sync. Không thay đổi nào được áp dụng.',
    );
    res.redirect('/admin/sync');
  });

  r.post('/key-duplicates/:id/review', async (req, res) => {
    await syncAdmin.reviewKeyDuplicate(req.scope, parse(id, req.params.id), clientInfo(req));
    flash(req, 'success', 'Đã đánh dấu Key ID trùng là đã xem xét. Cặp máy này sẽ không được cảnh báo lại.');
    res.redirect('/admin/sync');
  });

  return r;
}
