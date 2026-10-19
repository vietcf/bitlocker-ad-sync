import fs from 'node:fs';
import { scrub } from '../../logger.js';
import { runRef } from '../sync/run-ref.js';

// Event lines on stdout. Besides the application log, the app writes one JSON line for every event that the
// screens show as a log, so a collector that reads the container's stdout (a SIEM, a log shipper) has them all.
// Each line has "log_type" to filter on:
//   audit             a row of the Nhat ky (access_log), the fields the screen shows, with its id
//   mail              a change of state of an e-mail (queued, sent, retry, failed, no_recipient...)
//   sync_run          a sync run opened / finished / decided
//   alert             a sync / system alert opened, notified or resolved
//   event_gap         lines left out because stdout was stuck (how many)
// It must never get in the way of the application: nothing waits for stdout (lines go to a queue in memory
// and are written in the background), and when the queue is full new lines are dropped. Never a recovery
// password (the text is scrubbed like every other log line).

export const SERVICE = 'bitlocker-keys';
const BODY_MAX = 20_000;
const MAX_QUEUE = 20_000; // lines kept waiting; beyond that new lines are dropped

/** Writes a whole buffer to stdout without blocking the event loop (async fs.write, one write at a time). */
async function writeStdout(text) {
  let buf = Buffer.from(text);
  while (buf.length) {
    const n = await new Promise((resolve) => {
      fs.write(1, buf, 0, buf.length, null, (err, written) => resolve(err ?? written));
    });
    if (typeof n !== 'number') {
      if (n.code === 'EAGAIN') {
        await new Promise((r) => setTimeout(r, 50)); // stdout is full: wait, the queue absorbs the rest
        continue;
      }
      return; // any other error: give the line up
    }
    buf = buf.subarray(n);
  }
}

/** Queues one JSON line per event and writes them to stdout in the background. emit() never throws or waits. */
export class EventLog {
  #queue = [];
  #pumping = false;
  #dropped = 0;
  #idle = [];

  /** write(line): replaceable (tests); may return a promise. enabled=false: nothing is queued or written. */
  constructor({ write = null, enabled = true, maxQueue = MAX_QUEUE } = {}) {
    this.enabled = enabled;
    this.maxQueue = maxQueue;
    this.write = write ?? writeStdout;
  }

  /** type: log_type; data: the fields. The event time is data.time (a Date or ISO text) or now. */
  emit(type, data = {}) {
    if (!this.enabled) return;
    try {
      const { time, ...rest } = data;
      const line = JSON.stringify({
        log_type: type,
        service: SERVICE,
        time: new Date(time ?? Date.now()).toISOString(),
        ...rest,
      }, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
      if (this.#queue.length >= this.maxQueue) {
        this.#dropped += 1;
        return;
      }
      this.#queue.push(`${scrub(line)}\n`);
      if (!this.#pumping) this.#pump();
    } catch {
      // Event lines must never break what the app is doing.
    }
  }

  async #pump() {
    this.#pumping = true;
    try {
      while (this.#queue.length) {
        try {
          await this.write(this.#queue.shift());
        } catch {
          // the line is lost, the next one is tried
        }
        if (!this.#queue.length && this.#dropped) {
          const dropped = this.#dropped;
          this.#dropped = 0;
          this.#queue.push(`${JSON.stringify({ log_type: 'event_gap', service: SERVICE, time: new Date().toISOString(), dropped })}\n`);
        }
      }
    } finally {
      this.#pumping = false;
      for (const resolve of this.#idle.splice(0)) resolve();
    }
  }

  /** Resolves when everything queued so far has been handed to the writer (tests, shutdown). */
  flush() {
    if (!this.#pumping && !this.#queue.length) return Promise.resolve();
    return new Promise((resolve) => this.#idle.push(resolve));
  }

  /** E-mail body for the log: text only, cut when very long. */
  static body(text) {
    const s = String(text ?? '');
    return s.length > BODY_MAX ? `${s.slice(0, BODY_MAX)}... [cut, ${s.length} characters]` : s;
  }
}

/** The fields of a sync run row, as the "Tinh trang sync" list shows them. */
export function syncRunFields(r) {
  return {
    run_id: Number(r.id),
    run_ref: runRef(r.id, r.started_at),
    started_at: r.started_at,
    finished_at: r.finished_at,
    mode: r.mode,
    dc_name: r.dc_name,
    since_usn: r.since_usn === null || r.since_usn === undefined ? null : Number(r.since_usn),
    highest_usn: r.highest_usn === null || r.highest_usn === undefined ? null : Number(r.highest_usn),
    computers_seen: r.computers_seen,
    keys_seen: r.keys_seen,
    keys_added: r.keys_added,
    keys_empty_pwd: r.keys_empty_pwd,
    status: r.status,
    error_code: r.error_code,
    errors: r.errors,
    anomalies: r.anomalies,
    ack_decision: r.ack_decision,
    ack_by: r.ack_by,
    ack_at: r.ack_at,
  };
}
