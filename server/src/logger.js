import { pino } from 'pino';

// A BitLocker recovery password: 8 groups of 6 digits.
const RECOVERY_PASSWORD = /\b\d{6}(?:-\d{6}){7}\b/g;
const MASK = '[REDACTED-KEY]';

/** Removes anything shaped like a recovery password from a string. */
export function scrub(text) {
  return text.replace(RECOVERY_PASSWORD, MASK);
}

/**
 * Creates the app logger. `destination` is optional (tests pass a stream to capture output).
 */
export function createLogger(level, destination) {
  const options = {
    level,
    // Never log bodies or credentials. Field-level redaction first...
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.recoveryPassword',
        '*.recovery_password',
        '*.password',
        '*.client_secret',
      ],
      censor: '[REDACTED]',
    },
  };
  // ...then a pattern scrub on every finished log line, in case a key slips into a message,
  // an error or any other field. Done on the output text so serializers see the real objects.
  const target = destination ?? pino.destination(1);
  return pino(options, { write: (line) => target.write(scrub(line)) });
}
