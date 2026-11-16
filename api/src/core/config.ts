import { z } from "zod";

// The only file that reads process.env. Everything else imports `config`.
// If a setting is missing or wrong, the app stops at startup with a clear
// message instead of failing later in the middle of a request.

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),

  POSTGRES_HOST: z.string().min(1).default("localhost"),
  POSTGRES_PORT: z.coerce.number().int().default(5432),
  POSTGRES_DB: z.string().min(1),

  // Owner role: used only by the migration and seed scripts.
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),

  // App role: used by the API. Owns nothing and cannot bypass RLS.
  APP_DB_USER: z.string().min(1).default("opsdesk_app"),
  APP_DB_PASSWORD: z.string().min(8, "must be at least 8 characters"),

  JWT_SECRET: z.string().min(32, "must be at least 32 characters"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // The Python ML service. Ticket create never waits longer than the timeout.
  ML_URL: z.string().url().default("http://127.0.0.1:8001"),
  ML_SHARED_SECRET: z.string().min(16, "must be at least 16 characters"),
  ML_TIMEOUT_MS: z.coerce.number().int().positive().default(150),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined>) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `  ${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`Invalid configuration:\n${problems.join("\n")}`);
  }
  const e = parsed.data;

  return {
    nodeEnv: e.NODE_ENV,
    port: e.API_PORT,
    logLevel: e.NODE_ENV === "test" ? "silent" : e.LOG_LEVEL,
    db: {
      host: e.POSTGRES_HOST,
      port: e.POSTGRES_PORT,
      database: e.POSTGRES_DB,
      owner: { user: e.POSTGRES_USER, password: e.POSTGRES_PASSWORD },
      app: { user: e.APP_DB_USER, password: e.APP_DB_PASSWORD },
    },
    jwtSecret: e.JWT_SECRET,
    accessTokenTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
    ml: {
      url: e.ML_URL.replace(/\/$/, ""), // no trailing slash
      sharedSecret: e.ML_SHARED_SECRET,
      timeoutMs: e.ML_TIMEOUT_MS,
    },
  };
}

export const config = loadConfig(process.env);
