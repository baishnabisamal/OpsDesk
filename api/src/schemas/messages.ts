import { z } from "zod";
import { VISIBILITIES } from "../domain/enums.js";

export const createMessageSchema = z
  .object({
    body: z.string().trim().min(1).max(10000),
    visibility: z.enum(VISIBILITIES).default("public"),
  })
  .strict();
