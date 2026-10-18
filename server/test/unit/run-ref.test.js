import { describe, expect, it } from 'vitest';
import { runRef } from '../../src/modules/sync/run-ref.js';

describe('sync run number', () => {
  it('is the day the run started (in the app time zone) and the padded sequence number', () => {
    expect(runRef(42, '2026-10-18T03:41:00Z', 'Asia/Ho_Chi_Minh')).toBe('20261018-0042');
    // 20:00 UTC is already the next day in Ha Noi (UTC+7).
    expect(runRef(7, '2026-10-17T20:00:00Z', 'Asia/Ho_Chi_Minh')).toBe('20261018-0007');
    expect(runRef(7, '2026-10-17T20:00:00Z', 'UTC')).toBe('20261017-0007');
    expect(runRef(123456, '2026-01-02T00:00:00Z', 'UTC')).toBe('20260102-123456'); // longer than 4 digits is kept
    expect(runRef(null, null)).toBeNull();
  });

  it('sorts like the runs happened', () => {
    const refs = [runRef(9, '2026-10-17T05:00:00Z', 'UTC'), runRef(10, '2026-10-18T05:00:00Z', 'UTC'), runRef(11, '2026-10-18T09:00:00Z', 'UTC')];
    expect([...refs].sort()).toEqual(refs);
  });
});
