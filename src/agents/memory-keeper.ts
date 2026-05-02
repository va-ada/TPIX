import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.ts";
import { route } from "../llm/router.ts";
import { roles } from "../roles/registry.ts";
import { getProject } from "../repos/projects.ts";
import { listMessages } from "../repos/messages.ts";
import { latestPlan } from "../repos/plans.ts";
import { listTasks } from "../repos/tasks.ts";

const MEMORY_DIR = "memory";

export async function distillProject(projectId: string): Promise<string> {
  const project = getProject(projectId);
  if (!project) throw new Error(`unknown project: ${projectId}`);

  const messages = listMessages(projectId);
  const plan = latestPlan(projectId);
  const tasks = listTasks(projectId);
  const role = roles.get("memory-keeper");

  const summary = [
    `# Project context`,
    `slug: ${project.slug}`,
    `idea: ${project.idea}`,
    `state: ${project.state}`,
    ``,
    `# Conversation (${messages.length} messages)`,
    messages.map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 500)}`).join("\n"),
    ``,
    `# Plan`,
    plan ? plan.json.slice(0, 5000) : "(no plan)",
    ``,
    `# Tasks (${tasks.length})`,
    tasks.map((t) => `- ${t.id} [${t.status}] ${t.role}: ${t.description}`).join("\n"),
  ].join("\n");

  const result = await route({
    roleId: "memory-keeper",
    projectId,
    prompt: summary,
    model: role.offline_model,
    systemPrompt: role.system_prompt,
    allocatedBy: "boss",
  });

  mkdirSync(MEMORY_DIR, { recursive: true });
  const path = join(MEMORY_DIR, `${project.slug}.md`);
  writeFileSync(path, result.text, "utf8");
  logger.info({ projectId, path }, "project memory written");
  return path;
}
