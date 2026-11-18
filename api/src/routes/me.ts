import { Router } from "express";
import { z } from "zod";
import { authenticate, getPrincipal } from "../core/auth.js";
import * as loadService from "../services/loadService.js";

// Routes about the logged-in user themselves.
export const meRouter = Router();

meRouter.use(authenticate);

export const presenceSchema = z.object({ online: z.boolean() }).strict();

// An agent goes online to start receiving tickets, and offline to stop.
// Tickets they already hold stay with them.
meRouter.put("/presence", async (req, res) => {
  const body = presenceSchema.parse(req.body);
  const presence = await loadService.setPresence(getPrincipal(res), body.online);
  res.json(presence);
});
