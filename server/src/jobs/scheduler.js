/**
 * Minimal in-process scheduler. Each job holds a PostgreSQL advisory lock while it runs,
 * so with several app instances only one of them runs a given job at a time.
 * A job that throws is logged and retried at its next tick; it never crashes the app.
 */
export class Scheduler {
  #timers = [];
  #lastDaily = new Map();

  constructor({ pool, logger, tz = 'Asia/Ho_Chi_Minh' }) {
    this.pool = pool;
    this.logger = logger;
    this.tz = tz;
  }

  /**
   * Runs `fn` every `minutes` (first run after `delayMs`). `minutes` may be a function (async) that gives
   * the interval: it is asked every few seconds, so a changed setting applies without a restart.
   */
  every(name, minutes, fn, delayMs = 30_000) {
    if (typeof minutes === 'function') {
      let lastRun = 0;
      const tick = async () => {
        let m;
        try {
          m = Number(await minutes());
        } catch {
          return;
        }
        if (m > 0 && Date.now() - lastRun >= m * 60_000) {
          lastRun = Date.now();
          this.#runLocked(name, fn);
        }
      };
      this.#timers.push(setTimeout(tick, delayMs).unref());
      this.#timers.push(setInterval(tick, 15_000).unref());
      return;
    }
    const tick = () => this.#runLocked(name, fn);
    this.#timers.push(setTimeout(tick, delayMs).unref());
    this.#timers.push(setInterval(tick, minutes * 60_000).unref());
  }

  /** Runs `fn` once a day at HH:MM in the scheduler's time zone. `hhmm` may be a function (async) that gives it. */
  daily(name, hhmm, fn) {
    const check = async () => {
      let at = hhmm;
      if (typeof hhmm === 'function') {
        try {
          at = await hhmm();
        } catch {
          return;
        }
      }
      const now = new Date();
      const local = new Intl.DateTimeFormat('en-CA', {
        timeZone: this.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).format(now); // "2026-10-13, 02:00"
      const [day, time] = local.split(', ');
      if (time >= at && this.#lastDaily.get(name) !== day) {
        this.#lastDaily.set(name, day);
        this.#runLocked(name, fn);
      }
    };
    this.#timers.push(setInterval(check, 60_000).unref());
  }

  async #runLocked(name, fn) {
    const client = await this.pool.connect().catch((err) => {
      this.logger.error({ err, job: name }, 'job: no database connection');
      return null;
    });
    if (!client) return;
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [`job:${name}`]);
      if (!rows[0].ok) return; // another instance is running it
      try {
        const started = Date.now();
        const result = await fn();
        this.logger.debug({ job: name, ms: Date.now() - started, result }, 'job done');
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`job:${name}`]);
      }
    } catch (err) {
      this.logger.error({ err, job: name }, 'job failed');
    } finally {
      client.release();
    }
  }

  stop() {
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
  }
}
