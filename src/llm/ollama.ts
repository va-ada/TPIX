import { config } from "../config.ts";
import { logger } from "../logger.ts";

export interface RunOllamaArgs {
  prompt: string;
  model: string;
  systemPrompt?: string;
  timeoutMs?: number;
}

export interface RunOllamaResult {
  text: string;
  model: string;
  promptChars: number;
  completionChars: number;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
}

interface OllamaGenerateResponse {
  model?: string;
  response?: string;
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
  error?: string;
}

export async function runOllama(args: RunOllamaArgs): Promise<RunOllamaResult> {
  const { prompt, model, systemPrompt, timeoutMs } = args;
  const url = `${config.ollamaBaseUrl.replace(/\/$/, "")}/api/generate`;

  const body = {
    model,
    prompt,
    system: systemPrompt,
    stream: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? 10 * 60 * 1000);
  const started = Date.now();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Ollama HTTP ${response.status}: ${text}`);
    }

    const data = (await response.json()) as OllamaGenerateResponse;
    if (data.error) {
      throw new Error(`Ollama error: ${data.error}`);
    }

    const text = data.response ?? "";
    const latencyMs = Date.now() - started;

    return {
      text,
      model: data.model ?? model,
      promptChars: prompt.length,
      completionChars: text.length,
      promptTokens: data.prompt_eval_count ?? null,
      completionTokens: data.eval_count ?? null,
      latencyMs,
    };
  } catch (err) {
    logger.error({ err, model }, "ollama call failed");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
