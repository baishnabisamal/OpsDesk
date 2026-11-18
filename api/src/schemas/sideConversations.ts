import { z } from "zod";

const participantSchema = z
  .object({
    email: z.string().trim().email().max(254),
    name: z.string().trim().min(1).max(200).nullable().default(null),
  })
  .strict();

export const startSideConversationSchema = z
  .object({
    subject: z.string().trim().min(1).max(200),
    // At least one person to write to, and a sensible upper limit.
    participants: z.array(participantSchema).min(1).max(20),
    body: z.string().trim().min(1).max(20000),
  })
  .strict();

export const sideMessageSchema = z
  .object({
    body: z.string().trim().min(1).max(20000),
  })
  .strict();
