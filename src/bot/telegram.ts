import { Bot, InlineKeyboard, type Context } from "grammy";
import { config } from "../config.ts";
import { logger } from "../logger.ts";
import {
  createProject,
  getProject,
  listProjects,
  setModelOverride,
  setProjectState,
} from "../repos/projects.ts";
import { runBossTurn } from "../agents/boss.ts";
import { generatePlan } from "../agents/planner.ts";
import { latestPlan, approvePlan } from "../repos/plans.ts";
import { getTask, setTaskStatus } from "../repos/tasks.ts";
import { dispatchProject } from "../dispatcher.ts";
import {
  getOpusHeadroom,
  getSonnetHeadroom,
  applyManualSync,
  setOpusCap,
  setSonnetCap,
  setPeriod,
  getOpusCap,
  getSonnetCap,
} from "../cost/headroom.ts";

const TG_MESSAGE_LIMIT = 4096;
let activeProjectId: string | null = null;
let bot: Bot | null = null;

export function isBotConfigured(): boolean {
  return Boolean(config.telegramBotToken && config.telegramUserChatId);
}

export function getBot(): Bot {
  if (!bot) throw new Error("Telegram bot not initialised — call startTelegramBot first");
  return bot;
}

/**
 * Send a message to the configured user chat. Splits at the 4096-char Telegram
 * API ceiling (no internal length cap, per the user's spec).
 */
