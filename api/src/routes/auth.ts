import { Router } from "express";
import {
  emailOnlySchema,
  loginSchema,
  refreshSchema,
  setPasswordSchema,
  signupSchema,
  tokenOnlySchema,
} from "../schemas/auth.js";
import * as accountService from "../services/accountService.js";
import * as authService from "../services/authService.js";

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const body = loginSchema.parse(req.body);
  const session = await authService.login(body.email, body.password);
  res.json(session);
});

authRouter.post("/refresh", async (req, res) => {
  const body = refreshSchema.parse(req.body);
  const session = await authService.refresh(body.refresh_token);
  res.json(session);
});

authRouter.post("/logout", async (req, res) => {
  const body = refreshSchema.parse(req.body);
  await authService.logout(body.refresh_token);
  res.status(204).end();
});

// The same 202 whether or not the email already had an account: the email
// itself says which (see accountService.ts, "account enumeration").
const checkYourEmail = { status: "check_email" };

authRouter.post("/signup", async (req, res) => {
  const body = signupSchema.parse(req.body);
  await accountService.signup(body);
  res.status(202).json(checkYourEmail);
});

authRouter.post("/verify-email", async (req, res) => {
  const body = tokenOnlySchema.parse(req.body);
  res.json(await accountService.verifyEmail(body.token));
});

authRouter.post("/verify-email/resend", async (req, res) => {
  const body = emailOnlySchema.parse(req.body);
  await accountService.resendVerification(body.email);
  res.status(202).json(checkYourEmail);
});

authRouter.post("/password/forgot", async (req, res) => {
  const body = emailOnlySchema.parse(req.body);
  await accountService.forgotPassword(body.email);
  res.status(202).json(checkYourEmail);
});

authRouter.post("/password/reset", async (req, res) => {
  const body = setPasswordSchema.parse(req.body);
  await accountService.resetPassword(body.token, body.password);
  res.status(204).end();
});

authRouter.post("/invites/accept", async (req, res) => {
  const body = setPasswordSchema.parse(req.body);
  res.json(await accountService.acceptInvite(body.token, body.password));
});
