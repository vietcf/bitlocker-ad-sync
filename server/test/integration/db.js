import pg from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

// Defaults match docker-compose.yml (blk_test database created by db/init/01-roles.sh).
export const OWNER_URL =
  process.env.TEST_MIGRATION_DATABASE_URL ?? 'postgres://blk_owner:dev_owner_pw@127.0.0.1:5432/blk_test';
export const APP_URL = process.env.TEST_DATABASE_URL ?? 'postgres://app_node:dev_app_pw@127.0.0.1:5432/blk_test';

export const HMAC_KEY = Buffer.alloc(32, 1);

/** Drops everything and re-applies all migrations, as blk_owner. */
export async function resetDatabase() {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try {
    await c.query('DROP SCHEMA public CASCADE');
    await c.query('CREATE SCHEMA public');
    await c.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await c.query('GRANT USAGE ON SCHEMA public TO app_node');
  } finally {
    await c.end();
  }
  await runMigrations(OWNER_URL);
}

/** Runs SQL as the schema owner (bypasses RLS) to arrange fixtures. Returns rows. */
export async function asOwner(sql, params = []) {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

export function appPool() {
  return new pg.Pool({ connectionString: APP_URL, max: 12 });
}

/** A valid-looking, distinct recovery password per n. */
export const PWD = (n) =>
  Array.from({ length: 8 }, (_, i) => String((n * 8 + i) % 1_000_000).padStart(6, '0')).join('-');

/** Two branches (HN=1, HCM=2), one computer and one key in each, plus one unmapped computer. */
export async function seedTwoBranches() {
  await asOwner(`
    INSERT INTO branch (code, name) VALUES ('HN', 'Ha Noi'), ('HCM', 'Ho Chi Minh');
    INSERT INTO branch_ou (branch_id, root_dn) VALUES
      (1, 'ou=computers,ou=hn,dc=corp,dc=local'),
      (2, 'ou=computers,ou=hcm,dc=corp,dc=local');
    INSERT INTO computer (object_guid, name, distinguished_name, branch_id) VALUES
      ('00000000-0000-0000-0000-000000000001', 'HN-LT-0001',  'CN=HN-LT-0001,OU=Computers,OU=HN,DC=corp,DC=local', 1),
      ('00000000-0000-0000-0000-000000000002', 'HCM-LT-0001', 'CN=HCM-LT-0001,OU=Computers,OU=HCM,DC=corp,DC=local', 2),
      ('00000000-0000-0000-0000-000000000003', 'SRV-0001',    'CN=SRV-0001,OU=Servers,DC=corp,DC=local', NULL);
  `);
  await asOwner(
    `INSERT INTO recovery_key (computer_id, key_id, recovery_password, ad_created_at) VALUES
       (1, 'aaaaaaaa-0000-0000-0000-000000000001', $1, now()),
       (2, 'bbbbbbbb-0000-0000-0000-000000000002', $2, now()),
       (3, 'cccccccc-0000-0000-0000-000000000003', $3, now())`,
    [PWD(1), PWD(2), PWD(3)],
  );
}
