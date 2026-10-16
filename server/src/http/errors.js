/**
 * The one error type services throw. Web and API layers translate it:
 * the API answers { error: code, message, ...details } with `status`; the web renders a page or redirects.
 * `message` is a safe English sentence (never internal details) used by the API and logs.
 * The web UI shows Vietnamese text looked up by `code` (and `details`) in web/messages.js.
 */
export class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message ?? code);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code = 'invalid_request', message = 'The request data is invalid.', details) =>
  new AppError(400, code, message, details);
export const unauthorized = (code = 'unauthenticated', message = 'Sign-in required.') => new AppError(401, code, message);
export const forbidden = (code = 'forbidden', message = 'You are not allowed to do this.') =>
  new AppError(403, code, message);
// Out-of-scope objects are reported as missing, so their existence is not revealed.
export const notFound = (message = 'Not found.') => new AppError(404, 'not_found', message);
/** A feature switched off in Quan tri > Tinh nang. */
export const featureDisabled = () => new AppError(403, 'feature_disabled', 'This feature is turned off in Settings.');
export const conflict = (code, message, details) => new AppError(409, code, message, details);
