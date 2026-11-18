import { createServer } from "node:http";
import { config } from "../core/config.js";
import { logger } from "../core/logger.js";
import { createRedis } from "../core/redis.js";
import { createGateway } from "./gateway.js";

// The WebSocket gateway process (`make realtime`). Same code base as the
// API, its own process and port, so many open connections never slow down
// ordinary API requests.

const httpServer = createServer((req, res) => {
  // Socket.IO answers its own paths; everything else gets a tiny health check.
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ok"}');
    return;
  }
  res.writeHead(404).end();
});

// The gateway's blocking stream read gets its own Redis connection.
const gateway = createGateway(httpServer, createRedis());

httpServer.listen(config.realtimePort, () => {
  logger.info(`WebSocket gateway listening on http://localhost:${config.realtimePort}`);
});

async function shutdown() {
  await gateway.close();
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
