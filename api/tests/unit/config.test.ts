import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config.js";

const validEnv = {
  POSTGRES_DB: "opsdesk",
  POSTGRES_USER: "owner",
  POSTGRES_PASSWORD: "owner-password",
  APP_DB_PASSWORD: "app-password",
  JWT_SECRET: "x".repeat(32),
  ML_SHARED_SECRET: "m".repeat(16),
  INBOUND_WEBHOOK_SECRET: "w".repeat(32),
};

describe("config", () => {
  it("loads a valid environment and fills in defaults", () => {
    const config = loadConfig(validEnv);
    expect(config.port).toBe(3000);
    expect(config.db.host).toBe("localhost");
    expect(config.db.app.user).toBe("opsdesk_app");
    expect(config.accessTokenTtlSeconds).toBe(900);
  });

  it("converts numbers from strings", () => {
    const config = loadConfig({ ...validEnv, API_PORT: "4000", POSTGRES_PORT: "5433" });
    expect(config.port).toBe(4000);
    expect(config.db.port).toBe(5433);
  });

  it("refuses to start without a JWT secret", () => {
    const env = { ...validEnv, JWT_SECRET: undefined };
    expect(() => loadConfig(env)).toThrow(/JWT_SECRET/);
  });

  it("refuses a short JWT secret", () => {
    expect(() => loadConfig({ ...validEnv, JWT_SECRET: "short" })).toThrow(/at least 32/);
  });

  it("trusts no proxy and sends mail without a login by default (local Mailpit)", () => {
    const config = loadConfig(validEnv);
    expect(config.trustProxy).toBe(0);
    expect(config.mail.smtpSecure).toBe(false);
    expect(config.mail.smtpAuth).toBeNull();
  });

  it("reads the deployment settings: one proxy, a mail provider login, TLS", () => {
    const config = loadConfig({
      ...validEnv,
      TRUST_PROXY: "1",
      SMTP_USER: "relay-user",
      SMTP_PASSWORD: "relay-password",
      SMTP_SECURE: "true",
    });
    expect(config.trustProxy).toBe(1);
    expect(config.mail.smtpSecure).toBe(true);
    expect(config.mail.smtpAuth).toEqual({ user: "relay-user", pass: "relay-password" });
  });

  it("treats empty values as not set (Docker Compose writes ${KEY:-} as empty)", () => {
    const config = loadConfig({ ...validEnv, SMTP_USER: "", SMTP_PASSWORD: "", LOG_LEVEL: "" });
    expect(config.mail.smtpAuth).toBeNull();
    expect(config.logLevel).toBe("info");
  });

  it("names an empty required setting as missing", () => {
    expect(() => loadConfig({ ...validEnv, JWT_SECRET: "" })).toThrow(/JWT_SECRET/);
  });

  it("never allows the demo seed unless asked", () => {
    expect(loadConfig(validEnv).allowDemoSeed).toBe(false);
    expect(loadConfig({ ...validEnv, ALLOW_DEMO_SEED: "true" }).allowDemoSeed).toBe(true);
  });

  it("refuses an SMTP user without a password", () => {
    expect(() => loadConfig({ ...validEnv, SMTP_USER: "relay-user" })).toThrow(/set together/);
  });

  it("refuses SMTP_SECURE values other than true or false", () => {
    expect(() => loadConfig({ ...validEnv, SMTP_SECURE: "yes" })).toThrow(/SMTP_SECURE/);
  });

  it("names every missing setting in one error", () => {
    expect(() => loadConfig({})).toThrow(/POSTGRES_DB[\s\S]*APP_DB_PASSWORD/);
  });
});
