// Checks the audit log hash chain, and starts it again after LOG_HMAC_KEY changed.
//
//   node src/cli/audit.js verify
//   node src/cli/audit.js reanchor --yes     (only when verify fails and you know why: a new LOG_HMAC_KEY)
//
// reanchor keeps every row; rows before the break are no longer verified, new rows chain from here.
// The action is written to the log (admin_change, user "cli"). Needs MIGRATION_DATABASE_URL (blk_owner), like restore.js.

import { loadConfig } from '../config.js';
import pg from 'pg';
import { AuditService } from '../modules/audit/audit.service.js';

const [command, ...rest] = process.argv.slice(2);
const config = loadConfig();
// reanchor writes a chain checkpoint, which only the schema owner (blk_owner) may do.
const ownerUrl = process.env.MIGRATION_DATABASE_URL;
if (!ownerUrl) {
  console.error('MIGRATION_DATABASE_URL (blk_owner) is not set.');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: ownerUrl, max: 2 });
const audit = new AuditService({ pool, hmacKey: Buffer.from(config.LOG_HMAC_KEY, 'hex'), tz: config.APP_TZ });

async function main() {
  if (command === 'verify') {
    const r = await audit.verify();
    if (r.ok) return console.log(`Log chain OK (${r.checked} rows checked).`);
    console.log(`Log chain BROKEN at row ${r.brokenAtId} (${r.problem}) after ${r.checked} good rows.`);
    console.log('Same LOG_HMAC_KEY as before? If it changed (new server, restore), run: node src/cli/audit.js reanchor --yes');
    console.log('If the key did not change, do not reanchor: someone may have altered the log. Investigate first.');
    process.exitCode = 1;
    return undefined;
  }
  if (command === 'reanchor') {
    if (!rest.includes('--yes')) throw new Error('Add --yes to confirm (see the note at the top of this file).');
    const before = await audit.verify();
    if (before.ok) return console.log('The chain is fine: nothing to do.');
    const { upToId } = await audit.reanchor('cli (new LOG_HMAC_KEY)');
    await audit.log({ userSid: 'cli', userUpn: 'cli', action: 'admin_change', detail: { op: 'audit_reanchor', brokenAtId: before.brokenAtId, upToId } });
    const after = await audit.verify();
    console.log(after.ok ? `Done: the chain starts again after row ${upToId}.` : 'The chain still does not verify.');
    process.exitCode = after.ok ? 0 : 1;
    return undefined;
  }
  throw new Error('Usage: node src/cli/audit.js verify | reanchor --yes');
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
