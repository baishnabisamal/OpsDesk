import { createHash, randomBytes, randomUUID } from "node:crypto";
import argon2 from "argon2";
import type { PoolClient } from "pg";
import { signAccessToken, type TokenUser } from "../core/auth.js";
import { config } from "../core/config.js";
import { unauthorized } from "../core/errors.js";
import { tx } from "../db/tx.js";
import { SYSTEM_PRINCIPAL, type Role } from "../domain/enums.js";

// Login and refresh run as the system actor: there is no user identity yet.

type UserRow = {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  agency_id: string | null;
  team_id: string | null;
  password_hash: string;
};

const USER_COLUMNS = "id, email, full_name, role, agency_id, team_id, password_hash";

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

// Only the SHA-256 hash of a refresh token is stored. If the table leaks,
// the hashes cannot be used to log in.
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// A hash of a random password, made once. When the email is unknown we still
// verify against this, so "no such user" takes as long as "wrong password".
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyHash;
}

async function issueRefreshToken(
  db: PoolClient,
  userId: string,
  familyId: string,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
    [userId, familyId, hashToken(token), config.refreshTokenTtlDays],
  );
  return token;
}

function buildSession(user: UserRow, refreshToken: string) {
  const tokenUser: TokenUser = {
    id: user.id,
    role: user.role,
    agencyId: user.agency_id,
    teamId: user.team_id,
  };
  return {
    access_token: signAccessToken(tokenUser),
    token_type: "Bearer",
    expires_in: config.accessTokenTtlSeconds,
    refresh_token: refreshToken,
    user: {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      agency_id: user.agency_id,
      team_id: user.team_id,
    },
  };
}

export async function login(email: string, password: string) {
  // Step 1: read the user. Password hashing is slow on purpose, so it is done
  // outside the transaction and no database connection is held while it runs.
  const user = await tx(SYSTEM_PRINCIPAL, async (db) => {
    const result = await db.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower($1) AND is_active`,
      [email],
    );
    return result.rows[0];
  });

  const passwordOk = await argon2.verify(user?.password_hash ?? (await getDummyHash()), password);
  if (!user || !passwordOk) {
    // The same answer whether the email or the password was wrong.
    throw unauthorized("Email or password is incorrect.");
  }

  // Step 2: start a new token family for this login.
  const refreshToken = await tx(SYSTEM_PRINCIPAL, (db) =>
    issueRefreshToken(db, user.id, randomUUID()),
  );
  return buildSession(user, refreshToken);
}

export async function refresh(refreshToken: string) {
  const tokenHash = hashToken(refreshToken);

  const session = await tx(SYSTEM_PRINCIPAL, async (db) => {
    // Hazard 9: claim the token in ONE statement. If two requests send the
    // same token together, both run this UPDATE, the second waits for the
    // first to commit, then sees used_at is no longer NULL and matches nothing.
    const claimed = await db.query<{ user_id: string; family_id: string }>(
      `UPDATE refresh_tokens
          SET used_at = now()
        WHERE token_hash = $1
          AND used_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > now()
        RETURNING user_id, family_id`,
      [tokenHash],
    );
    const token = claimed.rows[0];

    if (!token) {
      // Not claimable. If the token exists and was already used, someone is
      // replaying it, which means it was stolen: end every session that came
      // from the same login. We return null instead of throwing here so this
      // revocation is committed.
      await db.query(
        `UPDATE refresh_tokens
            SET revoked_at = now()
          WHERE revoked_at IS NULL
            AND family_id = (SELECT family_id FROM refresh_tokens
                              WHERE token_hash = $1 AND used_at IS NOT NULL)`,
        [tokenHash],
      );
      return null;
    }

    const userResult = await db.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND is_active`,
      [token.user_id],
    );
    const user = userResult.rows[0];
    if (!user) return null;

    // Rotation: the old token is now used up; hand out a new one in the same family.
    const newToken = await issueRefreshToken(db, user.id, token.family_id);
    return buildSession(user, newToken);
  });

  if (!session) {
    throw unauthorized("The refresh token is invalid, expired or already used.");
  }
  return session;
}

// Logging out ends the whole family. An unknown token is ignored, so the
// response does not reveal whether a token exists.
export async function logout(refreshToken: string) {
  await tx(SYSTEM_PRINCIPAL, async (db) => {
    await db.query(
      `UPDATE refresh_tokens
          SET revoked_at = now()
        WHERE revoked_at IS NULL
          AND family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
      [hashToken(refreshToken)],
    );
  });
}
