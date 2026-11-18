import { z } from "zod";

// .strict() rejects unknown fields instead of silently ignoring them.

export const loginSchema = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(1).max(200),
  })
  .strict();

export const refreshSchema = z
  .object({
    refresh_token: z.string().min(1).max(200),
  })
  .strict();

// A password must be long; length beats complexity rules. 200 is a sanity limit.
const passwordSchema = z.string().min(10, "Use at least 10 characters.").max(200);
const emailSchema = z.string().trim().email().max(254);
// Tokens from email links are 43 characters (32 random bytes, base64url).
const tokenSchema = z.string().min(20).max(200);

export const signupSchema = z
  .object({
    agency_name: z.string().trim().min(2).max(120),
    full_name: z.string().trim().min(1).max(200),
    email: emailSchema,
    password: passwordSchema,
  })
  .strict();

export const emailOnlySchema = z.object({ email: emailSchema }).strict();

export const tokenOnlySchema = z.object({ token: tokenSchema }).strict();

export const setPasswordSchema = z
  .object({ token: tokenSchema, password: passwordSchema })
  .strict();

export const inviteSchema = z
  .object({
    email: emailSchema,
    full_name: z.string().trim().min(1).max(200),
    role: z.enum(["agent", "escalation_manager"]),
    team_id: z.string().uuid(),
  })
  .strict();
