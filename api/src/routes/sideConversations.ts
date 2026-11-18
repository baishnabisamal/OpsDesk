import { Router } from "express";
import { z } from "zod";
import { authenticate, getPrincipal } from "../core/auth.js";
import { notFound } from "../core/errors.js";
import { sideMessageSchema } from "../schemas/sideConversations.js";
import * as sideConversationService from "../services/sideConversationService.js";

export const sideConversationsRouter = Router();

sideConversationsRouter.use(authenticate);

function parseId(value: unknown): string {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw notFound("Side conversation not found.");
  return parsed.data;
}

sideConversationsRouter.get("/:id", async (req, res) => {
  const conversation = await sideConversationService.getSideConversation(
    getPrincipal(res),
    parseId(req.params.id),
  );
  res.json(conversation);
});

sideConversationsRouter.post("/:id/messages", async (req, res) => {
  const id = parseId(req.params.id);
  const body = sideMessageSchema.parse(req.body);
  const message = await sideConversationService.addSideMessage(getPrincipal(res), id, body.body);
  res.status(201).json(message);
});
