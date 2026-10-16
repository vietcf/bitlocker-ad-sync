/**
 * True if `date` falls inside working hours in the given time zone.
 * hours = { tz: 'Asia/Ho_Chi_Minh', days: [1..7] (1 = Monday), start: '08:00', end: '18:00' }
 */
export function isWithinWorkingHours(date, hours) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: hours.tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const day = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const toMin = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  return hours.days.includes(day) && minutes >= toMin(hours.start) && minutes < toMin(hours.end);
}
