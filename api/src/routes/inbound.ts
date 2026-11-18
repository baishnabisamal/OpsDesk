import express, { Router } from "express";
import { z } from "zod";
import { config } from "../core/config.js";
import { AppError, badRequest } from "../core/errors.js";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verify } from "../core/webhookSignature.js";
import { receiveInboundEmail } from "../services/inboundEmailService.js";

export const inboundRouter = Router();

// The signature is computed over the EXACT bytes that were sent. So this
// route reads the raw body (express.raw) instead of letting express.json
// parse it first: parsing and re-serialising JSON can change spacing and key
// order, and the signature would no longer match.
inboundRouter.post(
  "/email",
  express.raw({ type: "application/json", limit: "1mb" }),
  async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    const check = verify({
      secret: config.inboundWebhookSecret,
      rawBody,
      timestamp: req.header(TIMESTAMP_HEADER),
      signature: req.header(SIGNATURE_HEADER),
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!check.ok) {
      throw new AppError(401, "invalid_signature", "Unauthorized", check.reason);
    }

    // Only after the signature is good do we look inside.
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw badRequest("The request body is not valid JSON.");
    }
    const email = inboundEmailSchema.parse(json);

    // 200 for accepted, quarantined AND duplicate: the provider retries any
    // other status, and retrying would not change the outcome.
    const result = await receiveInboundEmail(email);
    res.json(result);
  },
);

const inboundEmailSchema = z.object({
  provider_message_id: z.string().trim().min(1).max(300),
  from: z.string().trim().email().max(254),
  to: z.string().trim().min(3).max(254),
  subject: z.string().max(500).default(""),
  text: z.string().trim().min(1).max(20000),
});
