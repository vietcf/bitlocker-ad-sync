import { can } from '../domain/scope.js';
import { APP_VERSION } from '../version.js';
import { csrfToken } from '../http/csrf.js';
import { AppError } from '../http/errors.js';
import { translator } from '../i18n/index.js';
import { errorText } from './messages.js';

/** One-shot message shown on the next page (after a redirect). */
export function flash(req, type, text) {
  req.session.flash = { type, text };
}

/** Values every template can use: me, can(), csrf token, flash, current path (language, t and h come from languageContext). */
export function templateLocals(req, res, next) {
  const scope = req.scope;
  res.locals.me = scope;
  res.locals.can = (capability) => !!scope && can(scope, capability);
  res.locals.csrfToken = csrfToken(req);
  res.locals.appVersion = APP_VERSION;
  res.locals.path = req.path;
  res.locals.currentUrl = req.originalUrl;
  res.locals.flash = req.session.flash ?? null;
  delete req.session.flash;
  next();
}

/**
 * Runs a form handler; on an AppError whose status is in `statuses` (default 400, 409)
 * re-renders the form with the error message instead of leaving the page.
 * `renderForm(req, res, error)` draws the form again.
 */
export function formAction(handler, renderForm, statuses = [400, 409]) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof AppError && statuses.includes(err.status)) {
        res.status(err.status);
        return renderForm(req, res, err);
      }
      next(err);
    }
  };
}

/**
 * Web error handler: not signed in -> login page; forced password change -> that page;
 * other AppErrors -> error page with their message; anything else -> generic 500 page.
 */
// eslint-disable-next-line no-unused-vars
export function webErrorHandler(err, req, res, next) {
  const t = req.t ?? translator('en').t;
  if (err instanceof AppError && err.status === 401) {
    const nextUrl = req.method === 'GET' ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
    if (err.code === 'session_expired') flash(req, 'info', errorText(err, t));
    return res.redirect(`/login${nextUrl}`);
  }
  if (err instanceof AppError && err.code === 'password_change_required') return res.redirect('/change-password');
  if (err.type === 'entity.too.large') err = new AppError(413, 'too_large', 'The request is too large.');
  const known = err instanceof AppError;
  if (!known) req.log.error({ err }, 'unhandled web error');
  res.status(known ? err.status : 500).render('error', {
    title: t('Có lỗi'),
    status: known ? err.status : 500,
    message: known ? errorText(err, t) : t('Có lỗi không mong muốn. Vui lòng thử lại; nếu vẫn lỗi, báo Admin HQ kèm mã bên dưới.'),
    requestId: known ? null : req.id,
  });
}
