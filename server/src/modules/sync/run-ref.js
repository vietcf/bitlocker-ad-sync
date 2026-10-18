// Number of a sync run.
//   id      the sequence number of sync_run (bigint identity). The KEY: workers, foreign keys and the rule
//           "a computer not seen by this run nor a later one" all rely on ids only ever going up. A clock
//           (unix time, yyyymmddHHMMSS) can go back (NTP, a restored VM), which would break that rule.
//   ref     what people read: "YYYYMMDD-NNNN", the day the run started (APP_TZ) and the sequence number
//           padded to 4 digits, e.g. 20261018-0042. Short, sortable, says which day, and still unique
//           (the sequence is unique) even if a database is restored or recreated and ids repeat.

const day = (d, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(d)).replace(/-/g, '');

/** "20261018-0042" for a run id and the time it started. */
export function runRef(id, startedAt, tz = process.env.APP_TZ ?? 'Asia/Ho_Chi_Minh') {
  if (id === null || id === undefined) return null;
  return `${startedAt ? day(startedAt, tz) : '00000000'}-${String(id).padStart(4, '0')}`;
}
