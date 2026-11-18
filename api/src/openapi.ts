import { z } from "zod";
import { INTENTS } from "./domain/enums.js";
import { exportQuerySchema } from "./routes/exports.js";
import { inboundEmailSchema } from "./routes/inbound.js";
import { themesQuerySchema } from "./routes/insights.js";
import { presenceSchema } from "./routes/me.js";
import { queueQuerySchema } from "./routes/queues.js";
import {
  emailOnlySchema,
  inviteSchema,
  loginSchema,
  refreshSchema,
  setPasswordSchema,
  signupSchema,
  tokenOnlySchema,
} from "./schemas/auth.js";
import { createMessageSchema } from "./schemas/messages.js";
import { sideMessageSchema, startSideConversationSchema } from "./schemas/sideConversations.js";
import {
  assignSchema,
  createTicketSchema,
  linkSchema,
  listTicketsSchema,
  overrideIntentSchema,
  transitionSchema,
  updateTicketSchema,
} from "./schemas/tickets.js";
import { QUEUE_NAMES } from "./services/queueService.js";

// The OpenAPI document, served at GET /openapi.json.
//
// OpenAPI is a standard description of an HTTP API: every path, what it
// accepts, what it can answer. Tools read it to generate clients or, here,
// to TEST the API: Schemathesis generates thousands of requests from this
// document and checks the answers (make contract).
//
// The request schemas are the very Zod schemas the routes validate with,
// turned into JSON Schema by Zod itself (z.toJSONSchema). So the document
// cannot drift away from the code: change a schema and the document follows.
// OpenAPI 3.1 uses JSON Schema directly, which is why 3.1 is used.

type Schema = Record<string, unknown>;

// io: "input" describes what a client SENDS (defaults may be left out).
function jsonSchema(schema: z.ZodType): Schema {
  const { $schema: _unused, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Schema;
  void _unused;
  return rest;
}

// A Zod object for a query string becomes one OpenAPI parameter per field.
function queryParameters(schema: z.ZodObject): Schema[] {
  const json = jsonSchema(schema) as { properties?: Record<string, Schema>; required?: string[] };
  return Object.entries(json.properties ?? {}).map(([name, property]) => ({
    name,
    in: "query",
    required: json.required?.includes(name) ?? false,
    schema: property,
  }));
}

const uuidParameter = (name: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
});

const ifMatch = {
  name: "If-Match",
  in: "header",
  required: true,
  description: 'The ticket\'s ETag, for example "3".',
  schema: { type: "string", pattern: '^"\\d{1,9}"$' },
};

const problem = {
  description: "Error (RFC 9457 problem+json)",
  content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
};

const json = (description: string, schema: Schema = { type: "object" }) => ({
  description,
  content: { "application/json": { schema } },
});

// Every endpoint can fail with a client error; the exact 4xx is in the body's
// `code`. The only thing that must never happen is a 500.
function responses(success: Record<string, unknown>) {
  return { ...success, "4XX": problem };
}

type Operation = {
  summary: string;
  parameters?: Schema[];
  body?: z.ZodType;
  responses: Record<string, unknown>;
  security?: boolean; // false = no login needed
};

const ticket = { $ref: "#/components/schemas/Ticket" };
const items = (schema: Schema = { type: "object" }) => ({
  type: "object",
  properties: { items: { type: "array", items: schema } },
  required: ["items"],
});
const page = {
  type: "object",
  properties: {
    items: { type: "array", items: ticket },
    next_cursor: { type: ["string", "null"] },
  },
  required: ["items", "next_cursor"],
};
const id = [uuidParameter("id")];

