import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import type { z } from "zod";
import { requirePermission } from "../core/auth.js";
import { AppError, conflict, unprocessable } from "../core/errors.js";
import { asSystem, tx } from "../db/tx.js";
import { SYSTEM_PRINCIPAL, type Principal, type Role } from "../domain/enums.js";
import type { inviteSchema, signupSchema } from "../schemas/auth.js";
import { sendAccountMail } from "./accountMail.js";
import { hashPassword, hashToken, startSession } from "./authService.js";

// Self-service accounts: sign up, verify the email, reset a password, and
// staff invitations. Every write runs as the system actor (nobody is logged
// in yet), and every email is sent AFTER the transaction commits.
//
// Account enumeration: a stranger must not learn whether an email address
// has an account. So "sign up", "forgot password" and "resend the link"
// always answer 202 the same way, the email itself says what happened, and
// the email is sent without waiting for it, so the answer also takes the
// same time either way.

type Purpose = "verify_email" | "reset_password" | "invite";

const TOKEN_HOURS: Record<Purpose, number> = {
  verify_email: 48,
  reset_password: 1,
  invite: 24 * 7,
};

type AccountRow = {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  agency_id: string | null;
  team_id: string | null;
  email_verified_at: Date | null;
};

const ACCOUNT_COLUMNS = "id, email, full_name, role, agency_id, team_id, email_verified_at";

const invalidLink = () =>
  new AppError(
    400,
    "invalid_token",
    "Invalid link",
    "This link is invalid, expired or already used.",
  );

// Makes a new token for a person, retiring any live one of the same kind.
// The person's row is locked first, so two "send me a new link" requests at
// the same moment queue up instead of both inserting (the partial unique
// index auth_tokens_one_live would reject the second).
async function issueToken(db: PoolClient, userId: string, purpose: Purpose): Promise<string> {
  await db.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
  await db.query(
    "UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL",
    [userId, purpose],
  );
  const token = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
    [userId, purpose, hashToken(token), TOKEN_HOURS[purpose]],
  );
  return token;
}

// Uses up a token in ONE statement, like the refresh token claim: if the
// same link is opened twice at once, only one UPDATE matches.
async function claimToken(db: PoolClient, token: string, purpose: Purpose): Promise<AccountRow> {
  const claimed = await db.query<{ user_id: string }>(
    `UPDATE auth_tokens SET used_at = now()
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [hashToken(token), purpose],
  );
  const userId = claimed.rows[0]?.user_id;
  if (!userId) throw invalidLink();

  const user = await db.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id = $1 AND is_active`,
    [userId],
  );
  if (!user.rows[0]) throw invalidLink();
  return user.rows[0];
}

async function findByEmail(db: PoolClient, email: string): Promise<AccountRow | undefined> {
  const result = await db.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM users WHERE lower(email) = lower($1) AND is_active`,
    [email],
  );
  return result.rows[0];
}

// "Skyline Travels" -> "skyline-travels"
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "agency";
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e.code === "23505" && e.constraint === constraint;
}

// ---------------------------------------------------------------------------
// Sign up: a new travel agency and its first user.
// ---------------------------------------------------------------------------

export async function signup(input: z.infer<typeof signupSchema>): Promise<void> {
  // Slow on purpose (argon2id), so done before the transaction: no database
  // connection is held while it runs. Done for every sign-up, also for an
  // email that already exists, so both take the same time.
  const passwordHash = await hashPassword(input.password);

  let outcome: { kind: "created"; token: string } | { kind: "exists"; name: string };
  try {
    outcome = await tx(SYSTEM_PRINCIPAL, async (db) => {
      const existing = await findByEmail(db, input.email);
      if (existing) return { kind: "exists" as const, name: existing.full_name };

      const nameTaken = await db.query("SELECT 1 FROM agencies WHERE lower(name) = lower($1)", [
        input.agency_name,
      ]);
      if (nameTaken.rowCount) {
        throw conflict(
          "agency_exists",
          "An agency with this name already uses OpsDesk. Ask a colleague there, or contact support.",
        );
      }

      // The slug must be unique too; on a clash add a short random suffix.
      let slug = slugify(input.agency_name);
      const slugTaken = await db.query("SELECT 1 FROM agencies WHERE slug = $1", [slug]);
      if (slugTaken.rowCount) slug = `${slug}-${randomBytes(3).toString("hex")}`;

      const agency = await db.query<{ id: string }>(
        "INSERT INTO agencies (slug, name) VALUES ($1, $2) RETURNING id",
        [slug, input.agency_name],
      );
      const user = await db.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, full_name, role, agency_id)
         VALUES ($1, $2, $3, 'requester', $4) RETURNING id`,
        [input.email, passwordHash, input.full_name, agency.rows[0]!.id],
      );
      const token = await issueToken(db, user.rows[0]!.id, "verify_email");
      return { kind: "created" as const, token };
    });
  } catch (err) {
    // Two sign-ups with the same email at the same moment: the unique index
    // lets one through; the other is told (by email) the account exists.
    if (isUniqueViolation(err, "users_email_unique")) {
      outcome = { kind: "exists", name: input.full_name };
    } else {
      throw err;
    }
  }

  void sendAccountMail(
    outcome.kind === "created"
      ? { kind: "verify_email", to: input.email, name: input.full_name, token: outcome.token }
      : { kind: "already_registered", to: input.email, name: outcome.name },
  );
}

