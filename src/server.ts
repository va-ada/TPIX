import Fastify from "fastify";
import { z } from "zod";
import { config, VERSION } from "./config.ts";
import { logger } from "./logger.ts";
import "./db.ts";
import { route } from "./llm/router.ts";

const app = Fastify({ loggerInstance: logger });

const startedAt = Date.now();

app.get("/health", async () => ({
  ok: true,
  uptime_ms: Date.now() - startedAt,
  version: VERSION,
}));

const EchoQuery = z.object({
  role: z.string().default("boss"),
  prompt: z.string().min(1),
  model: z.string().default("claude-sonnet-4-6"),
  fallback: z.string().default("llama3.2:3b"),
});

app.get("/llm/echo", async (req, reply) => {
  const parsed = EchoQuery.safeParse(req.query);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.format() });
  }
  const { role, prompt, model, fallback } = parsed.data;
  try {
    const result = await route({
      roleId: role,
      prompt,
      model,
      offlineFallbackModel: fallback,
      allocatedBy: "debug",
    });
    return result;
  } catch (err) {
    const e = err as Error;
    logger.error({ err: e.message }, "/llm/echo failed");
    return reply.code(502).send({ error: e.message });
  }
});

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
