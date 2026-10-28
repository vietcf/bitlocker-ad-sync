// Language of the web UI: the signed-in user's setting, else the `lang` cookie, else English.
import { DEFAULT_LANG, LANGS, html, langFromCookie, translator } from '../i18n/index.js';
import { makeHelpers } from './helpers.js';

/** Sets req.lang / req.t / req.th and the template locals (lang, t, th, h) for this request. */
export function languageContext() {
  return (req, res, next) => {
    const lang = req.scope?.language ?? langFromCookie(req.headers.cookie) ?? DEFAULT_LANG;
    const tr = translator(lang);
    req.lang = tr.lang;
    req.t = tr.t;
    req.th = tr.th;
    res.locals.lang = tr.lang;
    res.locals.t = tr.t;
    res.locals.th = tr.th;
    res.locals.html = html; // marks a th() param as trusted HTML
    res.locals.h = makeHelpers(tr.lang);
    next();
  };
}

/** Same-site relative paths only (no open redirect). */
const safeBack = (n) => (typeof n === 'string' && /^\/(?!\/)[^\\]*$/.test(n) ? n : '/');

/** POST /language {lang, next}: remembers the choice in a cookie, and on the user's account when signed in. */
export function languageRoute({ auth, config }) {
  return async (req, res, next) => {
    try {
      const lang = req.body?.lang;
      if (!LANGS.includes(lang)) return res.redirect(safeBack(req.body?.next));
      res.cookie('lang', lang, {
        maxAge: 365 * 86_400_000, sameSite: 'lax', httpOnly: true, secure: config.COOKIE_SECURE ?? config.NODE_ENV === 'production', path: '/',
      });
      if (req.scope) await auth.setLanguage(req.scope, lang);
      return res.redirect(safeBack(req.body?.next));
    } catch (err) {
      return next(err);
    }
  };
}
