import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config.js";

const validEnv = {
  POSTGRES_DB: "opsdesk",
  POSTGRES_USER: "owner",
  POSTGRES_PASSWORD: "owner-password",
  APP_DB_PASSWORD: "app-password",
  JWT_SECRET: "x".repeat(32),
  ML_SHARED_SECRET: "m".repeat(16),
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

  it("names every missing setting in one error", () => {
    expect(() => loadConfig({})).toThrow(/POSTGRES_DB[\s\S]*APP_DB_PASSWORD/);
  });
});
