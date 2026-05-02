import { logger } from "../logger.ts";
import { roles, type Role } from "../roles/registry.ts";
import { route } from "../llm/router.ts";
import {
  appendMessage,
  listMessages,
  type Message,
} from "../repos/messages.ts";
import {
  getProject,
  setProjectState,
  type Project,
} from "../repos/projects.ts";
import {
  getOpusHeadroom,
  getSonnetHeadroom,
  estimateTaskCostPct,
  type Headroom,
} from "../cost/headroom.ts";

export const READY_TOKEN = "<<READY_TO_PLAN>>";

export interface RunBossTurnArgs {
  projectId: string;
  userMessage?: string;
}

export interface RunBossTurnResult {
  reply: string;
  readyToPlan: boolean;
  newState: Project["state"];
}

const BOSS_SYSTEM_PROMPT = roles.get("boss").system_prompt;

function buildBossPrompt(project: Project, history: Message[], userMessage?: string): string {
  const lines: string[] = [];
  lines.push(`# Project context`);
  lines.push(`Idea (raw): ${project.idea}`);
  lines.push(`Slug: ${project.slug}`);
  lines.push(`State: ${project.state}`);
  lines.push("");
  lines.push(`# Conversation so far`);
  for (const m of history) {
    const tag = m.role === "user" ? "USER" : m.role === "boss" ? "BOSS" : m.role.toUpperCase();
    lines.push(`${tag}: ${m.content}`);
  }
  if (userMessage !== undefined) {
    lines.push(`USER: ${userMessage}`);
  }
  lines.push("");
  lines.push(`# Your turn (Boss)`);
  lines.push(
    `Continue the Q&A. Batch 2-5 questions in one reply if multiple are needed.`,
  );
  lines.push(
    `When (and only when) problem + user + expected output are crystal clear per CLAUDE.md Step 0,`,
  );
  lines.push(`end your reply with the literal token ${READY_TOKEN} on its own line.`);
  return lines.join("\n");
}

export async function runBossTurn(args: RunBossTurnArgs): Promise<RunBossTurnResult> {
  const { projectId, userMessage } = args;
  const project = getProject(projectId);
  if (!project) throw new Error(`unknown project: ${projectId}`);

  if (userMessage !== undefined && userMessage.trim().length > 0) {
    appendMessage({ project_id: projectId, role: "user", author: "user", content: userMessage });
  }

  const history = listMessages(projectId);
  const prompt = buildBossPrompt(project, history.slice(0, -1), userMessage);

  const bossRole = roles.get("boss");
  const tier = pickBossTier();
  const claudeModel = tier === "opus" ? "claude-opus-4-7" : "claude-sonnet-4-6";

  const result = await route({
    roleId: "boss",
    projectId,
    prompt,
    model: claudeModel,
    systemPrompt: BOSS_SYSTEM_PROMPT,
    offlineFallbackModel: bossRole.offline_model,
    allocatedBy: "boss",
  });

  const reply = result.text;
  appendMessage({ project_id: projectId, role: "boss", author: "boss", content: reply });

  const readyToPlan = reply.includes(READY_TOKEN);
  let newState: Project["state"] = project.state;
  if (readyToPlan && project.state === "qna") {
    setProjectState(projectId, "awaiting_plan_generation");
    newState = "awaiting_plan_generation";
  }

  return { reply, readyToPlan, newState };
}

function pickBossTier(): "opus" | "sonnet" {
  const opus = getOpusHeadroom();
  return opus.headroom_pct >= 1 ? "opus" : "sonnet";
}

export interface PendingTask {
  id: string;
  role: string;
  description: string;
  required_tier?: "opus" | "sonnet";
}

export interface AllocationDecision {
  model: string;
  requires?: "opus" | "sonnet";
}

export interface AllocateModelsArgs {
  pendingTasks: PendingTask[];
  manualOverrides?: Record<string, string>;
}

const MODEL_OPUS = "claude-opus-4-7";
const MODEL_SONNET = "claude-sonnet-4-6";

/**
 * Boss-led model allocation. Phase 4 ships the deterministic fallback allocator
 * that the LLM-driven version reduces to when validation fails. Phase 5+
 * upgrades to a real Claude call that proposes an allocation table; for now
 * the deterministic logic runs every time, which is correct & cheap.
 */
