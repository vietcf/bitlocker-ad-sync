import { z } from 'zod';
import { badRequest } from './errors.js';

/** Parses `input` with a zod schema; throws a 400 AppError listing the bad fields. */
export function parse(schema, input) {
  const r = schema.safeParse(input ?? {});
  if (r.success) return r.data;
  const fields = r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
  throw badRequest('invalid_request', 'The request data is invalid.', { fields });
}

// Reusable field schemas.
export const id = z.coerce.number().int().positive();
// GUIDs from Windows/AD are not always RFC 4122 (version/variant bits), so only the shape is checked.
export const uuid = z.string().trim().guid().transform((s) => s.toLowerCase());
export const page = z.coerce.number().int().min(1).max(10_000).default(1);
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
