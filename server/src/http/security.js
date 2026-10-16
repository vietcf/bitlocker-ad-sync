import helmet from 'helmet';

/** Security headers. Scripts and styles only from our own origin (no inline script). */
export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    referrerPolicy: { policy: 'same-origin' },
  });
}

/** For any response that contains or leads to secrets: never stored by browser or proxies. */
export function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  next();
}

/** Who and where, from the request, for the audit log. */
export function clientInfo(req) {
  return {
    clientIp: (req.ip ?? '').slice(0, 45) || null,
    userAgent: (req.get('user-agent') ?? '').slice(0, 256) || null,
  };
}
