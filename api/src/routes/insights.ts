import { Router } from "express";
import { DateTime } from "luxon";
import { z } from "zod";
import { authenticate, getPrincipal } from "../core/auth.js";
import { getThemes } from "../services/themeService.js";

export const insightsRouter = Router();

insightsRouter.use(authenticate);

// ?week=2026-11-16 (any day of that week; it is moved to the Monday).
// Without it: the current week.
const themesQuerySchema = z.object({ week: z.iso.date().optional() }).strict();

insightsRouter.get("/themes", async (req, res) => {
  const query = themesQuerySchema.parse(req.query);
  const day = query.week ? DateTime.fromISO(query.week, { zone: "UTC" }) : DateTime.utc();
  const monday = day.startOf("week").toISODate()!; // luxon weeks start on Monday
  res.json(await getThemes(getPrincipal(res), monday));
});
