import { Router } from 'express';
import { id, parse } from '../../http/validate.js';
import { clientInfo } from '../../http/security.js';
import { AppError } from '../../http/errors.js';
import { flash } from '../../web/middleware.js';
import { errorText } from '../../web/messages.js';
import { runRef } from './run-ref.js';

/** /admin/sync — sync health, manual run request, quarantine decisions. */
export function syncWeb({ syncAdmin }) {
  const r = Router();

  // A refusal on a decision button (e.g. no newer computer to give the key to): say why on the same page, not an error page.
  const refusal = (handler) => async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof AppError && err.status === 400) {
        flash(req, 'error', errorText(err));
        return res.redirect('/admin/sync');
      }
      return next(err);
    }
    return undefined;
  };

  r.get('/', async (req, res) => {
    res.render('admin/sync', { title: 'Tình trạng sync', ...(await syncAdmin.status(req.scope, { page: req.query.page })), query: {} });
  });

  r.post('/request', async (req, res) => {
    const { mode } = await syncAdmin.requestSync(req.scope, { mode: req.body.mode }, clientInfo(req));
    flash(req, 'success', `Đã yêu cầu sync ${mode}. Worker sẽ chạy ở lần heartbeat tới (tối đa ~5 phút).`);
    res.redirect('/admin/sync');
  });

  r.get('/runs/:id', async (req, res) => {
    const p = await syncAdmin.runPreview(req.scope, parse(id, req.params.id));
    res.render('admin/sync-run', { title: `Lượt sync ${runRef(p.run.id, p.run.started_at)}`, ...p });
  });

  r.post('/runs/:id/ack', async (req, res) => {
    const result = await syncAdmin.ack(req.scope, parse(id, req.params.id), { decision: req.body.decision }, clientInfo(req));
    flash(
      req,
      'success',
      result.decision === 'accept'
        ? `Đã chấp nhận lượt sync. ${result.markedDeleted} máy được gắn nhãn "Không còn trong phạm vi giám sát" (dữ liệu và key vẫn giữ).`
        : 'Đã bác bỏ lượt sync. Không thay đổi nào được áp dụng.',
    );
    res.redirect('/admin/sync');
  });

  r.post('/alerts/:id/ack', refusal(async (req, res) => {
    const a = await syncAdmin.ackAlert(req.scope, parse(id, req.params.id), { note: req.body.note || undefined }, clientInfo(req));
    flash(req, 'success', `Đã đóng cảnh báo. Theo dõi lại sau ${a.hours} giờ; nếu lúc đó điều kiện còn thì báo lại.`);
    res.redirect('/admin/sync');
  }));

  r.post('/alerts/:id/snooze', refusal(async (req, res) => {
    const a = await syncAdmin.snoozeAlert(req.scope, parse(id, req.params.id), { days: req.body.days, note: req.body.note || undefined }, clientInfo(req));
    flash(req, 'success', `Đã bỏ qua cảnh báo đến ${a.snoozed_until.toLocaleString('vi-VN')}. Hết hạn mà điều kiện còn thì báo lại.`);
    res.redirect('/admin/sync');
  }));

  r.post('/key-duplicates/:id/review', refusal(async (req, res) => {
    const out = await syncAdmin.reviewKeyDuplicate(req.scope, parse(id, req.params.id), { action: req.body.action }, clientInfo(req));
    flash(
      req,
      'success',
      out.result === 'moved'
        ? `Máy ${out.to} được tạo trên AD mới hơn ${out.from}, nên key đã được gán cho ${out.to} (máy cũ vẫn giữ lịch sử). Cặp này đã đóng.`
        : `Đã đánh dấu Key ID dùng chung giữa ${out.from} và ${out.to}. Key vẫn giữ ở ${out.from}; trang của cả 2 máy hiển thị ghi chú. Cặp này đã đóng.`,
    );
    res.redirect('/admin/sync');
  }));

  return r;
}
