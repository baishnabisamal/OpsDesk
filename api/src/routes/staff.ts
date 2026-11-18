import { Router } from "express";
import { authenticate, getPrincipal } from "../core/auth.js";
import { inviteSchema } from "../schemas/auth.js";
import { inviteStaff } from "../services/accountService.js";
import { listStaff } from "../services/staffService.js";

export const staffRouter = Router();

staffRouter.use(authenticate);

// GET /staff: every active member of staff, with team and current load.
staffRouter.get("/", async (_req, res) => {
  res.json({ items: await listStaff(getPrincipal(res)) });
});

// POST /staff/invites: a lead adds a member of staff by email.
staffRouter.post("/invites", async (req, res) => {
  const body = inviteSchema.parse(req.body);
  res.status(201).json(await inviteStaff(getPrincipal(res), body));
});
