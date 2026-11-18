import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Router } from "express";
import { z } from "zod";
import { authenticate, getPrincipal, requirePermission } from "../core/auth.js";
import { logger } from "../core/logger.js";
import { TICKET_STATUSES } from "../domain/enums.js";
import { exportTicketsCsv } from "../services/exportService.js";

export const exportsRouter = Router();

exportsRouter.use(authenticate);

const exportQuerySchema = z
  .object({
    status: z.enum(TICKET_STATUSES).optional(),
    region: z.enum(["MEA", "EU", "APAC", "AMER"]).optional(),
    agency_id: z.string().uuid().optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
  })
  .strict();

exportsRouter.get("/tickets.csv", async (req, res) => {
  const filters = exportQuerySchema.parse(req.query);
  const principal = getPrincipal(res);
  // Checked here as well as in the service: once the first byte is sent the
  // status is 200, so every refusal must happen before streaming starts.
  requirePermission(principal, "export:run");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="tickets.csv"');

  // Readable.from turns the generator into a stream; pipeline connects it to
  // the response and handles backpressure: the generator is only asked for
  // the next line when the response has room for it.
  try {
    await pipeline(Readable.from(exportTicketsCsv(principal, filters)), res);
  } catch (err) {
    // Headers are already sent, so a problem+json answer is impossible now.
    // The connection is cut, and the client sees an incomplete download
    // instead of a file that looks complete. (A client that disconnects
    // early also ends up here; that is not an error worth more than a log.)
    logger.warn({ err, requestId: res.locals.requestId }, "export stream stopped");
    res.destroy();
  }
});
