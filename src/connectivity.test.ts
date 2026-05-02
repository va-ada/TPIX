import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./llm/probe.ts", () => ({
  isClaudeReachable: vi.fn(),
  clearProbeCache: vi.fn(),
}));

vi.mock("./bot/telegram.ts", () => ({
  sendToUser: vi.fn(),
  isBotConfigured: vi.fn().mockReturnValue(false),
}));

import { isClaudeReachable } from "./llm/probe.ts";
import { tickConnectivity, _resetForTests } from "./connectivity.ts";

const mockedReachable = vi.mocked(isClaudeReachable);

describe("tickConnectivity", () => {
  beforeEach(() => {
    _resetForTests();
    mockedReachable.mockReset();
  });

  it("first tick records initial state with changed=false", async () => {
    mockedReachable.mockResolvedValue(true);
    const r = await tickConnectivity();
    expect(r.reachable).toBe(true);
    expect(r.changed).toBe(false);
  });

  it("flips changed=true when state transitions", async () => {
    mockedReachable.mockResolvedValueOnce(true);
    await tickConnectivity();
    mockedReachable.mockResolvedValueOnce(false);
    const r = await tickConnectivity();
    expect(r.reachable).toBe(false);
    expect(r.changed).toBe(true);
  });

  it("changed=false on stable consecutive ticks", async () => {
    mockedReachable.mockResolvedValue(true);
    await tickConnectivity();
    const r = await tickConnectivity();
    expect(r.changed).toBe(false);
  });
});
