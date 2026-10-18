// Restores a database backup (bitlocker-db-*.zip made by Quan tri > Sao luu) in one step.
//
//   docker compose run --rm --no-deps server node src/cli/restore.js backups/bitlocker-db-20261018-013000.zip
//
//   --force          the database already holds data: replace it
//   --new-log-key    LOG_HMAC_KEY differs from the one the backup was made with: re-anchor the log chain
//   --reset-2fa      turn two-step sign-in off for every user
//   --reset-admin    new one-time password for the original admin (printed once)
//   --yes            do not ask for confirmation (with --force)
//
// The zip password comes from the prompt, or from the environment variable RESTORE_ZIP_PASSWORD.
// Needs MIGRATION_DATABASE_URL (blk_owner) in the environment, like `npm run migrate`, and pg_restore 17.

import readline from 'node:readline';
import { loadConfig } from '../config.js';
import { RestoreError, restoreDatabase } from '../modules/backup/restore.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const zipPath = args.find((a) => !a.startsWith('--'));

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
  }
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); }));
}

async function main() {
  if (!zipPath) {
    console.error('Usage: node src/cli/restore.js <bitlocker-db-....zip> [--force] [--new-log-key] [--reset-2fa] [--reset-admin] [--yes]');
    process.exit(2);
  }
  const config = loadConfig();
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) throw new RestoreError('no_owner_url', 'MIGRATION_DATABASE_URL (blk_owner) is not set.');

  let password = process.env.RESTORE_ZIP_PASSWORD || null;
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  if (flag('--force') && !flag('--yes')) {
    if (!interactive) throw new RestoreError('confirm_needed', 'Replacing existing data needs confirmation: add --yes.');
    const db = decodeURIComponent(new URL(ownerUrl).pathname.slice(1));
    const typed = await ask(`This replaces everything in database "${db}". Type its name to continue: `);
    if (typed.trim() !== db) throw new RestoreError('cancelled', 'Cancelled.');
  }

  const run = async () => restoreDatabase({
    zipPath, password, ownerUrl, hmacKey: Buffer.from(config.LOG_HMAC_KEY, 'hex'), tz: config.APP_TZ,
    force: flag('--force'), newLogKey: flag('--new-log-key'), reset2fa: flag('--reset-2fa'), resetAdmin: flag('--reset-admin'),
    say: (m) => console.log(m),
  });

  let result;
  try {
    result = await run();
  } catch (e) {
    if (e.code !== 'password_required' || !interactive) throw e;
    password = await ask('Backup password: ', { hidden: true });
    result = await run();
  }

  const { counts, chain, secrets, migrated } = result;
  console.log(`\nRestored${result.backupCreatedAt ? ` (backup made ${result.backupCreatedAt})` : ''}: ${counts.computers} computers, ${counts.keys} keys, ${counts.users} users.`);
  if (migrated.length) console.log(`Newer migrations applied: ${migrated.join(', ')}`);

  if (chain.ok) console.log(`Log chain: OK${result.reanchored ? ' (re-anchored with the current LOG_HMAC_KEY: older rows are kept but no longer verified)' : ''}.`);
  else console.log(`Log chain: does not verify with the current LOG_HMAC_KEY (row ${chain.brokenAtId}). If LOG_HMAC_KEY is new, run again with --new-log-key. Data is intact.`);

  const lost = [...secrets.settings.map((s) => `setting "${s}"`), ...(secrets.totpUsers ? [`${secrets.totpUsers} user(s) with two-step sign-in`] : [])];
  if (lost.length) {
    console.log(`Cannot be read with the current LOG_HMAC_KEY: ${lost.join(', ')}.`);
    console.log('  SMTP / backup password: enter them again in the admin pages. Two-step sign-in: use --reset-2fa, or `users.js disable-2fa <user>`.');
  }
  if (result.twoFactorOff) console.log(`Two-step sign-in turned off for ${result.twoFactorOff} user(s).`);
  if (result.adminReset) console.log(`New one-time password for "${result.adminReset.username}" (change it at sign-in): ${result.adminReset.password}`);
  console.log('\nNext: start the app, sign in, and run one full sync.');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof RestoreError ? `Restore stopped: ${e.message}` : `Restore failed: ${e.stack ?? e.message}`);
  process.exit(1);
});