const PATHS: Record<string, Record<string, Operation>> = {
  "/healthz": {
    get: { summary: "Liveness", security: false, responses: { "200": json("Alive") } },
  },
  "/readyz": {
    get: {
      summary: "Readiness: PostgreSQL required, Redis reported",
      security: false,
      responses: { "200": json("Ready or degraded"), "503": json("Not ready") },
    },
  },
  "/api/v1/auth/login": {
    post: {
      summary: "Log in",
      security: false,
      body: loginSchema,
      responses: responses({ "200": json("Session") }),
    },
  },
  "/api/v1/auth/refresh": {
    post: {
      summary: "Swap a refresh token for a new pair",
      security: false,
      body: refreshSchema,
      responses: responses({ "200": json("Session") }),
    },
  },
  "/api/v1/auth/logout": {
    post: {
      summary: "End the session family",
      security: false,
      body: refreshSchema,
      responses: responses({ "204": { description: "Logged out" } }),
    },
  },
  "/api/v1/auth/signup": {
    post: {
      summary: "Sign up a new agency and its first user; sends a verification email",
      security: false,
      body: signupSchema,
      responses: responses({ "202": json("Check your email") }),
    },
  },
  "/api/v1/auth/verify-email": {
    post: {
      summary: "Use the emailed link; signs the user in",
      security: false,
      body: tokenOnlySchema,
      responses: responses({ "200": json("Session") }),
    },
  },
  "/api/v1/auth/verify-email/resend": {
    post: {
      summary: "Send the verification link again",
      security: false,
      body: emailOnlySchema,
      responses: responses({ "202": json("Check your email") }),
    },
  },
  "/api/v1/auth/password/forgot": {
    post: {
      summary: "Email a password reset link",
      security: false,
      body: emailOnlySchema,
      responses: responses({ "202": json("Check your email") }),
    },
  },
  "/api/v1/auth/password/reset": {
    post: {
      summary: "Set a new password with the emailed link; ends every session",
      security: false,
      body: setPasswordSchema,
      responses: responses({ "204": { description: "Password changed" } }),
    },
  },
  "/api/v1/auth/invites/accept": {
    post: {
      summary: "Accept a staff invitation by choosing a password; signs the user in",
      security: false,
      body: setPasswordSchema,
      responses: responses({ "200": json("Session") }),
    },
  },
  "/api/v1/tickets": {
    post: {
      summary: "Create a ticket (requesters)",
      parameters: [
        {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          schema: { type: "string", minLength: 1, maxLength: 200 },
        },
      ],
      body: createTicketSchema,
      responses: responses({ "201": json("Created, or replayed", ticket) }),
    },
    get: {
      summary: "List tickets, newest first, keyset paged",
      parameters: queryParameters(listTicketsSchema),
      responses: responses({ "200": json("A page", page) }),
    },
  },
  "/api/v1/tickets/{id}": {
    get: {
      summary: "One ticket",
      parameters: id,
      responses: responses({ "200": json("Ticket", ticket) }),
    },
    patch: {
      summary: "Edit subject or priority",
      parameters: [...id, ifMatch],
      body: updateTicketSchema,
      responses: responses({ "200": json("Ticket", ticket) }),
    },
  },
  "/api/v1/tickets/{id}/transitions": {
    post: {
      summary: "Change status",
      parameters: [...id, ifMatch],
      body: transitionSchema,
      responses: responses({ "200": json("Ticket", ticket) }),
    },
  },
  "/api/v1/tickets/{id}/assign": {
    post: {
      summary: "Assign or transfer",
      parameters: [...id, ifMatch],
      body: assignSchema,
      responses: responses({ "200": json("Ticket", ticket) }),
    },
  },
  "/api/v1/tickets/{id}/intent": {
    put: {
      summary: "Override the intent (logged)",
      parameters: [...id, ifMatch],
      body: overrideIntentSchema,
      responses: responses({ "200": json("Ticket", ticket) }),
    },
  },
  "/api/v1/tickets/{id}/escalate": {
    post: {
      summary: "Escalate",
      parameters: [...id, ifMatch],
      responses: responses({ "200": json("Ticket", ticket) }),
    },
  },
  "/api/v1/tickets/{id}/de-escalate": {
    post: {
      summary: "De-escalate",
      parameters: [...id, ifMatch],
      responses: responses({ "200": json("Ticket", ticket) }),
    },
  },
  "/api/v1/tickets/{id}/messages": {
    get: {
      summary: "Messages",
      parameters: id,
      responses: responses({ "200": json("Messages", items()) }),
    },
    post: {
      summary: "Reply or internal note",
      parameters: id,
      body: createMessageSchema,
      responses: responses({ "201": json("Message") }),
    },
  },
  "/api/v1/tickets/{id}/timeline": {
    get: {
      summary: "Timeline",
      parameters: id,
      responses: responses({ "200": json("Events", items()) }),
    },
  },
  "/api/v1/tickets/{id}/archived-timeline": {
    get: {
      summary: "Timeline events read back from the archive",
      parameters: id,
      responses: responses({ "200": json("Events", items()) }),
    },
  },
  "/api/v1/tickets/{id}/links": {
    get: {
      summary: "Linked tickets",
      parameters: id,
      responses: responses({ "200": json("Links", items()) }),
    },
    post: {
      summary: "Link two tickets",
      parameters: id,
      body: linkSchema,
      responses: responses({ "204": { description: "Linked" } }),
    },
  },
  "/api/v1/tickets/{id}/links/{linkedId}": {
    delete: {
      summary: "Unlink",
      parameters: [...id, uuidParameter("linkedId")],
      responses: responses({ "204": { description: "Unlinked" } }),
    },
  },
  "/api/v1/tickets/{id}/side-conversations": {
    get: {
      summary: "Supplier threads (staff)",
      parameters: id,
      responses: responses({ "200": json("Threads", items()) }),
    },
    post: {
      summary: "Start a supplier thread (staff)",
      parameters: id,
      body: startSideConversationSchema,
      responses: responses({ "201": json("Thread") }),
    },
  },
  "/api/v1/side-conversations/{id}": {
    get: {
      summary: "One supplier thread",
      parameters: id,
      responses: responses({ "200": json("Thread") }),
    },
  },
  "/api/v1/side-conversations/{id}/messages": {
    post: {
      summary: "Reply in a supplier thread",
      parameters: id,
      body: sideMessageSchema,
      responses: responses({ "201": json("Message") }),
    },
  },
  "/api/v1/cases/{id}": {
    get: {
      summary: "A case and its tickets",
      parameters: id,
      responses: responses({ "200": json("Case") }),
    },
  },
  "/api/v1/me/presence": {
    put: {
      summary: "Go online or offline (staff)",
      body: presenceSchema,
      responses: responses({ "200": json("Presence") }),
    },
  },
  "/api/v1/queues/{name}": {
    get: {
      summary: "A queue, soonest deadline first (staff)",
      parameters: [
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string", enum: [...QUEUE_NAMES] },
        },
        ...queryParameters(queueQuerySchema),
      ],
      responses: responses({ "200": json("A page", page) }),
    },
  },
  "/api/v1/staff": {
    get: {
      summary: "Staff directory with team and load (staff)",
      responses: responses({ "200": json("Staff", items()) }),
    },
  },
  "/api/v1/staff/invites": {
    post: {
      summary: "Invite a member of staff by email (leads)",
      body: inviteSchema,
      responses: responses({ "201": json("Invitation") }),
    },
  },
  "/api/v1/insights/themes": {
    get: {
      summary: "Weekly themes (leads)",
      parameters: queryParameters(themesQuerySchema),
      responses: responses({ "200": json("Themes") }),
    },
  },
  "/api/v1/exports/tickets.csv": {
    get: {
      summary: "Streaming CSV export (leads)",
      parameters: queryParameters(exportQuerySchema),
      responses: responses({
        "200": { description: "CSV", content: { "text/csv": { schema: { type: "string" } } } },
      }),
    },
  },
  "/api/v1/inbound/email": {
    post: {
      summary: "Signed webhook from the mail provider",
      security: false,
      parameters: [
        { name: "X-OpsDesk-Timestamp", in: "header", required: true, schema: { type: "string" } },
        { name: "X-OpsDesk-Signature", in: "header", required: true, schema: { type: "string" } },
      ],
      body: inboundEmailSchema,
      responses: responses({ "200": json("Accepted, quarantined or duplicate") }),
    },
  },
};