export function allocateModels(args: AllocateModelsArgs): Record<string, AllocationDecision> {
  const { pendingTasks, manualOverrides } = args;
  const opus = getOpusHeadroom();
  const sonnet = getSonnetHeadroom();
  let opusBudget = opus.headroom_pct;
  let sonnetBudget = sonnet.headroom_pct;

  const allocation: Record<string, AllocationDecision> = {};

  for (const task of pendingTasks) {
    const override = manualOverrides?.[task.id];
    if (override) {
      allocation[task.id] = { model: override };
      continue;
    }

    const role = roleFor(task.role);
    const hint = role.default_tier_hint;
    const required = task.required_tier;

    if (required === "opus") {
      const cost = estimateTaskCostPct(task, "opus");
      if (cost <= opusBudget) {
        opusBudget -= cost;
        allocation[task.id] = { model: MODEL_OPUS, requires: "opus" };
      } else {
        allocation[task.id] = { model: MODEL_OPUS, requires: "opus" };
      }
      continue;
    }
    if (required === "sonnet") {
      const cost = estimateTaskCostPct(task, "sonnet");
      if (cost <= sonnetBudget) {
        sonnetBudget -= cost;
        allocation[task.id] = { model: MODEL_SONNET, requires: "sonnet" };
      } else {
        allocation[task.id] = { model: MODEL_SONNET, requires: "sonnet" };
      }
      continue;
    }

    if (hint === "opus") {
      const cost = estimateTaskCostPct(task, "opus");
      if (cost <= opusBudget) {
        opusBudget -= cost;
        allocation[task.id] = { model: MODEL_OPUS };
        continue;
      }
    }
    if (hint === "opus" || hint === "sonnet") {
      const cost = estimateTaskCostPct(task, "sonnet");
      if (cost <= sonnetBudget) {
        sonnetBudget -= cost;
        allocation[task.id] = { model: MODEL_SONNET };
        continue;
      }
    }
    allocation[task.id] = { model: role.offline_model };
  }

  return allocation;
}

function roleFor(roleId: string): Role {
  if (roles.has(roleId)) return roles.get(roleId);
  throw new Error(`allocation references unknown role: ${roleId}`);
}

export interface EscalationPayload {
  taskId: string;
  projectId: string;
  taskDescription: string;
  requiredTier: "opus" | "sonnet";
  opus: Headroom;
  sonnet: Headroom;
}

/**
 * Composes the Telegram message for hard-stop blocked tasks. Phase 6 wires
 * this into the actual bot; for now it returns the rendered text + buttons
 * spec so callers can dispatch via whatever channel exists.
 */
export function composeEscalation(payload: EscalationPayload): {
  text: string;
  buttons: { label: string; action: string }[];
} {
  const { taskId, projectId, taskDescription, requiredTier, opus, sonnet } = payload;
  const text = [
    `🚦 Task blocked — ${requiredTier.toUpperCase()} required, none available`,
    `Project: ${projectId}`,
    `Task: ${taskId} — ${taskDescription}`,
    ``,
    `Opus: ${opus.used_pct.toFixed(1)}% used / ceiling ${opus.ceiling_pct}% (reserve ${opus.reserve_pct}% for ${opus.days_remaining}d)`,
    `Sonnet: ${sonnet.used_pct.toFixed(1)}% used / ceiling ${sonnet.ceiling_pct}% (reserve ${sonnet.reserve_pct}% for ${sonnet.days_remaining}d)`,
    ``,
    `Pick one to unblock:`,
  ].join("\n");

  return {
    text,
    buttons: [
      { label: "Use Sonnet anyway", action: `unblock:${taskId}:use_sonnet` },
      { label: "Use Ollama anyway", action: `unblock:${taskId}:use_ollama` },
      { label: "Wait for headroom", action: `unblock:${taskId}:wait` },
      { label: "Cancel task", action: `unblock:${taskId}:cancel` },
    ],
  };
}

export interface UsageWatchdogState {
  lastOpus: Headroom | null;
  lastSonnet: Headroom | null;
  intervalMs: number;
  timer: NodeJS.Timeout | null;
}

const WATCHDOG_INTERVAL_MS = 3 * 60 * 1000;
const watchdogState: UsageWatchdogState = {
  lastOpus: null,
  lastSonnet: null,
  intervalMs: WATCHDOG_INTERVAL_MS,
  timer: null,
};

export interface WatchdogTick {
  changed: boolean;
  opus: Headroom;
  sonnet: Headroom;
  prevOpus: Headroom | null;
  prevSonnet: Headroom | null;
}

export function tickWatchdog(): WatchdogTick {
  const opus = getOpusHeadroom();
  const sonnet = getSonnetHeadroom();
  const prevOpus = watchdogState.lastOpus;
  const prevSonnet = watchdogState.lastSonnet;
  const changed =
    prevOpus === null ||
    prevSonnet === null ||
    prevOpus.headroom_pct !== opus.headroom_pct ||
    prevSonnet.headroom_pct !== sonnet.headroom_pct;
  watchdogState.lastOpus = opus;
  watchdogState.lastSonnet = sonnet;
  if (changed) {
    logger.info(
      { opus: opus.headroom_pct, sonnet: sonnet.headroom_pct },
      "headroom changed",
    );
  }
  return { changed, opus, sonnet, prevOpus, prevSonnet };
}

export function startUsageWatchdog(): void {
  if (watchdogState.timer) return;
  watchdogState.timer = setInterval(tickWatchdog, watchdogState.intervalMs);
  logger.info({ intervalMs: watchdogState.intervalMs }, "boss usage watchdog started");
}

export function stopUsageWatchdog(): void {
  if (watchdogState.timer) {
    clearInterval(watchdogState.timer);
    watchdogState.timer = null;
  }
}
