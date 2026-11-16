import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../src/core/config.js";

// A small forward-only migration runner.
//
// It applies every .sql file in api/migrations in name order, each inside its
// own transaction, and records the file name in schema_migrations so a file
// never runs twice. There is no "down": a mistake is fixed by a new file.
//
// It connects as the owner role, never as the app role.

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

// `database` is only passed by tests, which use a second database.
export function ownerClient(database = config.db.database) {
  return new pg.Client({
    host: config.db.host,
    port: config.db.port,
    database,
    user: config.db.owner.user,
    password: config.db.owner.password,
  });
}

export async function migrate(
  log: (line: string) => void = console.log,
  database = config.db.database,
) {
  const client = ownerClient(database);
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    const applied = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const appliedNames = new Set(applied.rows.map((row) => row.name));

    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of files) {
      if (appliedNames.has(file)) continue;

      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      // The migration and its bookkeeping row commit together, or not at all.
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed`, { cause: err });
      }
      log(`applied ${file}`);
    }

    // Give the app role its password from config, so no password is ever
    // written in a migration file. ALTER ROLE cannot take a $1 parameter, so
    // format(%L) is used to quote the value safely.
    const alter = await client.query<{ sql: string }>(
      "SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql",
      [config.db.app.user, config.db.app.password],
    );
    await client.query(alter.rows[0]!.sql);
  } finally {
    await client.end();
  }
}

// Run only when started directly (npm run migrate), not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await migrate();
  console.log("migrations up to date");
}
