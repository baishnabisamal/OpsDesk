import { createApp } from "./app.js";
import { config } from "./core/config.js";
import { logger } from "./core/logger.js";
import { closePool } from "./db/pool.js";

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info(`API listening on http://localhost:${config.port}`);
});

// On Ctrl+C or a container stop: finish open requests, then close the pool.
function shutdown() {
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
