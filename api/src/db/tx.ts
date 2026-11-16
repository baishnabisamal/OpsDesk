import type { PoolClient } from "pg";
import type { Principal } from "../domain/enums.js";
import { getClient } from "./pool.js";

// The one way into the database.
//
// tx() takes a connection from the pool, begins a transaction, tells
// PostgreSQL who is asking, runs `fn`, and commits. If `fn` throws, everything
// it did is rolled back.
//
// The third argument of set_config (`true`) makes the setting local to this
// transaction: it disappears at COMMIT or ROLLBACK. That matters because the
// connection goes back to the pool and the next request, from a different
// user, will reuse it.
export async function tx<T>(principal: Principal, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.role', $2, true),
              set_config('app.agency_id', $3, true)`,
      [principal.userId ?? "", principal.role, principal.agencyId ?? ""],
    );

    const result = await fn(client);

    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