export function buildOpenApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [path, operations] of Object.entries(PATHS)) {
    paths[path] = {};
    for (const [method, operation] of Object.entries(operations)) {
      paths[path][method] = {
        summary: operation.summary,
        parameters: operation.parameters ?? [],
        ...(operation.body
          ? {
              requestBody: {
                required: true,
                content: { "application/json": { schema: jsonSchema(operation.body) } },
              },
            }
          : {}),
        responses: operation.responses,
        ...(operation.security === false ? { security: [] } : {}),
      };
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "OpsDesk API",
      version: "1.0.0",
      description:
        "Travel-aware operations ticketing. Errors are RFC 9457 problem+json with a stable `code`.",
    },
    servers: [{ url: "/" }],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      schemas: {
        Problem: {
          type: "object",
          properties: {
            type: { type: "string" },
            title: { type: "string" },
            status: { type: "integer" },
            code: { type: "string" },
            detail: { type: "string" },
            request_id: { type: "string" },
          },
          required: ["type", "title", "status", "code"],
        },
        Ticket: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            status: { type: "string" },
            priority: { type: "string" },
            intent: { type: "string", enum: [...INTENTS] },
            version: { type: "integer", minimum: 1 },
          },
          required: ["id", "status", "priority", "intent", "version"],
        },
      },
    },
  };
}
