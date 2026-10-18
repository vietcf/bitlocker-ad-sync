import { z } from 'zod';
import { badRequest } from './errors.js';

/** Parses `input` with a zod schema; throws a 400 AppError listing the bad fields. */
export function parse(schema, input) {
  const r = schema.safeParse(input ?? {});
  if (r.success) return r.data;
  const fields = r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
  throw badRequest('invalid_request', 'The request data is invalid.', { fields });
}

/** 400 when a query or body string holds a NUL character (PostgreSQL text and jsonb cannot store it). */
export function rejectNul(req, res, next) {
  const has = (v) => (typeof v === 'string' ? v.includes('\u0000') : v && typeof v === 'object' ? Object.values(v).some(has) : false);
  if (has(req.query) || has(req.body)) return next(badRequest('invalid_request', 'The request contains an invalid character.'));
  next();
}

// Reusable field schemas.
export const id = z.coerce.number().int().positive();
// GUIDs from Windows/AD are not always RFC 4122 (version/variant bits), so only the shape is checked.
export const uuid = z.string().trim().guid().transform((s) => s.toLowerCase());
export const page = z.coerce.number().int().min(1).max(10_000).default(1);
/** A real calendar day, YYYY-MM-DD (2026-02-31 is refused). */
export const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid_date')
  .refine((s) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; }, 'invalid_date');
/** Empty form fields arrive as "": treat them as absent. */
export const optionalText = (max) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(max).optional());
export const optionalDate = z.preprocess(
  (v) => (v === '' || v === undefined ? undefined : v),
  z.coerce.date().optional(),
);
/** HTML checkboxes send "on" or nothing. */
export const checkbox = z.preprocess((v) => v === true || v === 'on' || v === 'true' || v === '1', z.boolean());
/** A form field that may appear once (string) or several times (array). */
export const manyText = (max) =>
  z.preprocess((v) => (v === undefined || v === '' ? [] : Array.isArray(v) ? v : [v]), z.array(z.string().trim().max(max)));
