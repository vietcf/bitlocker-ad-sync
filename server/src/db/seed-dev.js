// Sample data for local development: 3 branches with their OUs, a few computers with fake keys,
// and one unmapped server. Safe to run more than once. Refuses to run in production.
//
//   node src/db/seed-dev.js
//
// Runs as blk_owner (MIGRATION_DATABASE_URL) so it can write past row-level security.

import { randomInt, randomUUID } from 'node:crypto';
import pg from 'pg';

if (process.env.NODE_ENV === 'production') {
  console.error('seed-dev refuses to run with NODE_ENV=production');
  process.exit(1);
}
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL is not set');
  process.exit(1);
}

const BRANCHES = [
  { code: 'HN', name: 'Hà Nội', ou: 'OU=Computers,OU=HN,DC=corp,DC=local', count: 8 },
  { code: 'HCM', name: 'Hồ Chí Minh', ou: 'OU=Computers,OU=HCM,DC=corp,DC=local', count: 8 },
  { code: 'DN', name: 'Đà Nẵng', ou: 'OU=Computers,OU=DN,DC=corp,DC=local', count: 4 },
];

// Fake recovery password: 8 groups of 6 digits (real ones are multiples of 11; irrelevant here).
const fakePassword = () => Array.from({ length: 8 }, () => String(randomInt(1_000_000)).padStart(6, '0')).join('-');

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  let computers = 0;
  let keys = 0;
  for (const b of BRANCHES) {
    const { rows } = await client.query(
      `INSERT INTO branch (code, name) VALUES ($1, $2)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [b.code, b.name],
    );
    const branchId = rows[0].id;
    await client.query(`INSERT INTO branch_ou (branch_id, root_dn) VALUES ($1, lower($2)) ON CONFLICT DO NOTHING`, [branchId, b.ou]);

    for (let i = 1; i <= b.count; i++) {
      const name = `${b.code}-LT-${String(i).padStart(4, '0')}`;
      const dn = `CN=${name},OU=Laptops,${b.ou}`;
      const c = await client.query(
        `INSERT INTO computer (object_guid, name, dns_name, distinguished_name, branch_id, os, ad_created_at)
         SELECT $1, $2::varchar, $3, $4, $5, 'Windows 11 Enterprise', now() - interval '200 days'
          WHERE NOT EXISTS (SELECT 1 FROM computer WHERE name = $2::varchar)
         RETURNING id`,
        [randomUUID(), name, `${name.toLowerCase()}.corp.local`, dn, branchId],
      );
      if (!c.rows[0]) continue;
      computers++;
      // Every 4th machine has an older, superseded key as well.
      const keyCount = i % 4 === 0 ? 2 : 1;
      for (let k = 0; k < keyCount; k++) {
        const isOld = keyCount === 2 && k === 0;
        await client.query(
          `INSERT INTO recovery_key (computer_id, key_id, recovery_password, ad_created_at, status)
           VALUES ($1, $2, $3, now() - make_interval(days => $4), $5)`,
          [c.rows[0].id, randomUUID(), fakePassword(), isOld ? 400 : 180, isOld ? 'superseded' : 'active'],
        );
        keys++;
      }
    }
  }
  // A server outside every branch OU: only Admin HQ sees it.
  const srv = await client.query(
    `INSERT INTO computer (object_guid, name, distinguished_name, branch_id, os)
     SELECT $1, 'SRV-FILE-01', 'CN=SRV-FILE-01,OU=Servers,DC=corp,DC=local', NULL, 'Windows Server 2022'
      WHERE NOT EXISTS (SELECT 1 FROM computer WHERE name = 'SRV-FILE-01')
     RETURNING id`,
    [randomUUID()],
  );
  if (srv.rows[0]) {
    computers++;
    await client.query(
      `INSERT INTO recovery_key (computer_id, key_id, recovery_password, ad_created_at) VALUES ($1, $2, $3, now() - interval '30 days')`,
      [srv.rows[0].id, randomUUID(), fakePassword()],
    );
    keys++;
  }
  await client.query('COMMIT');
  console.log(`Seeded branches ${BRANCHES.map((b) => b.code).join(', ')}; added ${computers} computers and ${keys} keys.`);
} catch (err) {
  await client.query('ROLLBACK');
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
