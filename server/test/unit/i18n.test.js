import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EN, PARTS } from '../../src/i18n/en/index.js';
import { html, langFromCookie, normalizeLang, translate, translateHtml, translator } from '../../src/i18n/index.js';
import { scanDir, VIETNAMESE } from '../support/i18n-scan.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const tags = (s) => [...s.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[0].toLowerCase()).sort();

describe('i18n helpers', () => {
  it('Vietnamese is the key, English comes from the dictionary, params are filled', () => {
    expect(translate('vi', 'Đăng xuất')).toBe('Đăng xuất');
    expect(translate('en', 'Đăng xuất')).toBe('Sign out');
    expect(translate('en', 'Khớp {n} máy, hiện thuộc:', { n: 3 })).toBe('Matches 3 computers, currently in:');
    expect(translate('vi', 'Khớp {n} máy, hiện thuộc:', { n: 3 })).toBe('Khớp 3 máy, hiện thuộc:');
  });

  it('a missing English text falls back to the key and is reported once', async () => {
    const { setMissingHandler } = await import('../../src/i18n/index.js');
    const seen = [];
    setMissingHandler((k) => seen.push(k));
    expect(translate('en', 'Câu chưa có bản dịch')).toBe('Câu chưa có bản dịch');
    translate('en', 'Câu chưa có bản dịch');
    expect(seen).toEqual(['Câu chưa có bản dịch']);
    setMissingHandler(null);
  });

  it('th() escapes params unless they are marked html()', () => {
    const t = translator('en');
    expect(t.th('Người dùng <strong>{name}</strong>', { name: '<b>x</b>' })).toBe('Người dùng <strong>&lt;b&gt;x&lt;/b&gt;</strong>');
    expect(translateHtml('en', '<strong>Thao tác này không hoàn tác được.</strong> Khi xóa chi nhánh:')).toBe('<strong>This cannot be undone.</strong> When a branch is deleted:');
    expect(translateHtml('vi', 'Máy {comp}', { comp: html('<a href="/x">X</a>') })).toBe('Máy <a href="/x">X</a>');
  });

  it('English is the default language; only en and vi are accepted', () => {
    expect(normalizeLang(undefined)).toBe('en');
    expect(normalizeLang('fr')).toBe('en');
    expect(normalizeLang('vi')).toBe('vi');
    expect(langFromCookie('a=1; lang=vi; b=2')).toBe('vi');
    expect(langFromCookie('lang=fr')).toBeNull();
    expect(langFromCookie(undefined)).toBeNull();
  });
});

describe('English dictionary', () => {
  it('has no key defined twice across files', () => {
    const seen = new Map();
    const dup = [];
    for (const [part, dict] of Object.entries(PARTS)) {
      for (const k of Object.keys(dict)) {
        if (seen.has(k)) dup.push(`${k} (${seen.get(k)} and ${part})`);
        seen.set(k, part);
      }
    }
    expect(dup).toEqual([]);
  });

  it('every Vietnamese text used in t() / th() / tk() has an English text', () => {
    const missing = [...scanDir(SRC).entries()]
      .filter(([k]) => VIETNAMESE.test(k) && !(k in EN))
      .map(([k, files]) => `${[...files][0]} :: ${k.slice(0, 80)}`);
    expect(missing).toEqual([]);
  });

  it('keeps the same {placeholders} and HTML tags as the Vietnamese text, and has no Vietnamese left', () => {
    const problems = [];
    for (const [vi, en] of Object.entries(EN)) {
      if (placeholders(vi).join() !== placeholders(en).join()) problems.push(`placeholders: ${vi.slice(0, 60)}`);
      if (tags(vi).join() !== tags(en).join()) problems.push(`html tags: ${vi.slice(0, 60)}`);
      if (VIETNAMESE.test(en)) problems.push(`Vietnamese in the English text: ${en.slice(0, 60)}`);
    }
    expect(problems).toEqual([]);
  });
});
