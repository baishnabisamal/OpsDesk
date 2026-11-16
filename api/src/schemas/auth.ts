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
