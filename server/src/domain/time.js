/**
 * True if `date` falls inside working hours in the given time zone.
 * hours = { tz: 'Asia/Ho_Chi_Minh', days: [1..7] (1 = Monday), start: '08:00', end: '18:00' }
 *
 * Called once per key reveal when a report is built (tens of thousands of times), so the formatter is created
 * once per time zone: building an Intl.DateTimeFormat per call made a 30-day report take seconds.
 */
const FORMATTERS = new Map();
const DAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function formatterFor(tz) {
  let f = FORMATTERS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    FORMATTERS.set(tz, f);
  }
  return f;
}

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export function isWithinWorkingHours(date, hours) {
  let weekday;
  let hour;
  let minute;
  for (const p of formatterFor(hours.tz).formatToParts(date)) {
    if (p.type === 'weekday') weekday = p.value;
    else if (p.type === 'hour') hour = p.value;
    else if (p.type === 'minute') minute = p.value;
  }
  const minutes = Number(hour) * 60 + Number(minute);
  return hours.days.includes(DAYS[weekday]) && minutes >= toMin(hours.start) && minutes < toMin(hours.end);
}
