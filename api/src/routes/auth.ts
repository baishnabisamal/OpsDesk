import { Router } from "express";
import { loginSchema, refreshSchema } from "../schemas/auth.js";
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
