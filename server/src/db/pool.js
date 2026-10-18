import pg from 'pg';

/** Connection pool for the runtime account (app_node). */
export function createPool(config) {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    ssl: config.DB_SSL ? { rejectUnauthorized: true } : undefined,
    max: config.DB_POOL_MAX,
    // pg logs nothing itself; statement text never reaches our logger either.
    application_name: 'blk-node',
    // Het pool thi bao loi sau 15 s thay vi treo request; cau lenh qua 120 s bi huy.
    connectionTimeoutMillis: 15_000,
    statement_timeout: 120_000,
    idleTimeoutMillis: 30_000,
  });
  // Ket noi nhan roi bi dong (DB restart, dut mang): pg phat 'error' tren pool. Khong co listener thi
  // Node thoat; o day chi ghi log, ket noi hong bi bo va pool tu mo ket noi moi.
  pool.on('error', (err) => console.error(JSON.stringify({ level: 'error', msg: 'idle database connection failed', code: err.code, message: err.message })));
  return pool;
}
