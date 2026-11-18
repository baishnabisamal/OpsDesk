import { Router } from "express";
import { z } from "zod";
import { authenticate, getPrincipal } from "../core/auth.js";
import { notFound } from "../core/errors.js";
import { INTENTS } from "../domain/enums.js";
import { SLA_STATES } from "../domain/sla.js";
import { getQueue, QUEUE_NAMES } from "../services/queueService.js";

export const queuesRouter = Router();

queuesRouter.use(authenticate);

const queueQuerySchema = z
  .object({
    region: z.enum(["MEA", "EU", "APAC", "AMER"]).optional(),
    team_id: z.string().uuid().optional(),
    intent: z.enum(INTENTS).optional(),
    // "at_risk" or "breached" shows only the tickets in trouble.
    sla_state: z.enum(SLA_STATES).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(500).optional(),
  })
  .strict();

// GET /queues/triage, /queues/mine, /queues/region?region=EU, ...
queuesRouter.get("/:name", async (req, res) => {
  const name = z.enum(QUEUE_NAMES).safeParse(req.params.name);
  if (!name.success) throw notFound("No such queue.");

  const query = queueQuerySchema.parse(req.query);
  const page = await getQueue(getPrincipal(res), name.data, query);
  res.json(page);
});
