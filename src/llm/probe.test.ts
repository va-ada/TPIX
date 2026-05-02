import { describe, expect, it, beforeEach } from "vitest";
import { isClaudeReachable, clearProbeCache } from "./probe.ts";

describe("isClaudeReachable", () => {
  beforeEach(() => {
    clearProbeCache();
  });

  it("returns a boolean within the timeout window", async () => {
    const start = Date.now();
    const result = await isClaudeReachable();
    const elapsed = Date.now() - start;
    expect(typeof result).toBe("boolean");
    expect(elapsed).toBeLessThan(2500);
  });

  it("caches the result on the second call", async () => {
    await isClaudeReachable();
    const start = Date.now();
    await isClaudeReachable();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});
