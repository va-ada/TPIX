import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config, VERSION } from "./config.ts";
import { logger } from "./logger.ts";
import { getOpusHeadroom, getSonnetHeadroom } from "./cost/headroom.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const WEB_DIR = join(REPO_ROOT, "web");
import "./db.ts";
import { route } from "./llm/router.ts";
import { roles } from "./roles/registry.ts";
import {
  createProject,
  getProject,
  listProjects,
} from "./repos/projects.ts";
import { listMessages } from "./repos/messages.ts";
import { runBossTurn, startUsageWatchdog } from "./agents/boss.ts";
import { generatePlan } from "./agents/planner.ts";
import { runResearch } from "./agents/researcher.ts";
import { latestPlan, approvePlan } from "./repos/plans.ts";
import { listTasks } from "./repos/tasks.ts";
import { dispatchProject } from "./dispatcher.ts";
import { startTelegramBot } from "./bot/telegram.ts";

const app = Fastify({ loggerInstance: logger });

const startedAt = Date.now();

await app.register(fastifyStatic, {
  root: WEB_DIR,
  prefix: "/web/",
  decorateReply: false,
});

app.get("/", async (_req, reply) => reply.redirect("/web/"));

app.get("/health", async () => ({
  ok: true,
  uptime_ms: Date.now() - startedAt,
  version: VERSION,
  roles_loaded: roles.size(),
}));

app.get("/budget", async () => ({
  opus: getOpusHeadroom(),
  sonnet: getSonnetHeadroom(),
}));

app.get("/roles", async () => roles.all());

app.get("/roles/:id", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!roles.has(id)) {
    return reply.code(404).send({ error: `unknown role: ${id}` });
  }
  return roles.get(id);
});

const NewProjectBody = z.object({ idea: z.string().min(3) });

app.post("/projects", async (req, reply) => {
  const parsed = NewProjectBody.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() });
  const project = createProject(parsed.data.idea);
  const turn = await runBossTurn({ projectId: project.id, userMessage: parsed.data.idea });
  return { project, boss: turn };
});

app.get("/projects", async () => listProjects());

app.get("/projects/:id", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const project = getProject(id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  return { project, messages: listMessages(id) };
});

const MessageBody = z.object({ text: z.string().min(1) });

app.post("/projects/:id/messages", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const project = getProject(id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  const parsed = MessageBody.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() });
  const turn = await runBossTurn({ projectId: id, userMessage: parsed.data.text });
  return { boss: turn };
});

app.post("/projects/:id/plan/generate", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const project = getProject(id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  const plan = await generatePlan(id);
  return { plan };
});

app.get("/projects/:id/plan", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const plan = latestPlan(id);
  if (!plan) return reply.code(404).send({ error: "no plan yet" });
  return { plan: JSON.parse(plan.json), approved: plan.approved === 1, tasks: listTasks(id) };
});

app.post("/projects/:id/plan/approve", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const plan = latestPlan(id);
  if (!plan) return reply.code(404).send({ error: "no plan to approve" });
  approvePlan(plan.id);
  await import("./repos/projects.ts").then(({ setProjectState }) =>
    setProjectState(id, "in_progress"),
  );
  return { ok: true };
});

app.post("/projects/:id/plan/reject", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const plan = latestPlan(id);
  if (!plan) return reply.code(404).send({ error: "no plan to reject" });
  await import("./repos/projects.ts").then(({ setProjectState }) =>
    setProjectState(id, "qna"),
  );
  return { ok: true };
});

app.post("/projects/:id/dispatch", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const project = getProject(id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  const result = await dispatchProject(id);
  return { result };
});

app.post("/projects/:id/research", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const project = getProject(id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  const body = (req.body ?? {}) as { query?: string };
  const result = await runResearch({ projectId: id, ...(body.query !== undefined ? { query: body.query } : {}) });
  return { research: result };
});

app.get("/projects/:id/tasks", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const project = getProject(id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  return { tasks: listTasks(id) };
});

startUsageWatchdog();
void startTelegramBot();
import("./connectivity.ts").then(({ startConnectivityProbe }) => startConnectivityProbe());

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
