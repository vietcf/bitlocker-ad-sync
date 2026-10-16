import pg from 'pg';

/** Connection pool for the runtime account (app_node). */
export function createPool(config) {
  return new pg.Pool({
    connectionString: config.DATABASE_URL,
    ssl: config.DB_SSL ? { rejectUnauthorized: true } : undefined,
    max: config.DB_POOL_MAX,
    // pg logs nothing itself; statement text never reaches our logger either.
    application_name: 'blk-node',
  });
}
