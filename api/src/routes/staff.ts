import { Router } from "express";
import { authenticate, getPrincipal } from "../core/auth.js";
import { listStaff } from "../services/staffService.js";

export const staffRouter = Router();

staffRouter.use(authenticate);

// GET /staff: every active member of staff, with team and current load.
staffRouter.get("/", async (_req, res) => {
  res.json({ items: await listStaff(getPrincipal(res)) });
});
