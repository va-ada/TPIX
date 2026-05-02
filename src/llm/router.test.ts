import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./probe.ts", () => ({
  isClaudeReachable: vi.fn(),
  clearProbeCache: vi.fn(),
}));
vi.mock("./claude.ts", () => ({
  runClaude: vi.fn(),
}));
vi.mock("./ollama.ts", () => ({
  runOllama: vi.fn(),
}));

import { isClaudeReachable } from "./probe.ts";
import { runClaude } from "./claude.ts";
import { runOllama } from "./ollama.ts";
import { route } from "./router.ts";
import { db } from "../db.ts";

const reachable = vi.mocked(isClaudeReachable);
const claude = vi.mocked(runClaude);
const ollama = vi.mocked(runOllama);

function lastTokenLog() {
  return db
    .prepare<[], {
      role_id: string;
      project_id: string | null;
      route: string;
      model: string;
      prompt_chars: number;
      completion_chars: number;
      allocated_by: string;
    }>(`SELECT role_id, project_id, route, model, prompt_chars, completion_chars, allocated_by
        FROM tokens_log ORDER BY id DESC LIMIT 1`)
    .get();
}

describe("router.route", () => {
  beforeEach(() => {
    reachable.mockReset();
    claude.mockReset();
    ollama.mockReset();
    db.prepare("DELETE FROM tokens_log").run();
  });

  it("routes a claude- model to Claude when reachable and logs the call", async () => {
    reachable.mockResolvedValue(true);
    claude.mockResolvedValue({
      text: "hi from claude",
      sessionId: "s1",
      model: "claude-sonnet-4-6",
      promptChars: 5,
      completionChars: 14,
      promptTokens: 3,
      completionTokens: 4,
      latencyMs: 100,
      raw: {},
    });

    const result = await route({
      roleId: "boss",
      projectId: "p1",
      prompt: "hello",
      model: "claude-sonnet-4-6",
    });

    expect(result.route).toBe("claude");
    expect(result.text).toBe("hi from claude");
    expect(claude).toHaveBeenCalledOnce();
    expect(ollama).not.toHaveBeenCalled();

    const log = lastTokenLog();
    expect(log).toMatchObject({
      role_id: "boss",
      project_id: "p1",
      route: "claude",
      model: "claude-sonnet-4-6",
      allocated_by: "boss",
    });
  });

  it("falls back to Ollama when claude- model requested but Anthropic unreachable", async () => {
    reachable.mockResolvedValue(false);
    ollama.mockResolvedValue({
      text: "hi from ollama",
      model: "llama3.2:3b",
      promptChars: 5,
      completionChars: 14,
      promptTokens: 3,
      completionTokens: 5,
      latencyMs: 200,
    });

    const result = await route({
      roleId: "boss",
      projectId: "p2",
      prompt: "hello",
      model: "claude-sonnet-4-6",
      offlineFallbackModel: "llama3.2:3b",
    });

    expect(result.route).toBe("ollama");
    expect(result.forcedOffline).toBe(true);
    expect(claude).not.toHaveBeenCalled();
    expect(ollama).toHaveBeenCalledOnce();

    const log = lastTokenLog();
    expect(log?.allocated_by).toBe("forced_offline");
    expect(log?.route).toBe("ollama");
  });

  it("throws when claude unreachable and no fallback supplied", async () => {
    reachable.mockResolvedValue(false);
    await expect(
      route({ roleId: "boss", prompt: "x", model: "claude-opus-4-7" }),
    ).rejects.toThrow(/no offlineFallbackModel/);
  });

  it("routes an Ollama tag directly to Ollama", async () => {
    ollama.mockResolvedValue({
      text: "ollama direct",
      model: "qwen2.5-coder:7b",
      promptChars: 1,
      completionChars: 13,
      promptTokens: 1,
      completionTokens: 3,
      latencyMs: 50,
    });

    const result = await route({
      roleId: "tester",
      prompt: "x",
      model: "qwen2.5-coder:7b",
    });

    expect(result.route).toBe("ollama");
    expect(result.forcedOffline).toBe(false);
    expect(reachable).not.toHaveBeenCalled();
    expect(claude).not.toHaveBeenCalled();
    expect(ollama).toHaveBeenCalledOnce();
  });
});
