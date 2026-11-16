import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { ROLES, type Principal, type Role } from "../domain/enums.js";
import { can, type Action } from "../domain/permissions.js";
import { config } from "./config.js";
import { forbidden, unauthorized } from "./errors.js";

// What we put inside the access token. Short names are the JWT convention:
// `sub` (subject) is the user id.
const claimsSchema = z.object({
  sub: z.string().uuid(),
  role: z.enum(ROLES),
  agency_id: z.string().uuid().nullable(),
  team_id: z.string().uuid().nullable(),
});

export type TokenUser = {
  id: string;
  role: Role;
  agencyId: string | null;
  teamId: string | null;
};

export function signAccessToken(user: TokenUser): string {
  return jwt.sign(
    { sub: user.id, role: user.role, agency_id: user.agencyId, team_id: user.teamId },
    config.jwtSecret,
    { algorithm: "HS256", expiresIn: config.accessTokenTtlSeconds },
  );
}

// Middleware: requires "Authorization: Bearer <token>", checks the signature
// and expiry, and stores the caller on res.locals for the routes.
export function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw unauthorized();
  }

  let payload: unknown;
  try {
    // Naming the algorithm stops a token signed some other way being accepted.
    payload = jwt.verify(header.slice("Bearer ".length), config.jwtSecret, {
      algorithms: ["HS256"],
    });
  } catch {
    throw unauthorized("The access token is invalid or has expired.");
  }

  const claims = claimsSchema.safeParse(payload);
  if (!claims.success) {
    throw unauthorized("The access token is invalid or has expired.");
  }

  const principal: Principal = {
    userId: claims.data.sub,
    role: claims.data.role,
    agencyId: claims.data.agency_id,
    teamId: claims.data.team_id,
  };
  res.locals.principal = principal;
  next();
}

// Routes call this to get the caller that authenticate() stored.
export function getPrincipal(res: Response): Principal {
  return res.locals.principal as Principal;
}

// Services call this before doing anything a role might not be allowed to do.
export function requirePermission(principal: Principal, action: Action) {
  if (!can(principal.role, action)) {
    throw forbidden();
  }
}