export async function resendVerification(email: string): Promise<void> {
  const found = await tx(SYSTEM_PRINCIPAL, async (db) => {
    const user = await findByEmail(db, email);
    if (!user || user.email_verified_at) return null;
    return { user, token: await issueToken(db, user.id, "verify_email") };
  });
  if (found) {
    void sendAccountMail({
      kind: "verify_email",
      to: found.user.email,
      name: found.user.full_name,
      token: found.token,
    });
  }
}

// Opening the link proves the person owns the address; they are signed in.
export async function verifyEmail(token: string) {
  const user = await tx(SYSTEM_PRINCIPAL, async (db) => {
    const user = await claimToken(db, token, "verify_email");
    await db.query(
      "UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1",
      [user.id],
    );
    return user;
  });
  return startSession(user);
}

// ---------------------------------------------------------------------------
// Forgotten password
// ---------------------------------------------------------------------------

export async function forgotPassword(email: string): Promise<void> {
  const found = await tx(SYSTEM_PRINCIPAL, async (db) => {
    const user = await findByEmail(db, email);
    if (!user) return null;
    return { user, token: await issueToken(db, user.id, "reset_password") };
  });
  if (found) {
    void sendAccountMail({
      kind: "reset_password",
      to: found.user.email,
      name: found.user.full_name,
      token: found.token,
    });
  }
}

// A new password ends every session: if someone else knew the old one, the
// refresh tokens they hold stop working now. The link also proves the
// mailbox, so the address counts as verified.
export async function resetPassword(token: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  await tx(SYSTEM_PRINCIPAL, async (db) => {
    const user = await claimToken(db, token, "reset_password");
    await setPassword(db, user.id, passwordHash);
  });
}

async function setPassword(db: PoolClient, userId: string, passwordHash: string) {
  await db.query(
    `UPDATE users SET password_hash = $2, email_verified_at = COALESCE(email_verified_at, now())
      WHERE id = $1`,
    [userId, passwordHash],
  );
  await db.query(
    "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
    [userId],
  );
}

// ---------------------------------------------------------------------------
// Staff invitations. Staff never sign up themselves: a lead adds them.
// ---------------------------------------------------------------------------

export type Invitation = {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  team_id: string;
  email_sent: boolean;
};

export async function inviteStaff(
  principal: Principal,
  input: z.infer<typeof inviteSchema>,
): Promise<Invitation> {
  requirePermission(principal, "staff:invite");

  // Until they accept, the account has a password nobody knows (the hash of
  // random bytes), so it cannot be used to log in.
  const placeholderHash = await hashPassword(randomBytes(32).toString("hex"));

  const created = await tx(principal, async (db) => {
    const team = await db.query("SELECT 1 FROM teams WHERE id = $1", [input.team_id]);
    if (!team.rowCount) throw unprocessable("invalid_team", "No such team.");

    const existing = await findByEmail(db, input.email);
    // Invited before but never accepted (staff, not verified): send a fresh
    // link instead, so a lost email is not a dead end. The account keeps the
    // role and team of the first invitation.
    const pending =
      existing && existing.agency_id === null && existing.email_verified_at === null
        ? existing
        : null;
    // Otherwise the address is taken. The lead is staff, so saying so reveals nothing.
    if (existing && !pending) {
      throw conflict("email_taken", "Someone with this email address already has an account.");
    }

    // Creating users is the system's work (RLS); the permission check above
    // is what makes it allowed here.
    return asSystem(db, principal, async () => {
      let account = pending;
      if (!account) {
        const user = await db.query<AccountRow>(
          `INSERT INTO users (email, password_hash, full_name, role, team_id)
           VALUES ($1, $2, $3, $4, $5) RETURNING ${ACCOUNT_COLUMNS}`,
          [input.email, placeholderHash, input.full_name, input.role, input.team_id],
        );
        account = user.rows[0]!;
      }
      const inviter = await db.query<{ full_name: string }>(
        "SELECT full_name FROM users WHERE id = $1",
        [principal.userId],
      );
      return {
        account,
        token: await issueToken(db, account.id, "invite"),
        invitedBy: inviter.rows[0]?.full_name ?? "Your team lead",
      };
    });
  }).catch((err: unknown) => {
    // Two invitations for one address at the same moment.
    if (isUniqueViolation(err, "users_email_unique")) {
      throw conflict("email_taken", "Someone with this email address already has an account.");
    }
    throw err;
  });

  // Here the lead waits for the email, so they can be told if it failed.
  const { account } = created;
  const sent = await sendAccountMail({
    kind: "invite",
    to: account.email,
    name: account.full_name,
    token: created.token,
    invitedBy: created.invitedBy,
  });

  return {
    id: account.id,
    email: account.email,
    full_name: account.full_name,
    role: account.role,
    team_id: account.team_id!,
    email_sent: sent,
  };
}

export async function acceptInvite(token: string, password: string) {
  const passwordHash = await hashPassword(password);
  const user = await tx(SYSTEM_PRINCIPAL, async (db) => {
    const user = await claimToken(db, token, "invite");
    await setPassword(db, user.id, passwordHash);
    return user;
  });
  return startSession(user);
}
