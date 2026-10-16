import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATES_FILE, MailTemplates, REQUIRED_TEMPLATES, fill } from '../../src/modules/mail/templates.js';

const copy = () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-')), 'mail-templates.yaml');
  fs.copyFileSync(DEFAULT_TEMPLATES_FILE, file);
  return file;
};
const touch = (file, text) => {
  fs.writeFileSync(file, text);
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(file, later, later); // make sure the mtime changes
};

describe('mail templates', () => {
  it('the shipped file defines every template the code sends', () => {
    const t = new MailTemplates({ file: DEFAULT_TEMPLATES_FILE });
    for (const name of REQUIRED_TEMPLATES) expect(t.has(name), name).toBe(true);
  });

  it('fills placeholders, leaves unknown ones visible, and prefixes alerts with the severity', () => {
    expect(fill('Hi {{user}}, {{nope}}', { user: 'it.hn' })).toBe('Hi it.hn, {{nope}}');
    const t = new MailTemplates({ file: DEFAULT_TEMPLATES_FILE });
    expect(t.render('sync_failed', { runId: 7, mode: 'delta', dc: 'DC01', errorCode: 'ldap_bind_failed' }, { severity: 'high' })).toEqual({
      subject: '[BitLocker][HIGH] Sync AD lỗi: ldap_bind_failed',
      body: 'Lượt sync #7 (delta, DC DC01) báo lỗi ldap_bind_failed.\nKiểm tra worker và kết nối LDAPS từ worker tới DC.',
    });
    expect(t.render('smtp_test').subject).toBe('[BitLocker] Email thử'); // a notification: no prefix
  });

  it('picks up an edit without a restart, and keeps the last good version when an edit is broken', () => {
    const file = copy();
    const t = new MailTemplates({ file });
    touch(file, fs.readFileSync(file, 'utf8').replace('subject: "[BitLocker] Email thử"','subject: "Thử mail {{x}}"'));
    expect(t.render('smtp_test', { x: 1 }).subject).toBe('Thử mail 1');
    touch(file, 'templates: [broken');
    expect(t.render('smtp_test', { x: 2 }).subject).toBe('Thử mail 2');
  });

  it('refuses to start with a file that misses a template', () => {
    const file = copy();
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n  smtp_test:[\s\S]*$/, '\n'));
    expect(() => new MailTemplates({ file })).toThrow(/smtp_test/);
  });
});
