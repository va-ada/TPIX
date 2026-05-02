import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";
import { runClaude, parseClaudeJson } from "./claude.ts";

const mockedExeca = vi.mocked(execa);

type ExecaCallArgs = [string, string[], { input?: string; cwd?: string; timeout?: number }];

describe("parseClaudeJson", () => {
  it("parses a clean JSON envelope", () => {
    const out = JSON.stringify({
      type: "result",
      result: "hello",
      session_id: "abc",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10, output_tokens: 3 },
    });
    const parsed = parseClaudeJson(out);
    expect(parsed.result).toBe("hello");
    expect(parsed.session_id).toBe("abc");
    expect(parsed.usage?.input_tokens).toBe(10);
  });

  it("falls back to raw text when not JSON", () => {
    const parsed = parseClaudeJson("just plain text");
    expect(parsed.result).toBe("just plain text");
  });
});

describe("runClaude", () => {
  beforeEach(() => {
    mockedExeca.mockReset();
  });

  it("invokes claude -p with the supplied model and parses the JSON output", async () => {
    mockedExeca.mockResolvedValue({
      stdout: JSON.stringify({
        result: "OK",
        session_id: "sess-1",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
      stderr: "",
    } as never);

    const result = await runClaude({ prompt: "say OK", model: "claude-sonnet-4-6" });

    expect(result.text).toBe("OK");
    expect(result.sessionId).toBe("sess-1");
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.promptTokens).toBe(5);
    expect(result.completionTokens).toBe(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    expect(mockedExeca).toHaveBeenCalledOnce();
    const call = mockedExeca.mock.calls[0] as unknown as ExecaCallArgs;
    expect(call[0]).toBe("claude");
    expect(call[1]).toEqual(["-p", "--model", "claude-sonnet-4-6", "--output-format", "json"]);
    expect(call[2].input).toBe("say OK");
  });

  it("propagates session resume when sessionId is supplied", async () => {
    mockedExeca.mockResolvedValue({
      stdout: JSON.stringify({ result: "ok", session_id: "sess-2" }),
      stderr: "",
    } as never);

    await runClaude({ prompt: "next", model: "claude-opus-4-7", sessionId: "sess-2" });

    const call = mockedExeca.mock.calls[0] as unknown as ExecaCallArgs;
    expect(call[1]).toContain("--resume");
    expect(call[1]).toContain("sess-2");
  });
});
