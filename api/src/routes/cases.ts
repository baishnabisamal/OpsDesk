import { Router } from "express";
import { z } from "zod";
import { authenticate, getPrincipal } from "../core/auth.js";
import { notFound } from "../core/errors.js";
import * as caseService from "../services/caseService.js";

export const casesRouter = Router();

casesRouter.use(authenticate);

casesRouter.get("/:id", async (req, res) => {
  // An id that is not a UUID cannot exist, so it is a 404 like any unknown id.
  const id = z.guid().safeParse(req.params.id);
  if (!id.success) throw notFound("Case not found.");

  const caseView = await caseService.getCase(getPrincipal(res), id.data);
  res.json(caseView);
});
