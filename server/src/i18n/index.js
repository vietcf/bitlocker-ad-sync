// UI translation. The Vietnamese source text is the lookup key; the English text lives in ./en/*.js.
// `t(key, params)` returns plain text (callers print it with <%= %> so everything is escaped);
// `th(key, params)` returns HTML for dictionary strings that contain markup (print with <%- %>):
// its params are HTML-escaped unless wrapped with html().

import { EN } from './en/index.js';

export const LANGS = ['en', 'vi'];
export const DEFAULT_LANG = 'en';

export const normalizeLang = (value) => (LANGS.includes(value) ? value : DEFAULT_LANG);

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Marks a param value as trusted HTML for th(). */
export const html = (value) => ({ __html: String(value ?? '') });

let onMissing = null;
/** Called once per language/key with no English text (development hook; tests check coverage). */
export function setMissingHandler(fn) {
  onMissing = fn;
}
const reported = new Set();

function pick(lang, key) {
  if (lang === 'vi') return key;
  const text = EN[key];
  if (text === undefined) {
    if (onMissing && !reported.has(key)) {
      reported.add(key);
      onMissing(key);
    }
    return key;
  }
  return text;
}

const fill = (text, params, format) => text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? format(params[name]) : match));

export function translate(lang, key, params = {}) {
  return fill(pick(lang, key), params, (v) => (v && typeof v === 'object' && '__html' in v ? v.__html : String(v ?? '')));
}

export function translateHtml(lang, key, params = {}) {
  return fill(pick(lang, key), params, (v) => (v && typeof v === 'object' && '__html' in v ? v.__html : escapeHtml(v)));
}

/** { lang, t, th } bound to one language. */
export function translator(language) {
  const lang = normalizeLang(language);
  return {
    lang,
    t: (key, params) => translate(lang, key, params),
    th: (key, params) => translateHtml(lang, key, params),
  };
}

/** Parses the `lang` cookie out of a Cookie header (no cookie-parser dependency). */
export function langFromCookie(header) {
  const m = /(?:^|;\s*)lang=(en|vi)(?:;|$)/.exec(header ?? '');
  return m ? m[1] : null;
}

/** Marks a literal as a translation key without translating it now (data tables, validation messages): the UI later calls t() on it. */
export const tk = (key) => key;