export async function sendToUser(text: string, options?: { reply_markup?: unknown }): Promise<void> {
  if (!isBotConfigured() || !bot) return;
  const chatId = Number(config.telegramUserChatId);
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n` : "";
    const body = prefix + chunks[i];
    const isLast = i === chunks.length - 1;
    // eslint-disable-next-line no-await-in-loop
    await bot.api.sendMessage(chatId, body, isLast && options?.reply_markup ? { reply_markup: options.reply_markup as never } : undefined);
  }
}

export function splitMessage(text: string, limit = TG_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const reserveForPrefix = 16;
  const safeLimit = limit - reserveForPrefix;
  const out: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + safeLimit, text.length);
    if (end < text.length) {
      const lastNewline = text.lastIndexOf("\n", end);
      if (lastNewline > cursor + safeLimit / 2) end = lastNewline;
    }
    out.push(text.slice(cursor, end));
    cursor = end;
  }
  return out;
}

function isAuthorized(ctx: Context): boolean {
  if (!config.telegramUserChatId) return false;
  return String(ctx.chat?.id) === config.telegramUserChatId;
}

function rejectUnauthorized(ctx: Context): boolean {
  if (isAuthorized(ctx)) return false;
  logger.warn({ chatId: ctx.chat?.id }, "rejected unauthorized telegram chat");
  ctx.reply("Not authorized.").catch(() => {});
  return true;
}

export async function startTelegramBot(): Promise<void> {
  if (!isBotConfigured()) {
    logger.warn("telegram bot not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_USER_CHAT_ID missing) — skipping");
    return;
  }
  if (bot) return;

  bot = new Bot(config.telegramBotToken!);

  bot.command("start", async (ctx) => {
    if (rejectUnauthorized(ctx)) return;
    await ctx.reply(
      [
        "TPIX online.",
        "",
        "/new <idea> — start a project",
        "/projects — list projects",
        "/status — show active project state",
        "/budget — Opus + Sonnet headroom",
        "/cancel <id> — cancel a project",
        "/use <opus|sonnet|ollama> — set model override on the active project",
        "Free-text reply continues the active project's Q&A.",
      ].join("\n"),
    );
  });

  bot.command("new", async (ctx) => {
    if (rejectUnauthorized(ctx)) return;
    const idea = ctx.match.trim();
    if (!idea) return ctx.reply("Usage: /new <idea>");
    const project = createProject(idea);
    activeProjectId = project.id;
    const turn = await runBossTurn({ projectId: project.id, userMessage: idea });
    await ctx.reply(`Project ${project.slug} created (active).`);
    await sendToUser(turn.reply);
    if (turn.readyToPlan) await offerPlanGeneration(project.id);
  });

  bot.command("projects", async (ctx) => {
    if (rejectUnauthorized(ctx)) return;
    const all = listProjects();
    if (all.length === 0) return ctx.reply("No projects yet. /new <idea>");
    const lines = all.slice(0, 20).map(
      (p) => `${activeProjectId === p.id ? "*" : " "} ${p.slug} — ${p.state} — ${p.id.slice(0, 8)}`,
    );
    await ctx.reply(lines.join("\n"));
  });

  bot.command("status", async (ctx) => {
    if (rejectUnauthorized(ctx)) return;
    if (!activeProjectId) return ctx.reply("No active project. /new <idea> or /projects to pick.");
    const p = getProject(activeProjectId);
    if (!p) return ctx.reply("Active project vanished.");
    await ctx.reply(`Active: ${p.slug}\nState: ${p.state}\nId: ${p.id}`);
  });

  bot.command("budget", async (ctx) => {
    if (rejectUnauthorized(ctx)) return;
    const o = getOpusHeadroom();
    const s = getSonnetHeadroom();
    const opusCap = getOpusCap();
    const sonnetCap = getSonnetCap();
    await ctx.reply(
      [
        `Opus:   used ${o.used_pct.toFixed(1)}%  ceiling ${o.ceiling_pct}%  headroom ${o.headroom_pct.toFixed(1)}%  (reserve ${o.reserve_pct}% for ${o.days_remaining}d) [src: ${o.source}]`,
        `Sonnet: used ${s.used_pct.toFixed(1)}%  ceiling ${s.ceiling_pct}%  headroom ${s.headroom_pct.toFixed(1)}%  (reserve ${s.reserve_pct}% for ${s.days_remaining}d) [src: ${s.source}]`,
        ``,
        `Caps: opus=${opusCap ?? "(unset)"} tokens, sonnet=${sonnetCap ?? "(unset)"} tokens`,
        `Set with: /setcap opus <tokens> | /setcap sonnet <tokens>`,
        `Override usage: /sync <opus_pct> <sonnet_pct>  (1h TTL)`,
        `Reset period:   /period <YYYY-MM-DD> <length_days>`,
      ].join("\n"),
    );
  });

  bot.command("sync", async (ctx) => {
    if (rejectUnauthorized(ctx)) return;
    const parts = ctx.match.trim().split(/\s+/);
    if (parts.length !== 2) {
      return ctx.reply("Usage: /sync <opus_pct> <sonnet_pct>  e.g. /sync 35 60");
    }
    const opusPct = Number(parts[0]);
    const sonnetPct = Number(parts[1]);
    if (!Number.isFinite(opusPct) || !Number.isFinite(sonnetPct)) {
      return ctx.reply("Both values must be numbers.");
    }
    applyManualSync(opusPct, sonnetPct);
    await ctx.reply(`Synced. Opus=${opusPct}% Sonnet=${sonnetPct}% (TTL 1h)`);
  });

  bot.command("setcap", async (ctx) => {
    if (rejectUnauthorized(ctx)) return;
    const parts = ctx.match.trim().split(/\s+/);
    if (parts.length !== 2) {
      return ctx.reply("Usage: /setcap <opus|sonnet> <tokens>");
    }
    const tier = parts[0]!.toLowerCase();
    const tokens = Number(parts[1]);
    if (!Number.isFinite(tokens) || tokens <= 0) {
      return ctx.reply("Tokens must be a positive number.");
    }
    if (tier === "opus") setOpusCap(tokens);
    else if (tier === "sonnet") setSonnetCap(tokens);
    else return ctx.reply("Tier must be opus or sonnet.");
    await ctx.reply(`Cap set: ${tier} = ${tokens.toLocaleString()} tokens`);
  });

  bot.command("period", async (ctx) => {
    if (rejectUnauthorized(ctx)) return;
    const parts = ctx.match.trim().split(/\s+/);
    if (parts.length !== 2) {
      return ctx.reply("Usage: /period <YYYY-MM-DD> <length_days>  e.g. /period 2026-05-02 7");
    }
    const date = parts[0]!;
    const days = Number(parts[1]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(days) || days <= 0) {
      return ctx.reply("Date must be YYYY-MM-DD; days must be > 0.");
    }
    setPeriod(`${date}T00:00:00.000Z`, days);
    await ctx.reply(`Period set: starts ${date}, length ${days}d`);
  });

  bot.command("cancel", async (ctx) => {
    if (rejectUnauthorized(ctx)) return;
    const id = ctx.match.trim();
    if (!id) return ctx.reply("Usage: /cancel <project-id-prefix>");
    const all = listProjects();
    const match = all.find((p) => p.id.startsWith(id) || p.slug === id);
    if (!match) return ctx.reply(`No project matched "${id}"`);
    setProjectState(match.id, "cancelled");
    if (activeProjectId === match.id) activeProjectId = null;
    await ctx.reply(`Cancelled ${match.slug}.`);
  });

  bot.command("use", async (ctx) => {
    if (rejectUnauthorized(ctx)) return;
    if (!activeProjectId) return ctx.reply("No active project.");
    const tier = ctx.match.trim().toLowerCase();
    if (!["opus", "sonnet", "ollama", "auto"].includes(tier))
      return ctx.reply("Usage: /use <opus|sonnet|ollama|auto>");
    const override =
      tier === "opus"
        ? "claude-opus-4-7"
        : tier === "sonnet"
          ? "claude-sonnet-4-6"
          : tier === "ollama"
            ? "ollama"
            : null;
    setModelOverride(activeProjectId, override);
    await ctx.reply(`Model override on active project: ${override ?? "auto (cleared)"}`);
  });

  // Inline-button callback dispatcher
  bot.callbackQuery(/^plan:approve:(.+)$/, async (ctx) => {
    if (rejectUnauthorized(ctx)) return;
    const projectId = ctx.match[1]!;
    const plan = latestPlan(projectId);
    if (!plan) return ctx.answerCallbackQuery({ text: "no plan" });
    approvePlan(plan.id);
    setProjectState(projectId, "in_progress");
    await ctx.answerCallbackQuery({ text: "Approved." });
    await sendToUser(`✅ Plan approved for ${projectId.slice(0, 8)} — dispatching tasks…`);
    void dispatchProject(projectId).then((r) =>
      sendToUser(
        `Dispatch tick: ran ${r.ranTaskIds.length}, blocked ${r.blockedTaskIds.length}, remaining ${r.remainingPending}`,
      ),
    );
  });

  bot.callbackQuery(/^plan:reject:(.+)$/, async (ctx) => {
    if (rejectUnauthorized(ctx)) return;
    const projectId = ctx.match[1]!;
    setProjectState(projectId, "qna");
    await ctx.answerCallbackQuery({ text: "Rejected — back to Q&A." });
    await sendToUser(`Plan rejected for ${projectId.slice(0, 8)}. Reply with what to change.`);
  });

  bot.callbackQuery(/^unblock:(.+):(use_sonnet|use_ollama|wait|cancel)$/, async (ctx) => {
    if (rejectUnauthorized(ctx)) return;
    const taskId = ctx.match[1]!;
    const action = ctx.match[2]!;
    const task = getTask(taskId);
    if (!task) return ctx.answerCallbackQuery({ text: "task vanished" });
    if (action === "cancel") {
      setTaskStatus(taskId, "cancelled");
    } else if (action === "wait") {
      setTaskStatus(taskId, "awaiting_headroom");
    } else {
      // use_sonnet or use_ollama → mark ready and let next dispatch tick pick it up
      setTaskStatus(taskId, "ready");
    }
    await ctx.answerCallbackQuery({ text: `Acted: ${action}` });
    await sendToUser(`Task ${taskId} → ${action}`);
  });

  // Free-text routes to the active project as a user message
  bot.on("message:text", async (ctx) => {
    if (rejectUnauthorized(ctx)) return;
    if (ctx.message.text.startsWith("/")) return; // skip unknown commands
    if (!activeProjectId) return ctx.reply("No active project. /new <idea>");
    const turn = await runBossTurn({
      projectId: activeProjectId,
      userMessage: ctx.message.text,
    });
    await sendToUser(turn.reply);
    if (turn.readyToPlan) await offerPlanGeneration(activeProjectId);
  });

  bot.catch((err) => {
    logger.error({ err: err.error, ctx: err.ctx?.update }, "telegram bot error");
  });

  // long-polling — no webhook needed
  void bot.start({
    onStart: () => logger.info("telegram bot started (long-polling)"),
  });
}

async function offerPlanGeneration(projectId: string): Promise<void> {
  await sendToUser(`✅ Ready to plan. Generating…`);
  try {
    const plan = await generatePlan(projectId);
    const phasesSummary = plan.phases
      .map((p) => `• ${p.name}: ${p.tasks.length} task(s)`)
      .join("\n");
    const kb = new InlineKeyboard()
      .text("✅ Approve", `plan:approve:${projectId}`)
      .text("❌ Reject", `plan:reject:${projectId}`);
    await sendToUser(
      `Plan ready for ${projectId.slice(0, 8)}:\n${phasesSummary}\n\nApprove to dispatch.`,
      { reply_markup: kb },
    );
  } catch (err) {
    const e = err as Error;
    logger.error({ err: e.message, projectId }, "plan generation failed");
    await sendToUser(`⚠️ Plan generation failed: ${e.message}`);
  }
}

export function setActiveProject(projectId: string): void {
  activeProjectId = projectId;
}

export function getActiveProject(): string | null {
  return activeProjectId;
}
