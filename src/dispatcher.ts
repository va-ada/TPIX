import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { db } from "./db.ts";
import { logger } from "./logger.ts";
import { route } from "./llm/router.ts";
import { roles } from "./roles/registry.ts";
import {
  listTasks,
  readyTasks,
  setTaskStatus,
  type Task,
} from "./repos/tasks.ts";
import { getProject, setProjectState } from "./repos/projects.ts";
import {
  allocateModels,
  composeEscalation,
  type AllocationDecision,
  type PendingTask,
} from "./agents/boss.ts";
import { getOpusHeadroom, getSonnetHeadroom } from "./cost/headroom.ts";

const DEFAULT_CONCURRENCY = 3;

const insertAgentRun = db.prepare(`
  INSERT INTO agent_runs (task_id, project_id, role_id, model, prompt, status)
  VALUES (@task_id, @project_id, @role_id, @model, @prompt, 'running')
`);

const finishAgentRun = db.prepare(`
  UPDATE agent_runs
  SET output = ?, session_id = ?, status = ?, finished_at = datetime('now')
  WHERE id = ?
`);

const insertTaskRun = db.prepare(`
  INSERT INTO task_runs (task_id, attempt, status, model, started_at, finished_at)
  VALUES (@task_id, @attempt, @status, @model, datetime('now'), datetime('now'))
`);

export interface DispatchResult {
  ranTaskIds: string[];
  blockedTaskIds: string[];
  remainingPending: number;
}

export interface DispatchOptions {
  concurrency?: number;
  manualOverrides?: Record<string, string>;
}

export async function dispatchProject(
  projectId: string,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const project = getProject(projectId);
  if (!project) throw new Error(`unknown project: ${projectId}`);

  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const ready = readyTasks(projectId);
  if (ready.length === 0) {
    return { ranTaskIds: [], blockedTaskIds: [], remainingPending: 0 };
  }

  ensureWorkspace(project.slug);

  const pending: PendingTask[] = ready.map((t) => {
    const p: PendingTask = {
      id: t.id,
      role: t.role,
      description: t.description,
    };
    if (t.required_tier !== null) p.required_tier = t.required_tier;
    return p;
  });
  const overrides = options.manualOverrides ?? {};
  const allocation = allocateModels({ pendingTasks: pending, manualOverrides: overrides });

  const ranTaskIds: string[] = [];
  const blockedTaskIds: string[] = [];

  // Split into runnable vs blocked-by-required-tier
  const opusHeadroom = getOpusHeadroom().headroom_pct;
  const sonnetHeadroom = getSonnetHeadroom().headroom_pct;

  const runnable: Array<{ task: Task; decision: AllocationDecision }> = [];
  for (const task of ready) {
    const decision = allocation[task.id];
    if (!decision) continue;

    if (decision.requires === "opus" && opusHeadroom <= 0) {
      handleHardStop(task, "opus");
      blockedTaskIds.push(task.id);
      continue;
    }
    if (decision.requires === "sonnet" && sonnetHeadroom <= 0) {
      handleHardStop(task, "sonnet");
      blockedTaskIds.push(task.id);
      continue;
    }
    runnable.push({ task, decision });
  }

  // Run with bounded concurrency
  const queue = [...runnable];
  const inFlight: Promise<void>[] = [];

  const runOne = async ({ task, decision }: { task: Task; decision: AllocationDecision }) => {
    setTaskStatus(task.id, "running");
    try {
      const role = roles.get(task.role);
      const taskPrompt = buildTaskPrompt(task, project.slug);
      const runRow = insertAgentRun.run({
        task_id: task.id,
        project_id: projectId,
        role_id: task.role,
        model: decision.model,
        prompt: taskPrompt,
      });
      const agentRunId = Number(runRow.lastInsertRowid);

      let result;
      try {
        result = await route({
          roleId: task.role,
          projectId,
          prompt: taskPrompt,
          model: decision.model,
          systemPrompt: role.system_prompt,
          offlineFallbackModel: role.offline_model,
          allocatedBy: overrides[task.id] ? "manual_override" : "boss",
        });
      } catch (err) {
        finishAgentRun.run(null, null, "failed", agentRunId);
        setTaskStatus(task.id, "needs_rework");
        logger.error({ err, taskId: task.id }, "task execution failed");
        return;
      }

      finishAgentRun.run(result.text, result.sessionId, "succeeded", agentRunId);
      insertTaskRun.run({
        task_id: task.id,
        attempt: 1,
        status: "completed",
        model: result.model,
      });
      setTaskStatus(task.id, "done");
      ranTaskIds.push(task.id);
    } catch (outerErr) {
      logger.error({ err: outerErr, taskId: task.id }, "unhandled task error");
      setTaskStatus(task.id, "needs_rework");
    }
  };

  while (queue.length > 0 || inFlight.length > 0) {
    while (queue.length > 0 && inFlight.length < concurrency) {
      const next = queue.shift()!;
      const p = runOne(next).finally(() => {
        const i = inFlight.indexOf(p);
        if (i >= 0) inFlight.splice(i, 1);
      });
      inFlight.push(p);
    }
    if (inFlight.length > 0) {
      await Promise.race(inFlight);
    }
  }

  const all = listTasks(projectId);
  const remainingPending = all.filter(
    (t) => t.status !== "done" && t.status !== "cancelled",
  ).length;

  if (remainingPending === 0) {
    setProjectState(projectId, "completed");
  }

  return { ranTaskIds, blockedTaskIds, remainingPending };
}

function buildTaskPrompt(task: Task, projectSlug: string): string {
  const lines: string[] = [];
  lines.push(`# Task ${task.id}`);
  lines.push(`Role: ${task.role}`);
  lines.push(`Description: ${task.description}`);
  if (task.pass1) lines.push(`Pass-1 spec (synthetic test): ${task.pass1}`);
  if (task.pass2) lines.push(`Pass-2 spec (real-world test): ${task.pass2}`);
  lines.push(`Workspace: projects/${projectSlug}/`);
  lines.push(``);
  lines.push(`Do the work. When done, return a short summary of what changed and what you tested.`);
  return lines.join("\n");
}

function handleWorkspaceMkdir(slug: string) {
  const dir = join("projects", slug);
  mkdirSync(dir, { recursive: true });
}

function ensureWorkspace(slug: string): void {
  handleWorkspaceMkdir(slug);
}

function handleHardStop(task: Task, requiredTier: "opus" | "sonnet"): void {
  setTaskStatus(task.id, "blocked_awaiting_user");
  const escalation = composeEscalation({
    taskId: task.id,
    projectId: task.project_id,
    taskDescription: task.description,
    requiredTier,
    opus: getOpusHeadroom(),
    sonnet: getSonnetHeadroom(),
  });
  logger.warn(
    { taskId: task.id, requiredTier, escalation: escalation.text },
    "task hard-stopped — required tier unavailable; awaiting user (Telegram bot in Phase 6 will deliver this)",
  );
}
