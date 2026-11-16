import { createServer, type Server } from "node:http";
import { config } from "../../src/core/config.js";

// A stand-in for the Python ML service, so tests can decide exactly how "the
// model" behaves: what it answers, how slowly, or not at all.
//
// It listens on the port in ML_URL, checks the shared-secret header like the
// real service, and counts the calls it receives.

type Handler = (path: string, body: Record<string, unknown>) => object;

export class FakeMl {
  private server: Server | null = null;
  calls: { path: string; body: Record<string, unknown> }[] = [];

  // What to answer. Tests replace these.
  handler: Handler = () => ({});
  delayMs = 0;
  status = 200;

  async start() {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        if (req.headers["x-ml-secret"] !== config.ml.sharedSecret) {
          res.writeHead(401).end();
          return;
        }
        const body = JSON.parse(raw || "{}") as Record<string, unknown>;
        const path = req.url ?? "";
        this.calls.push({ path, body });

        setTimeout(() => {
          res.writeHead(this.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.status === 200 ? this.handler(path, body) : {}));
        }, this.delayMs);
      });
    });
    const port = Number(new URL(config.ml.url).port);
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
  }

  async stop() {
    const server = this.server;
    if (!server) return;
    this.server = null;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // Back to a working, instant service with no recorded calls.
  reset() {
    this.calls = [];
    this.delayMs = 0;
    this.status = 200;
    this.handler = () => ({});
  }

  callsTo(path: string) {
    return this.calls.filter((call) => call.path === path);
  }
}
