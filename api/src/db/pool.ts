import pg from "pg";
import { config } from "../core/config.js";

// The connection pool for the API. It logs in as the app role, which owns
// nothing and cannot bypass Row-Level Security.
// The pool itself is not exported: queries must go through tx() in tx.ts.
const pool = new pg.Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.app.user,
  password: config.db.app.password,
  max: 10,
});

export function getClient() {
  return pool.connect();
}

// Used by /readyz only. It reads no table, so it needs no identity.
export async function pingDatabase(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export function closePool() {
  return pool.end();
}

// For the metrics page: how busy the pool is right now.
export function poolStats() {
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
}
