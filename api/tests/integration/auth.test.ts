import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import {
  closeTestPools,
  createAgency,
  createUser,
  ownerPool,
  TEST_PASSWORD,
  type TestUser,
} from "./helpers.js";

const app = createApp();
let user: TestUser;

beforeAll(async () => {
  const agency = await createAgency();
  user = await createUser("requester", { agencyId: agency.id });
});

afterAll(closeTestPools);

function login(email = user.email, password = TEST_PASSWORD) {
  return request(app).post("/api/v1/auth/login").send({ email, password });
}

function refresh(refreshToken: string) {
  return request(app).post("/api/v1/auth/refresh").send({ refresh_token: refreshToken });
}

describe("login", () => {
  it("returns an access token, a refresh token and the user", async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.body.access_token).toEqual(expect.any(String));
    expect(res.body.refresh_token).toEqual(expect.any(String));
    expect(res.body.expires_in).toBe(900);
    expect(res.body.user).toMatchObject({ id: user.id, email: user.email, role: "requester" });
  });

  it("never returns the password hash", async () => {
    const res = await login();
    expect(JSON.stringify(res.body)).not.toContain("argon2");
    expect(res.body.user.password_hash).toBeUndefined();
  });

  it("ignores the case of the email", async () => {
    const res = await login(user.email.toUpperCase());
    expect(res.status).toBe(200);
  });

  it("gives the same error for a wrong password and an unknown email", async () => {
    const wrongPassword = await login(user.email, "not-the-password");
    const unknownEmail = await login("nobody@test.example", TEST_PASSWORD);

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.detail).toBe(unknownEmail.body.detail);
    expect(wrongPassword.body.code).toBe("unauthorized");
  });

  it("rejects a deactivated user", async () => {
    const agency = await createAgency();
    const inactive = await createUser("requester", { agencyId: agency.id });
    await ownerPool.query("UPDATE users SET is_active = false WHERE id = $1", [inactive.id]);

    const res = await login(inactive.email);
    expect(res.status).toBe(401);
  });

  it("rejects unknown fields and bad input with 400", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "not-an-email", password: "x", is_admin: true });
    expect(res.status).toBe(400);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  it("stores only a hash of the refresh token", async () => {
    const res = await login();
    const rows = await ownerPool.query("SELECT 1 FROM refresh_tokens WHERE token_hash = $1", [
      res.body.refresh_token,
    ]);
    expect(rows.rowCount).toBe(0);
  });
});

describe("refresh", () => {
  it("swaps a refresh token for a new pair", async () => {
    const first = await login();
    const res = await refresh(first.body.refresh_token);

    expect(res.status).toBe(200);
    expect(res.body.access_token).toEqual(expect.any(String));
    expect(res.body.refresh_token).not.toBe(first.body.refresh_token);
  });

  it("rejects a token that does not exist", async () => {
    const res = await refresh("made-up-token");
    expect(res.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const first = await login();
    await ownerPool.query(
      `UPDATE refresh_tokens SET expires_at = now() - interval '1 minute'
        WHERE id = (SELECT id FROM refresh_tokens WHERE user_id = $1
                     ORDER BY created_at DESC LIMIT 1)`,
      [user.id],
    );
    const res = await refresh(first.body.refresh_token);
    expect(res.status).toBe(401);
  });

  it("reusing an old token revokes the whole family", async () => {
    const first = await login();
    const second = await refresh(first.body.refresh_token);
    expect(second.status).toBe(200);

    // The old token is replayed: this is what a thief would do.
    const replay = await refresh(first.body.refresh_token);
    expect(replay.status).toBe(401);

    // The newest token, which was valid a moment ago, is now dead too.
    const afterReplay = await refresh(second.body.refresh_token);
    expect(afterReplay.status).toBe(401);
  });

  // Hazard 9 in README section 9.
  it("the same token used 5 times at once succeeds exactly once", async () => {
    const first = await login();
    const token = first.body.refresh_token as string;

    const results = await Promise.all([1, 2, 3, 4, 5].map(() => refresh(token)));
    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([200, 401, 401, 401, 401]);

    // The losers saw a used token, so the family is revoked: even the
    // winner's new token no longer works.
    const winner = results.find((res) => res.status === 200)!;
    const next = await refresh(winner.body.refresh_token);
    expect(next.status).toBe(401);
  });
});

describe("logout", () => {
  it("ends the session", async () => {
    const first = await login();
    const out = await request(app)
      .post("/api/v1/auth/logout")
      .send({ refresh_token: first.body.refresh_token });
    expect(out.status).toBe(204);

    const res = await refresh(first.body.refresh_token);
    expect(res.status).toBe(401);
  });

  it("answers 204 for an unknown token too", async () => {
    const out = await request(app).post("/api/v1/auth/logout").send({ refresh_token: "unknown" });
    expect(out.status).toBe(204);
  });
});
