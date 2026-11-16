import { Router, type Response } from "express";
import { z } from "zod";
import { authenticate, getPrincipal } from "../core/auth.js";
import { badRequest, notFound } from "../core/errors.js";
import { createTicketSchema, idempotencyKeySchema } from "../schemas/tickets.js";
import * as ticketService from "../services/ticketService.js";

export const ticketsRouter = Router();

// Every ticket route needs a logged-in user.
ticketsRouter.use(authenticate);

// An id that is not a UUID cannot exist, so it is a 404 like any unknown id.
function parseId(value: unknown): string {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw notFound("Ticket not found.");
  return parsed.data;
}

// The version travels as an ETag header, in quotes as HTTP requires.
function setETag(res: Response, version: number) {
  res.setHeader("ETag", `"${version}"`);
}

ticketsRouter.post("/", async (req, res) => {
  const key = idempotencyKeySchema.safeParse(req.header("Idempotency-Key"));
  if (!key.success) {
    throw badRequest("The Idempotency-Key header is required.");
  }
  const input = createTicketSchema.parse(req.body);

  const result = await ticketService.createTicket(getPrincipal(res), input, key.data);

  if (result.replayed) res.setHeader("Idempotent-Replayed", "true");
  setETag(res, result.ticket.version);
  res.status(201).location(`/api/v1/tickets/${result.ticket.id}`).json(result.ticket);
});

ticketsRouter.get("/:id", async (req, res) => {
  const ticket = await ticketService.getTicket(getPrincipal(res), parseId(req.params.id));
  setETag(res, ticket.version);
  res.json(ticket);
});
