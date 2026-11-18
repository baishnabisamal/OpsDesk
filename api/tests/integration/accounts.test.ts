import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../../src/app.js";
import { bearer, closeTestPools, createTeam, createUser, ownerPool } from "./helpers.js";

// Sign-up, email verification, password reset and staff invitations, end to
// end: the emails are read back from a real (throwaway) Mailpit and the links
// in them are followed, the way a person would.

const app = createApp();
const mailpitUrl = inject("mailpitUrl");
const PASSWORD = "a-long-enough-password";

afterAll(closeTestPools);

type MailpitSummary = { ID: string; To: { Address: string }[]; Subject: string };

// Account emails are sent without waiting (so every answer takes the same
// time), so poll Mailpit until the expected number of emails has arrived.
async function mailsTo(address: string, expected = 1, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(
      `${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
    );
    const body = (await res.json()) as { messages: MailpitSummary[] };
    if (body.messages.length >= expected || Date.now() > deadline) return body.messages;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function mailText(id: string): Promise<string> {
  const res = await fetch(`${mailpitUrl}/api/v1/message/${id}`);
  return ((await res.json()) as { Text: string }).Text;
}

// The newest link in the newest email to this address.
async function tokenFrom(address: string, expected = 1): Promise<string> {
  const mails = await mailsTo(address, expected);
  expect(mails.length).toBeGreaterThanOrEqual(expected);
  const text = await mailText(mails[0]!.ID); // Mailpit lists newest first
  const match = /#token=([A-Za-z0-9_-]+)/.exec(text);
  if (!match) throw new Error(`no link in: ${text}`);
  return match[1]!;
}

const unique = () => randomUUID().slice(0, 8);
const newSignup = () => {
  const tag = unique();
  return {
    agency_name: `Agency ${tag}`,
    full_name: "Asha Rao",
    email: `asha.${tag}@agency.example`,
    password: PASSWORD,
  };
};

const login = (email: string, password = PASSWORD) =>
  request(app).post("/api/v1/auth/login").send({ email, password });

describe("sign up and verify the email", () => {
  it("creates the agency and user, but login waits for the emailed link", async () => {
    const input = newSignup();
    const res = await request(app).post("/api/v1/auth/signup").send(input);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "check_email" });

    const before = await login(input.email);
    expect(before.status).toBe(403);
    expect(before.body.code).toBe("email_not_verified");

    const token = await tokenFrom(input.email);
    const verified = await request(app).post("/api/v1/auth/verify-email").send({ token });
    expect(verified.status).toBe(200);
    expect(verified.body.user).toMatchObject({ email: input.email, role: "requester" });
    expect(verified.body.access_token).toEqual(expect.any(String));

    // The new agency exists and the user belongs to it.
    const agency = await ownerPool.query<{ id: string; slug: string }>(
      "SELECT id, slug FROM agencies WHERE name = $1",
      [input.agency_name],
    );
    expect(verified.body.user.agency_id).toBe(agency.rows[0]!.id);
    expect(agency.rows[0]!.slug).toBe(input.agency_name.toLowerCase().replace(" ", "-"));

    expect((await login(input.email)).status).toBe(200);

    // The link works once.
    const again = await request(app).post("/api/v1/auth/verify-email").send({ token });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe("invalid_token");
  });

  it("the new user only sees their own agency (RLS applies from the first request)", async () => {
    const input = newSignup();
    await request(app).post("/api/v1/auth/signup").send(input);
    const session = await request(app)
      .post("/api/v1/auth/verify-email")
      .send({ token: await tokenFrom(input.email) });
    const list = await request(app)
      .get("/api/v1/tickets")
      .set({ Authorization: `Bearer ${session.body.access_token}` });
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([]);
  });

  it("an existing email gets the same 202, an 'already registered' email, and no second account", async () => {
    const input = newSignup();
    await request(app).post("/api/v1/auth/signup").send(input);
    await mailsTo(input.email, 1);

    const second = await request(app)
      .post("/api/v1/auth/signup")
      .send({ ...input, agency_name: `Other ${unique()}`, email: input.email.toUpperCase() });
    expect(second.status).toBe(202);
    expect(second.body).toEqual({ status: "check_email" });

    const mails = await mailsTo(input.email, 2);
    expect(mails.map((mail) => mail.Subject)).toContain("You already have an OpsDesk account");
    const users = await ownerPool.query("SELECT 1 FROM users WHERE lower(email) = lower($1)", [
      input.email,
    ]);
    expect(users.rowCount).toBe(1);
  });

  it("refuses a second agency with the same name", async () => {
    const input = newSignup();
    await request(app).post("/api/v1/auth/signup").send(input);
    const res = await request(app)
      .post("/api/v1/auth/signup")
      .send({ ...newSignup(), agency_name: input.agency_name.toUpperCase() });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("agency_exists");
  });

  it("refuses a short password and unknown fields", async () => {
    const short = await request(app)
      .post("/api/v1/auth/signup")
      .send({ ...newSignup(), password: "short" });
    expect(short.status).toBe(400);
    const extra = await request(app)
      .post("/api/v1/auth/signup")
      .send({ ...newSignup(), role: "lead" });
    expect(extra.status).toBe(400);
  });

  it("10 sign-ups with one email at the same moment create exactly one account", async () => {
    const input = newSignup();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        request(app)
          .post("/api/v1/auth/signup")
          .send({ ...input, agency_name: `${input.agency_name} ${i}` }),
      ),
    );
    expect(results.every((res) => res.status === 202)).toBe(true);
    const users = await ownerPool.query("SELECT 1 FROM users WHERE lower(email) = lower($1)", [
      input.email,
    ]);
    expect(users.rowCount).toBe(1);
  });

  it("a new link retires the old one; resend does nothing for a verified address", async () => {
    const input = newSignup();
    await request(app).post("/api/v1/auth/signup").send(input);
    const first = await tokenFrom(input.email, 1);
    const resend = await request(app)
      .post("/api/v1/auth/verify-email/resend")
      .send({ email: input.email });
    expect(resend.status).toBe(202);
    const second = await tokenFrom(input.email, 2);
    expect(second).not.toBe(first);

    expect(
      (await request(app).post("/api/v1/auth/verify-email").send({ token: first })).status,
    ).toBe(400);
    expect(
      (await request(app).post("/api/v1/auth/verify-email").send({ token: second })).status,
    ).toBe(200);

    await request(app).post("/api/v1/auth/verify-email/resend").send({ email: input.email });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await mailsTo(input.email, 3, 300)).toHaveLength(2);
  });

  it("the same link opened twice at once signs in exactly once", async () => {
    const input = newSignup();
    await request(app).post("/api/v1/auth/signup").send(input);
    const token = await tokenFrom(input.email);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post("/api/v1/auth/verify-email").send({ token }),
      ),
    );
    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    expect(results.filter((res) => res.status === 400)).toHaveLength(4);
  });
});

describe("forgotten password", () => {
  async function verifiedUser() {
    const input = newSignup();
    await request(app).post("/api/v1/auth/signup").send(input);
    const session = await request(app)
      .post("/api/v1/auth/verify-email")
      .send({ token: await tokenFrom(input.email) });
    return { input, session: session.body as { refresh_token: string } };
  }

  it("an unknown email gets the same 202 and no email", async () => {
    const email = `nobody.${unique()}@agency.example`;
    const res = await request(app).post("/api/v1/auth/password/forgot").send({ email });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "check_email" });
    expect(await mailsTo(email, 1, 500)).toHaveLength(0);
  });

  it("resets the password with the emailed link and ends every old session", async () => {
    const { input, session } = await verifiedUser();
    await request(app).post("/api/v1/auth/password/forgot").send({ email: input.email });
    const token = await tokenFrom(input.email, 2);

    const reset = await request(app)
      .post("/api/v1/auth/password/reset")
      .send({ token, password: "a-brand-new-password" });
    expect(reset.status).toBe(204);

    expect((await login(input.email)).status).toBe(401);
    expect((await login(input.email, "a-brand-new-password")).status).toBe(200);
    // The refresh token from before the reset no longer works.
    const refresh = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refresh_token: session.refresh_token });
    expect(refresh.status).toBe(401);
  });

  it("an expired link is refused", async () => {
    const { input } = await verifiedUser();
    await request(app).post("/api/v1/auth/password/forgot").send({ email: input.email });
    const token = await tokenFrom(input.email, 2);
    await ownerPool.query(
      `UPDATE auth_tokens SET created_at = now() - interval '3 hours', expires_at = now() - interval '1 hour'
        WHERE purpose = 'reset_password' AND used_at IS NULL
          AND user_id = (SELECT id FROM users WHERE email = $1)`,
      [input.email],
    );
    const res = await request(app)
      .post("/api/v1/auth/password/reset")
      .send({ token, password: "a-brand-new-password" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_token");
  });

  it("a verify link cannot be used as a reset link", async () => {
    const input = newSignup();
    await request(app).post("/api/v1/auth/signup").send(input);
    const token = await tokenFrom(input.email);
    const res = await request(app)
      .post("/api/v1/auth/password/reset")
      .send({ token, password: "a-brand-new-password" });
    expect(res.status).toBe(400);
  });

  it("only hashes are stored", async () => {
    const input = newSignup();
    await request(app).post("/api/v1/auth/signup").send(input);
    const token = await tokenFrom(input.email);
    const stored = await ownerPool.query("SELECT 1 FROM auth_tokens WHERE token_hash = $1", [
      token,
    ]);
    expect(stored.rowCount).toBe(0);
  });
});

describe("staff invitations", () => {
  it("a lead invites an agent, who sets a password and is signed in", async () => {
    const teamId = await createTeam("EU");
    const lead = await createUser("lead", { teamId });
    const email = `new.agent.${unique()}@opsdesk.example`;

    const res = await request(app)
      .post("/api/v1/staff/invites")
      .set(bearer(lead))
      .send({ email, full_name: "Kiran Mehta", role: "agent", team_id: teamId });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email, role: "agent", team_id: teamId, email_sent: true });

    // Before accepting, nobody can log in as them.
    expect((await login(email)).status).toBe(401);

    const token = await tokenFrom(email);
    const accepted = await request(app)
      .post("/api/v1/auth/invites/accept")
      .send({ token, password: PASSWORD });
    expect(accepted.status).toBe(200);
    expect(accepted.body.user).toMatchObject({
      email,
      role: "agent",
      team_id: teamId,
      agency_id: null,
    });
    expect((await login(email)).status).toBe(200);
  });

  it("inviting a person who has not accepted yet sends a fresh link; the old one stops working", async () => {
    const teamId = await createTeam("EU");
    const lead = await createUser("lead", { teamId });
    const email = `pending.${unique()}@opsdesk.example`;
    const body = { email, full_name: "Ravi Nair", role: "agent", team_id: teamId };

    expect(
      (await request(app).post("/api/v1/staff/invites").set(bearer(lead)).send(body)).status,
    ).toBe(201);
    const first = await tokenFrom(email, 1);
    const again = await request(app).post("/api/v1/staff/invites").set(bearer(lead)).send(body);
    expect(again.status).toBe(201);
    const second = await tokenFrom(email, 2);

    const old = await request(app)
      .post("/api/v1/auth/invites/accept")
      .send({ token: first, password: PASSWORD });
    expect(old.status).toBe(400);
    const ok = await request(app)
      .post("/api/v1/auth/invites/accept")
      .send({ token: second, password: PASSWORD });
    expect(ok.status).toBe(200);

    // Accepted now, so a third invitation is refused.
    const third = await request(app).post("/api/v1/staff/invites").set(bearer(lead)).send(body);
    expect(third.status).toBe(409);
  });

  it("only leads may invite", async () => {
    const teamId = await createTeam("EU");
    for (const role of ["agent", "escalation_manager"] as const) {
      const user = await createUser(role, { teamId });
      const res = await request(app)
        .post("/api/v1/staff/invites")
        .set(bearer(user))
        .send({
          email: `x.${unique()}@opsdesk.example`,
          full_name: "X",
          role: "agent",
          team_id: teamId,
        });
      expect(res.status).toBe(403);
    }
  });

  it("refuses an address that already has an account, and an unknown team", async () => {
    const teamId = await createTeam("EU");
    const lead = await createUser("lead", { teamId });
    const taken = await request(app)
      .post("/api/v1/staff/invites")
      .set(bearer(lead))
      .send({ email: lead.email, full_name: "Dup", role: "agent", team_id: teamId });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe("email_taken");

    const noTeam = await request(app)
      .post("/api/v1/staff/invites")
      .set(bearer(lead))
      .send({
        email: `y.${unique()}@opsdesk.example`,
        full_name: "Y",
        role: "agent",
        team_id: randomUUID(),
      });
    expect(noTeam.status).toBe(422);
  });

  it("cannot invite a lead (no self-made admins)", async () => {
    const teamId = await createTeam("EU");
    const lead = await createUser("lead", { teamId });
    const res = await request(app)
      .post("/api/v1/staff/invites")
      .set(bearer(lead))
      .send({
        email: `z.${unique()}@opsdesk.example`,
        full_name: "Z",
        role: "lead",
        team_id: teamId,
      });
    expect(res.status).toBe(400);
  });
});

describe("the app role cannot write accounts on its own", () => {
  it("as a requester, inserting a user is refused by RLS", async () => {
    // Direct proof at the database level, with the app's own connection.
    const { appPool } = await import("./helpers.js");
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.role', 'requester', true)");
      await expect(
        client.query(
          "INSERT INTO users (email, password_hash, full_name, role) VALUES ('h@x.example', 'x', 'H', 'lead')",
        ),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
