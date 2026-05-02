import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";
import { runOllama } from "./ollama.ts";

const realFetch = global.fetch;

describe("runOllama", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it("calls /api/generate and returns parsed text + token counts", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "llama3.2:3b",
          response: "hi back",
          done: true,
          prompt_eval_count: 4,
          eval_count: 2,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await runOllama({ prompt: "hi", model: "llama3.2:3b" });

    expect(result.text).toBe("hi back");
    expect(result.model).toBe("llama3.2:3b");
    expect(result.promptTokens).toBe(4);
    expect(result.completionTokens).toBe(2);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0]!;
    const url = call[0] as string | URL;
    const init = call[1] as RequestInit;
    expect(String(url)).toContain("/api/generate");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "llama3.2:3b", prompt: "hi", stream: false });
  });

  it("throws on non-OK responses", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(runOllama({ prompt: "x", model: "llama3.2:3b" })).rejects.toThrow(/Ollama HTTP 500/);
  });
});
