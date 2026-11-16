import type { PoolClient } from "pg";
import { SYSTEM_PRINCIPAL, type Principal } from "../domain/enums.js";
import { getClient } from "./pool.js";

// Tells PostgreSQL who is asking, for Row-Level Security.
//
// The third argument of set_config (`true`) makes the setting local to this
// transaction: it disappears at COMMIT or ROLLBACK. That matters because the
// connection goes back to the pool and the next request, from a different
// user, will reuse it.
async function setIdentity(db: PoolClient, principal: Principal) {
  await db.query(
    `SELECT set_config('app.user_id', $1, true),
            set_config('app.role', $2, true),
            set_config('app.agency_id', $3, true)`,
    [principal.userId ?? "", principal.role, principal.agencyId ?? ""],
  );
}

// The one way into the database.
//
// tx() takes a connection from the pool, begins a transaction, sets the
// identity, runs `fn`, and commits. If `fn` throws, everything it did is
// rolled back.
export async function tx<T>(principal: Principal, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    await setIdentity(client, principal);

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

// Runs one part of a transaction as the system actor, then switches back.
//
// Some steps are the system's work even when a requester started the
// request: choosing an agent for a new ticket, or updating an agent's load
// counter. A requester's identity cannot do them, because Row-Level Security
// hides the agent tables from agencies, and that is how it should be.
// Rather than loosening those policies, the service says exactly which step
// runs as the system. It is still the same transaction, so it commits or
// rolls back together with everything else.
export async function asSystem<T>(
  db: PoolClient,
  principal: Principal,
  fn: () => Promise<T>,
): Promise<T> {
  await setIdentity(db, SYSTEM_PRINCIPAL);
  // If fn throws, the transaction is already failed and tx() rolls it back,
  // which also throws the identity away. So only the success path restores it.
  const result = await fn();
  await setIdentity(db, principal);
  return result;
}
