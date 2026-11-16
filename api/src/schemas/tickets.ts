import { z } from "zod";
import { INTENTS, PRIORITIES, TICKET_STATUSES } from "../domain/enums.js";

// The client sends only these fields. agency_id, requester_id, status and
// intent are set by the server and cannot be supplied (.strict() rejects
// extra fields). tboh may be left out when the text mentions the reference.
export const createTicketSchema = z
  .object({
    tboh: z.string().trim().min(1).max(50).optional(),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(10000),
    priority: z.enum(PRIORITIES).default("normal"),
  })
  .strict();

export type CreateTicketInput = z.infer<typeof createTicketSchema>;

export const idempotencyKeySchema = z.string().trim().min(1).max(200);

// Query string of GET /tickets. Everything is optional.
export const listTicketsSchema = z
  .object({
    status: z.enum(TICKET_STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    assignee_id: z.string().uuid().optional(),
    intent: z.enum(INTENTS).optional(),
    // "true" lists the review queue: tickets whose intent a person should check.
    needs_review: z.enum(["true", "false"]).optional(),
    q: z.string().trim().min(1).max(200).optional(), // full-text search
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(500).optional(),
  })
  .strict();

export type ListTicketsQuery = z.infer<typeof listTicketsSchema>;

// PATCH /tickets/:id. Status, assignee and intent are NOT here: they have
// their own endpoints because they have rules and side effects.
export const updateTicketSchema = z
  .object({
    subject: z.string().trim().min(1).max(200).optional(),
    priority: z.enum(PRIORITIES).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Send at least one field." });

export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;

export const transitionSchema = z.object({ to: z.enum(TICKET_STATUSES) }).strict();

export const assignSchema = z.object({ assignee_id: z.string().uuid() }).strict();

// PUT /tickets/:id/intent
export const overrideIntentSchema = z.object({ intent: z.enum(INTENTS) }).strict();
