import { z } from "zod";
import { INTENTS, PRIORITIES } from "../domain/enums.js";

// The client sends only these fields. agency_id, requester_id and status are
// set by the server and cannot be supplied (.strict() rejects extra fields).
export const createTicketSchema = z
  .object({
    tboh: z.string().trim().min(1).max(50),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(10000),
    priority: z.enum(PRIORITIES).default("normal"),
    intent: z.enum(INTENTS).default("other"),
  })
  .strict();

export type CreateTicketInput = z.infer<typeof createTicketSchema>;

export const idempotencyKeySchema = z.string().trim().min(1).max(200);
