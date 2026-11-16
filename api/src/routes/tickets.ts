import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { authenticate, getPrincipal } from "../core/auth.js";
import { badRequest, notFound, preconditionRequired } from "../core/errors.js";
import {
  assignSchema,
  createTicketSchema,
  idempotencyKeySchema,
  listTicketsSchema,
  transitionSchema,
  updateTicketSchema,
} from "../schemas/tickets.js";
import { createMessageSchema } from "../schemas/messages.js";
import * as messageService from "../services/messageService.js";
import * as ticketService from "../services/ticketService.js";
import * as workflowService from "../services/ticketWorkflowService.js";

// Routes only do three things: read the request, call one service function,
// and shape the response. No rules live here.

export const ticketsRouter = Router();

// Every ticket route needs a logged-in user.
ticketsRouter.use(authenticate);

// An id that is not a UUID cannot exist, so it is a 404 like any unknown id.
export function parseId(value: unknown): string {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw notFound("Ticket not found.");
  return parsed.data;
}

// The version travels as an ETag header, in quotes as HTTP requires.
function setETag(res: Response, version: number) {
  res.setHeader("ETag", `"${version}"`);
}

// Reads the version the client last saw from If-Match: "3" -> 3.
function parseIfMatch(req: Request): number {
  const header = req.header("If-Match");
  if (header === undefined) {
    throw preconditionRequired("Send the ticket's ETag in an If-Match header.");
  }
  const match = /^"(\d{1,9})"$/.exec(header.trim());
  if (!match) {
    throw badRequest('The If-Match header must look like "3".');
  }
  return Number(match[1]);
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

ticketsRouter.get("/", async (req, res) => {
  const query = listTicketsSchema.parse(req.query);
  const page = await ticketService.listTickets(getPrincipal(res), query);
  res.json(page);
});

ticketsRouter.get("/:id", async (req, res) => {
  const ticket = await ticketService.getTicket(getPrincipal(res), parseId(req.params.id));
  setETag(res, ticket.version);
  res.json(ticket);
});

ticketsRouter.patch("/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const version = parseIfMatch(req);
  const input = updateTicketSchema.parse(req.body);

  const ticket = await workflowService.updateTicket(getPrincipal(res), id, version, input);
  setETag(res, ticket.version);
  res.json(ticket);
});

ticketsRouter.post("/:id/transitions", async (req, res) => {
  const id = parseId(req.params.id);
  const version = parseIfMatch(req);
  const body = transitionSchema.parse(req.body);

  const ticket = await workflowService.transitionTicket(getPrincipal(res), id, version, body.to);
  setETag(res, ticket.version);
  res.json(ticket);
});

ticketsRouter.post("/:id/assign", async (req, res) => {
  const id = parseId(req.params.id);
  const version = parseIfMatch(req);
  const body = assignSchema.parse(req.body);

  const ticket = await workflowService.assignTicket(
    getPrincipal(res),
    id,
    version,
    body.assignee_id,
  );
  setETag(res, ticket.version);
  res.json(ticket);
});

ticketsRouter.post("/:id/messages", async (req, res) => {
  const id = parseId(req.params.id);
  const body = createMessageSchema.parse(req.body);
  const message = await messageService.addMessage(getPrincipal(res), id, body);
  res.status(201).json(message);
});

ticketsRouter.get("/:id/messages", async (req, res) => {
  const items = await messageService.listMessages(getPrincipal(res), parseId(req.params.id));
  res.json({ items });
});

ticketsRouter.get("/:id/timeline", async (req, res) => {
  const items = await messageService.listTimeline(getPrincipal(res), parseId(req.params.id));
  res.json({ items });
});
