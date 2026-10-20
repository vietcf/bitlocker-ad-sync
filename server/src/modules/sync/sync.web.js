import { Router } from 'express';
import { id, parse } from '../../http/validate.js';
import { clientInfo } from '../../http/security.js';
import { flash } from '../../web/middleware.js';
import { runRef } from './run-ref.js';

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

  r.post('/alerts/:id/ack', async (req, res) => {
    const a = await syncAdmin.ackAlert(req.scope, parse(id, req.params.id), { note: req.body.note || undefined }, clientInfo(req));
    flash(req, 'success', a.silences
      ? 'Đã đánh dấu cảnh báo là đã xử lý. Sẽ không gửi mail nữa; cảnh báo tự đóng khi điều kiện hết, và báo lại nếu tái phát.'
      : 'Đã ghi nhận bạn đã xem cảnh báo này. Đây là lỗi đo trực tiếp nên vẫn hiện cho đến khi hết sự cố.');
    res.redirect('/admin/sync');
  });

  r.post('/alerts/:id/snooze', async (req, res) => {
    const a = await syncAdmin.snoozeAlert(req.scope, parse(id, req.params.id), { days: req.body.days, note: req.body.note || undefined }, clientInfo(req));
    flash(req, 'success', `Đã bỏ qua cảnh báo đến ${a.snoozed_until.toLocaleString('vi-VN')}. Hết hạn mà điều kiện còn thì báo lại.`);
    res.redirect('/admin/sync');
  });

  r.post('/key-duplicates/:id/review', async (req, res) => {
    const out = await syncAdmin.reviewKeyDuplicate(req.scope, parse(id, req.params.id), { action: req.body.action }, clientInfo(req));
    flash(
      req,
      'success',
      out.result === 'moved'
        ? `Máy ${out.to} được tạo trên AD mới hơn ${out.from}, nên key đã được gán cho ${out.to} (máy cũ vẫn giữ lịch sử). Cặp này đã đóng.`
        : `Đã đánh dấu Key ID dùng chung giữa ${out.from} và ${out.to}. Key vẫn giữ ở ${out.from}; trang của cả 2 máy hiển thị ghi chú. Cặp này đã đóng.`,
    );
    res.redirect('/admin/sync');
  });

  return r;
}
