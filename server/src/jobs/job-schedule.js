// When the background jobs run. Set under Quan tri (the page of each job), read by the scheduler on every
// tick, so a change applies within a minute without a restart. The defaults apply until someone changes them.
// (How often the worker reads AD - delta, full, heartbeat - is in the worker's own configuration file.)

export const JOB_SCHEDULE = {
  mailIntervalMinutes: { key: 'jobs.mail_interval_minutes', default: 1, min: 1, max: 60 }, // Quan tri > Mail server
  watchdogIntervalMinutes: { key: 'jobs.watchdog_interval_minutes', default: 5, min: 1, max: 60 }, // Quan tri > Nguong canh bao
  retentionTime: { key: 'jobs.retention_time', default: '03:00' }, // Quan tri > Luu tru
};

export const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A number of minutes setting, kept inside its limits (a wrong stored value falls back to the default). */
export async function jobMinutes(settings, spec) {
  const v = Number(await settings.get(spec.key, spec.default));
  return Number.isFinite(v) && v >= spec.min && v <= spec.max ? Math.floor(v) : spec.default;
}

/** An "HH:MM" setting (a wrong stored value falls back to the default). */
export async function jobTime(settings, spec) {
  const v = await settings.get(spec.key, spec.default);
  return typeof v === 'string' && TIME_OF_DAY.test(v) ? v : spec.default;
}
