import Fastify from "fastify";
import { config, VERSION } from "./config.ts";
import { logger } from "./logger.ts";
import "./db.ts";

const app = Fastify({ loggerInstance: logger });

const startedAt = Date.now();

app.get("/health", async () => ({
  ok: true,
  uptime_ms: Date.now() - startedAt,
  version: VERSION,
}));

const start = async () => {
  try {
    await app.listen({ port: config.port, host: config.host });
    logger.info({ port: config.port, host: config.host }, "TPIX server listening");
  } catch (err) {
    logger.fatal({ err }, "server failed to start");
    process.exit(1);
  }
};

start();
