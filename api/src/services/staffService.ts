import { requirePermission } from "../core/auth.js";
import { tx } from "../db/tx.js";
import type { Principal, Role } from "../domain/enums.js";

// The staff directory: who works here, in which team, and how busy they are.
// The UI needs it to show names instead of ids, and to offer "assign to" for
// leads. Requesters cannot read it (queue:read is staff only).

export type StaffMember = {
  id: string;
  full_name: string;
  role: Role;
  team_id: string | null;
  team_name: string | null;
  region_code: string | null;
  // From agent_presence. A person who never went online has no row there,
  // so these default to offline with no tickets.
  is_online: boolean;
  open_count: number;
  max_open: number | null;
  // Invited but has not chosen a password yet (migration 015).
  invite_pending: boolean;
};

export async function listStaff(principal: Principal): Promise<StaffMember[]> {
  requirePermission(principal, "queue:read");
  return tx(principal, async (db) => {
    const result = await db.query<StaffMember>(
      `SELECT u.id, u.full_name, u.role, u.team_id,
              t.name AS team_name, t.region_code,
              COALESCE(p.is_online, false) AS is_online,
              COALESCE(p.open_count, 0) AS open_count,
              p.max_open,
              u.email_verified_at IS NULL AS invite_pending
         FROM users u
         LEFT JOIN teams t ON t.id = u.team_id
         LEFT JOIN agent_presence p ON p.user_id = u.id
        WHERE u.agency_id IS NULL AND u.is_active
        ORDER BY t.region_code NULLS LAST, u.role, u.full_name
        LIMIT 1000`,
    );
    return result.rows;
  });
}
