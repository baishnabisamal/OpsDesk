import type { Transporter } from "nodemailer";
import { config } from "../core/config.js";
import { logger } from "../core/logger.js";
import { createMailTransport } from "./emailService.js";

// Emails about accounts: verify your address, reset your password, accept an
// invitation, "you already have an account".
//
// These are NOT sent through the outbox like ticket emails. The email must
// contain the raw token, and the database only ever stores its hash; putting
// the email in an outbox row would mean storing the raw token. So the service
// commits first and sends afterwards (rule 4: no external call inside a
// transaction). If sending fails, the person asks for a new link; nothing is
// left half done in the database.
//
// The token goes after "#" in the link. The part after # is never sent to a
// server, so it does not end up in access logs or in a Referer header.

export type AccountMail =
  | { kind: "verify_email"; to: string; name: string; token: string }
  | { kind: "reset_password"; to: string; name: string; token: string }
  | { kind: "invite"; to: string; name: string; token: string; invitedBy: string }
  | { kind: "already_registered"; to: string; name: string };

let transport: Transporter | undefined;

function link(path: string, token: string): string {
  return `${config.mail.appUrl}${path}#token=${encodeURIComponent(token)}`;
}

export function composeAccountMail(mail: AccountMail): { subject: string; text: string } {
  const hello = `Hello ${mail.name},`;
  switch (mail.kind) {
    case "verify_email":
      return {
        subject: "Confirm your email for OpsDesk",
        text: `${hello}\n\nConfirm your email address to start using OpsDesk:\n\n${link("/verify-email", mail.token)}\n\nThe link works once and expires in 48 hours. If you did not sign up, ignore this email.\n`,
      };
    case "reset_password":
      return {
        subject: "Reset your OpsDesk password",
        text: `${hello}\n\nChoose a new password here:\n\n${link("/reset-password", mail.token)}\n\nThe link works once and expires in 1 hour. Every device signed in to your account will be signed out.\nIf you did not ask for this, ignore this email; your password stays the same.\n`,
      };
    case "invite":
      return {
        subject: "You are invited to OpsDesk",
        text: `${hello}\n\n${mail.invitedBy} added you to the OpsDesk support team. Choose a password to start:\n\n${link("/accept-invite", mail.token)}\n\nThe link works once and expires in 7 days.\n`,
      };
    case "already_registered":
      return {
        subject: "You already have an OpsDesk account",
        text: `${hello}\n\nSomeone (probably you) tried to sign up with this email address, but it already has an account.\n\nSign in: ${config.mail.appUrl}/\nForgot your password? ${config.mail.appUrl}/forgot-password\n`,
      };
  }
}

// Never throws: the caller has already committed and answers the same way
// whether the email went out or not.
export async function sendAccountMail(mail: AccountMail): Promise<boolean> {
  const { subject, text } = composeAccountMail(mail);
  try {
    transport ??= createMailTransport();
    await transport.sendMail({ from: config.mail.from, to: mail.to, subject, text });
    return true;
  } catch (err) {
    logger.warn({ err, kind: mail.kind }, "account email could not be sent");
    return false;
  }
}
