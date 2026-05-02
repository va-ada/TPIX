import { db } from "../db.ts";
import { logger } from "../logger.ts";
import { runClaude, type RunClaudeResult } from "./claude.ts";
import { runOllama, type RunOllamaResult } from "./ollama.ts";
import { isClaudeReachable } from "./probe.ts";

export type AllocatedBy = "boss" | "manual_override" | "forced_offline" | "debug";

export interface RouteArgs {
  roleId: string;
  prompt: string;
  model: string;
  projectId?: string;
  sessionId?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  cwd?: string;
  permissionMode?: "default" | "acceptEdits" | "auto" | "bypassPermissions" | "dontAsk" | "plan";
  timeoutMs?: number;
  /**
   * Ollama tag to fall back to when `model` is a Claude model and Anthropic is unreachable.
   * Once the role registry exists (Phase 3), this is auto-resolved per role; for now callers
   * pass it explicitly.
   */
  offlineFallbackModel?: string;
  allocatedBy?: AllocatedBy;
}

export interface RouteResult {
  text: string;
  model: string;
  route: "claude" | "ollama";
  sessionId: string | null;
  promptChars: number;
  completionChars: number;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
  forcedOffline: boolean;
}

const insertTokenLog = db.prepare(`
  INSERT INTO tokens_log (
    role_id, project_id, route, model,
    prompt_chars, completion_chars,
    prompt_tokens, completion_tokens,
    latency_ms, allocated_by
  ) VALUES (
    @role_id, @project_id, @route, @model,
    @prompt_chars, @completion_chars,
    @prompt_tokens, @completion_tokens,
    @latency_ms, @allocated_by
  )
`);

export async function route(args: RouteArgs): Promise<RouteResult> {
  const {
    roleId,
    prompt,
    model,
    projectId,
    sessionId,
    systemPrompt,
    allowedTools,
    cwd,
    permissionMode,
    timeoutMs,
    offlineFallbackModel,
    allocatedBy,
  } = args;

  const isClaudeModel = model.startsWith("claude-");
  let result: RouteResult;

  if (isClaudeModel) {
    const reachable = await isClaudeReachable();
    if (reachable) {
      const r = await runClaude({
        prompt,
        model,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        ...(allowedTools !== undefined ? { allowedTools } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(permissionMode !== undefined ? { permissionMode } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      result = claudeToRouteResult(r, "claude", false);
    } else {
      if (!offlineFallbackModel) {
        throw new Error(
          `Claude model ${model} requested but Anthropic is unreachable and no offlineFallbackModel was provided`,
        );
      }
      logger.warn(
        { requestedModel: model, fallback: offlineFallbackModel, roleId },
        "anthropic unreachable, falling back to ollama",
      );
      const r = await runOllama({
        prompt,
        model: offlineFallbackModel,
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      });
      result = ollamaToRouteResult(r, "ollama", true);
    }
  } else {
    const r = await runOllama({
      prompt,
      model,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    });
    result = ollamaToRouteResult(r, "ollama", false);
  }

  insertTokenLog.run({
    role_id: roleId,
    project_id: projectId ?? null,
    route: result.route,
    model: result.model,
    prompt_chars: result.promptChars,
    completion_chars: result.completionChars,
    prompt_tokens: result.promptTokens,
    completion_tokens: result.completionTokens,
    latency_ms: result.latencyMs,
    allocated_by: result.forcedOffline ? "forced_offline" : (allocatedBy ?? "boss"),
  });

  return result;
}

function claudeToRouteResult(
  r: RunClaudeResult,
  routeName: "claude",
  forcedOffline: boolean,
): RouteResult {
  return {
    text: r.text,
    model: r.model,
    route: routeName,
    sessionId: r.sessionId,
    promptChars: r.promptChars,
    completionChars: r.completionChars,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    latencyMs: r.latencyMs,
    forcedOffline,
  };
}

function ollamaToRouteResult(
  r: RunOllamaResult,
  routeName: "ollama",
  forcedOffline: boolean,
): RouteResult {
  return {
    text: r.text,
    model: r.model,
    route: routeName,
    sessionId: null,
    promptChars: r.promptChars,
    completionChars: r.completionChars,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    latencyMs: r.latencyMs,
    forcedOffline,
  };
}
