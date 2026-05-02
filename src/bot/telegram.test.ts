import { describe, expect, it } from "vitest";
import { splitMessage } from "./telegram.ts";

describe("splitMessage", () => {
  it("returns the original text in a single chunk when under the limit", () => {
    const out = splitMessage("hello world");
    expect(out).toEqual(["hello world"]);
  });

  it("splits long text at line boundaries near the limit", () => {
    const line = "a".repeat(100) + "\n";
    const text = line.repeat(50); // 5050 chars, > 4096
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(4096 - 16);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("never produces an empty chunk", () => {
    const text = "x".repeat(10_000);
    const chunks = splitMessage(text);
    for (const c of chunks) expect(c.length).toBeGreaterThan(0);
  });
});
