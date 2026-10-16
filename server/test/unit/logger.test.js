import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, scrub } from '../../src/logger.js';

const KEY = '123456-234567-345678-456789-567890-678901-789012-890123';

describe('scrub', () => {
  it('masks a recovery password anywhere in a string', () => {
    expect(scrub(`got ${KEY} back`)).toBe('got [REDACTED-KEY] back');
  });

  it('leaves other digit runs alone', () => {
    expect(scrub('ticket 123456, ip 10.0.0.1')).toBe('ticket 123456, ip 10.0.0.1');
  });
});

describe('createLogger', () => {
  it('never writes a recovery password, in fields, messages or errors', () => {
    const lines = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = createLogger('info', sink);
    log.info({ recoveryPassword: KEY, note: `x ${KEY}` }, `message ${KEY}`);
    log.error(new Error(`boom ${KEY}`));
    const out = lines.join('');
    expect(out).not.toContain(KEY);
    expect(out).toContain('REDACTED');
  });
});
