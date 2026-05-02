import { execa } from "execa";
import { config } from "../config.ts";
import { logger } from "../logger.ts";

export interface RunClaudeArgs {
  prompt: string;
  model: string;
  sessionId?: string;
  cwd?: string;
  allowedTools?: string[];
  systemPrompt?: string;
  timeoutMs?: number;
  /**
   * "bypassPermissions" lets Claude run all of its allowed tools without an
   * interactive permission prompt — required for unattended TPIX workers.
   * Default "default" (interactive). Pass "bypassPermissions" for workers.
   */
  permissionMode?: "default" | "acceptEdits" | "auto" | "bypassPermissions" | "dontAsk" | "plan";
}

export interface RunClaudeResult {
  text: string;
  sessionId: string | null;
  model: string;
  promptChars: number;
  completionChars: number;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
  raw: unknown;
}

interface ClaudeJsonOutput {
  type?: string;
  result?: string;
  session_id?: string;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
  is_error?: boolean;
}

export async function runClaude(args: RunClaudeArgs): Promise<RunClaudeResult> {
  const { prompt, model, sessionId, cwd, allowedTools, systemPrompt, timeoutMs, permissionMode } = args;

  const cliArgs: string[] = ["-p", "--model", model, "--output-format", "json"];
  if (sessionId) cliArgs.push("--resume", sessionId);
  if (allowedTools && allowedTools.length > 0) {
    cliArgs.push("--allowedTools", allowedTools.join(" "));
  }
  if (permissionMode) cliArgs.push("--permission-mode", permissionMode);
  if (systemPrompt) cliArgs.push("--append-system-prompt", systemPrompt);

  const started = Date.now();
  let stdout = "";
  let stderr = "";
  try {
    const result = await execa(config.claudeCommand, cliArgs, {
      input: prompt,
      ...(cwd !== undefined ? { cwd } : {}),
      timeout: timeoutMs ?? 10 * 60 * 1000,
      reject: true,
      stripFinalNewline: false,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    logger.error({ stderr: e.stderr, message: e.message }, "claude -p invocation failed");
    throw err;
  }

  if (stderr.trim().length > 0) {
    logger.debug({ stderr }, "claude -p stderr");
  }

  const parsed = parseClaudeJson(stdout);
  const text = parsed.result ?? "";
  const latencyMs = Date.now() - started;

  return {
    text,
    sessionId: parsed.session_id ?? sessionId ?? null,
    model: parsed.model ?? model,
    promptChars: prompt.length,
    completionChars: text.length,
    promptTokens: parsed.usage?.input_tokens ?? null,
    completionTokens: parsed.usage?.output_tokens ?? null,
    latencyMs,
    raw: parsed,
  };
}

export function parseClaudeJson(stdout: string): ClaudeJsonOutput {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed) as ClaudeJsonOutput;
  } catch {
    const lastBrace = trimmed.lastIndexOf("{");
    if (lastBrace >= 0) {
      const tail = trimmed.slice(lastBrace);
      try {
        return JSON.parse(tail) as ClaudeJsonOutput;
      } catch {
        // fall through
      }
    }
    return { result: trimmed };
  }
}
