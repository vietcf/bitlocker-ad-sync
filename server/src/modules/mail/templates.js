import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

// Every mail the app sends is built from server/templates/mail-templates.yaml (or the file in
// MAIL_TEMPLATES_FILE). The file is re-read when it changes; a broken edit keeps the last good
// version (and logs why), while a broken file at start-up stops the app.

export const DEFAULT_TEMPLATES_FILE = fileURLToPath(new URL('../../../templates/mail-templates.yaml', import.meta.url));

/** Templates the code sends; the file must define each of them. */
export const REQUIRED_TEMPLATES = [
  'sync_failed', 'sync_failed_recovered', 'sync_anomaly', 'sync_anomaly_recovered',
  'worker_offline', 'sync_problem', 'worker_silent', 'sync_stale', 'full_stale', 'sync_run_aborted', 'ldap_error', 'dc_cert_expiring',
  'canary_stale', 'dc_usn_stalled', 'escrow_broken', 'no_key_rising',
  'recovered', 'key_duplicate', 'backup_failed', 'backup_failed_recovered', 'reveal_out_of_hours', 'key_export', 'new_objects', 'daily_report', 'smtp_test',
];

/** Replaces {{name}} with vars[name]; unknown names stay as they are. */
export function fill(text, vars) {
  return String(text ?? '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, k) =>
    Object.hasOwn(vars, k) && vars[k] !== null && vars[k] !== undefined ? String(vars[k]) : m,
  );
}

function parseFile(file) {
  const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
  if (!doc || typeof doc.templates !== 'object') throw new Error(`${file}: no "templates" section`);
  const missing = REQUIRED_TEMPLATES.filter((n) => !doc.templates[n]?.subject || doc.templates[n]?.body === undefined);
  if (missing.length) throw new Error(`${file}: missing subject/body for ${missing.join(', ')}`);
  const parts = doc.templates.new_objects.parts ?? {};
  for (const p of ['summary_computers', 'summary_keys', 'summary_join', 'computers_title', 'computer_line', 'keys_title', 'key_line', 'more_line', 'link']) {
    if (typeof parts[p] !== 'string') throw new Error(`${file}: new_objects.parts.${p} is missing`);
  }
  return doc;
}

export class MailTemplates {
  #doc;
  #mtimeMs = 0;

  constructor({ file = DEFAULT_TEMPLATES_FILE, logger }) {
    this.file = path.resolve(file);
    this.logger = logger;
    this.#doc = parseFile(this.file); // throws: the app does not start with a broken file
    this.#mtimeMs = fs.statSync(this.file).mtimeMs;
  }

  /** The current templates, re-read if the file changed (a broken edit keeps the last good one). */
  #current() {
    try {
      const mtime = fs.statSync(this.file).mtimeMs;
      if (mtime !== this.#mtimeMs) {
        this.#mtimeMs = mtime;
        this.#doc = parseFile(this.file);
        this.logger?.info({ file: this.file }, 'mail templates reloaded');
      }
    } catch (err) {
      this.logger?.error({ file: this.file, err: { message: err.message } }, 'mail templates: bad edit ignored, keeping the last good version');
    }
    return this.#doc;
  }

  /**
   * { subject, body } of a template in `lang` ('vi' is the base text of the template, 'en' the `en:` block; a
   * template without an `en:` block stays Vietnamese). Alerts get the alert_subject_prefix (with {{severity}}).
   */
  render(name, vars = {}, { severity, lang = 'vi' } = {}) {
    const doc = this.#current();
    const base = doc.templates[name];
    if (!base) throw new Error(`unknown mail template ${name}`);
    const t = lang === 'en' && base.en ? { ...base, ...base.en } : base;
    let subject = fill(t.subject, vars).replace(/\s+/g, ' ').trim();
    if (t.kind === 'alert' && severity) subject = fill(doc.alert_subject_prefix ?? '', { severity: severity.toUpperCase() }) + subject;
    return { subject, body: fill(t.body, vars).replace(/\n+$/, '') };
  }

  /** One of the pieces under `parts` of a template (new_objects), filled in, in `lang`. */
  part(name, piece, vars = {}, lang = 'vi') {
    const base = this.#current().templates[name];
    const parts = lang === 'en' && base?.en?.parts ? base.en.parts : base?.parts;
    return fill(parts?.[piece] ?? '', vars);
  }

  has(name) {
    return Boolean(this.#current().templates[name]);
  }
}
