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
        flash(req, 'error', errorText(err, req.t));
        return res.redirect('/admin/sync');
      }
      return next(err);
    }
    return undefined;
  };

  r.get('/', async (req, res) => {
    res.render('admin/sync', { title: req.t('Tình trạng sync'), ...(await syncAdmin.status(req.scope, { page: req.query.page })), query: {} });
  });

  r.post('/request', async (req, res) => {
    const { mode } = await syncAdmin.requestSync(req.scope, { mode: req.body.mode }, clientInfo(req));
    flash(req, 'success', req.t('Đã yêu cầu sync {mode}. Worker sẽ chạy ở lần heartbeat tới (tối đa ~5 phút).', { mode }));
    res.redirect('/admin/sync');
  });

  r.get('/runs/:id', async (req, res) => {
    const p = await syncAdmin.runPreview(req.scope, parse(id, req.params.id));
    res.render('admin/sync-run', { title: req.t('Lượt sync {startedAt}', { startedAt: runRef(p.run.id, p.run.started_at) }), ...p });
  });

  r.post('/runs/:id/ack', async (req, res) => {
    const result = await syncAdmin.ack(req.scope, parse(id, req.params.id), { decision: req.body.decision }, clientInfo(req));
    flash(
      req,
      'success',
      result.decision === 'accept'
        ? req.t('Đã chấp nhận lượt sync. {markedDeleted} máy được gắn nhãn "Không còn trong phạm vi giám sát" (dữ liệu và key vẫn giữ).', { markedDeleted: result.markedDeleted })
        : req.t('Đã bác bỏ lượt sync. Không thay đổi nào được áp dụng.'),
    );
    res.redirect('/admin/sync');
  });

  r.post('/alerts/:id/ack', refusal(async (req, res) => {
    const a = await syncAdmin.ackAlert(req.scope, parse(id, req.params.id), { note: req.body.note || undefined }, clientInfo(req));
    flash(req, 'success', req.t('Đã đóng cảnh báo. Theo dõi lại sau {hours} giờ; nếu lúc đó điều kiện còn thì báo lại.', { hours: a.hours }));
    res.redirect('/admin/sync');
  }));

  r.post('/alerts/:id/snooze', refusal(async (req, res) => {
    const a = await syncAdmin.snoozeAlert(req.scope, parse(id, req.params.id), { days: req.body.days, note: req.body.note || undefined }, clientInfo(req));
    flash(req, 'success', req.t('Đã bỏ qua cảnh báo đến {until}. Hết hạn mà điều kiện còn thì báo lại.', { until: a.snoozed_until.toLocaleString(req.lang === 'vi' ? 'vi-VN' : 'en-GB') }));
    res.redirect('/admin/sync');
  }));

  r.post('/key-duplicates/:id/review', refusal(async (req, res) => {
    const out = await syncAdmin.reviewKeyDuplicate(req.scope, parse(id, req.params.id), { action: req.body.action }, clientInfo(req));
    flash(
      req,
      'success',
      out.result === 'moved'
        ? req.t('Máy {to} được tạo trên AD mới hơn {from}, nên key đã được gán cho {to2} (máy cũ vẫn giữ lịch sử). Cặp này đã đóng.', { to: out.to, from: out.from, to2: out.to })
        : req.t('Đã đánh dấu Key ID dùng chung giữa {from} và {to}. Key vẫn giữ ở {from2}; trang của cả 2 máy hiển thị ghi chú. Cặp này đã đóng.', { from: out.from, to: out.to, from2: out.from }),
    );
    res.redirect('/admin/sync');
  }));

  return r;
}
