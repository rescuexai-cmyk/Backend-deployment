/**
 * PostgreSQL connection pool.
 *
 * For local dev  → standard `pg` Pool with env vars.
 * For production → swap this single file to use @neondatabase/serverless
 *                  and the rest of the codebase stays unchanged.
 */

const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.PGHOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'raahi',
  user:     process.env.PGUSER     || 'raahi',
  password: process.env.PGPASSWORD || 'raahi_dev_2024',
  max:      20,                      // connection pool size
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Log pool errors so they don't crash the process
pool.on('error', (err) => {
  console.error('⚠️  Unexpected PG pool error:', err.message);
});

/**
 * Convenience: run a single query.
 *   const { rows } = await db.query('SELECT ...', [params]);
 */
async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const ms = Date.now() - start;
  if (ms > 200) {
    console.log(`🐢 Slow query (${ms}ms): ${text.substring(0, 80)}`);
  }
  return result;
}

/**
 * Get a dedicated client for transactions.
 *   const client = await db.getClient();
 *   try { await client.query('BEGIN'); ... await client.query('COMMIT'); }
 *   catch { await client.query('ROLLBACK'); throw e; }
 *   finally { client.release(); }
 */
async function getClient() {
  return pool.connect();
}

/** Health check — can the pool reach Postgres? */
async function healthCheck() {
  try {
    const { rows } = await pool.query('SELECT 1 AS ok');
    return rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

module.exports = { query, getClient, healthCheck, pool };
