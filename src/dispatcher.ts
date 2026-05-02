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
import { runReviewers, MAX_TASK_ATTEMPTS } from "./reviewers.ts";
import { commitIfWorthIt, noteTaskCompleted } from "./git.ts";
import { dispatchSkipReason, isDispatcherPaused, pausedRoles } from "./control.ts";

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
  INSERT INTO task_runs (task_id, attempt, status, model, pass1_result, pass2_result, started_at, finished_at)
  VALUES (@task_id, @attempt, @status, @model, @pass1_result, @pass2_result, datetime('now'), datetime('now'))
`);

const countTaskRunsStmt = db.prepare<[string], { n: number }>(`
  SELECT COUNT(*) as n FROM task_runs WHERE task_id = ?
`);

function attemptCount(taskId: string): number {
  return countTaskRunsStmt.get(taskId)?.n ?? 0;
}

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

  if (isDispatcherPaused()) {
    logger.info({ projectId }, "dispatcher globally paused — skipping");
    return { ranTaskIds: [], blockedTaskIds: [], remainingPending: 0 };
  }

  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const allReady = readyTasks(projectId);
  const pausedRoleSet = pausedRoles();
  const ready = allReady.filter((t) => {
    const reason = dispatchSkipReason(t);
    if (reason) {
      logger.debug({ taskId: t.id, reason }, "task skipped by control");
      return false;
    }
    return !pausedRoleSet.has(t.role);
  });

  if (ready.length === 0) {
    return { ranTaskIds: [], blockedTaskIds: [], remainingPending: allReady.length };
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

      // QA pipeline: trigger relevant reviewers in parallel
      const review = await runReviewers({ task, output: result.text, projectId });
      const attempts = attemptCount(task.id) + 1;

      insertTaskRun.run({
        task_id: task.id,
        attempt: attempts,
        status: review.approved ? "approved" : "rework_requested",
        model: result.model,
        pass1_result: review.results.find((r) => r.reviewerId === "tester")?.verdict ?? null,
        pass2_result: review.combinedCritique || null,
      });

      if (review.approved) {
        setTaskStatus(task.id, "done");
        ranTaskIds.push(task.id);
        noteTaskCompleted(projectId);
        // Auto-commit if heuristics say we should (debounced internally)
        await commitIfWorthIt({
          projectId,
          reason: `${task.role}: ${task.description.slice(0, 80)}`,
          force: false,
          authorRole: task.role,
        });
      } else if (attempts >= MAX_TASK_ATTEMPTS) {
        setTaskStatus(task.id, "blocked_awaiting_user");
        logger.warn(
          { taskId: task.id, attempts, critique: review.combinedCritique },
          "task exceeded max review attempts — escalating to user",
        );
        // Force a snapshot before we ask the user about this task
        await commitIfWorthIt({
          projectId,
          reason: `escalation: ${task.id} (${task.role}) hit max attempts`,
          force: true,
          authorRole: "boss",
        });
      } else {
        setTaskStatus(task.id, "needs_rework");
        logger.info(
          { taskId: task.id, attempt: attempts, critique: review.combinedCritique.slice(0, 200) },
          "task needs rework",
        );
      }
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

const lastCritiqueStmt = db.prepare<[string], { pass2_result: string | null; attempt: number }>(`
  SELECT pass2_result, attempt FROM task_runs WHERE task_id = ?
  ORDER BY id DESC LIMIT 1
`);

function buildTaskPrompt(task: Task, projectSlug: string): string {
  const lines: string[] = [];
  lines.push(`# Task ${task.id}`);
  lines.push(`Role: ${task.role}`);
  lines.push(`Description: ${task.description}`);
  if (task.pass1) lines.push(`Pass-1 spec (synthetic test): ${task.pass1}`);
  if (task.pass2) lines.push(`Pass-2 spec (real-world test): ${task.pass2}`);
  lines.push(`Workspace: projects/${projectSlug}/`);

  // If this is a rework attempt, surface the previous review critique
  if (task.status === "needs_rework") {
    const last = lastCritiqueStmt.get(task.id);
    if (last?.pass2_result) {
      lines.push(``);
      lines.push(`## Prior review (attempt ${last.attempt}) flagged the following:`);
      lines.push(last.pass2_result);
      lines.push(``);
      lines.push(`Address every point. This is attempt ${last.attempt + 1}/${MAX_TASK_ATTEMPTS}.`);
    }
  }

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
    "task hard-stopped — required tier unavailable; awaiting user via Telegram bot",
  );
  // Force a snapshot commit before escalating
  void commitIfWorthIt({
    projectId: task.project_id,
    reason: `hard-stop: ${task.id} requires ${requiredTier}`,
    force: true,
    authorRole: "boss",
  });
}
