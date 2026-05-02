import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../llm/router.ts", () => ({
  route: vi.fn(),
}));

import { route } from "../llm/router.ts";
import { db } from "../db.ts";
import { createProject, getProject } from "../repos/projects.ts";
import { listMessages } from "../repos/messages.ts";
import {
  runBossTurn,
  allocateModels,
  composeEscalation,
  tickWatchdog,
  READY_TOKEN,
} from "./boss.ts";
import { getOpusHeadroom, getSonnetHeadroom } from "../cost/headroom.ts";

const mockedRoute = vi.mocked(route);

function resetState() {
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM projects").run();
  db.prepare("DELETE FROM tokens_log").run();
  mockedRoute.mockReset();
}

describe("runBossTurn", () => {
  beforeEach(resetState);

  it("appends user + boss messages and stays in qna when no ready token", async () => {
    mockedRoute.mockResolvedValue({
      text: "Two questions: who? what?",
      model: "claude-sonnet-4-6",
      route: "claude",
      sessionId: null,
      promptChars: 1,
      completionChars: 1,
      promptTokens: null,
      completionTokens: null,
      latencyMs: 0,
      forcedOffline: false,
    });

    const p = createProject("ERP for marble factory");
    // The createProject path doesn't call boss; we drive it ourselves.
    const turn = await runBossTurn({ projectId: p.id, userMessage: "I run a marble factory" });

    expect(turn.readyToPlan).toBe(false);
    expect(turn.newState).toBe("qna");
    expect(turn.reply).toContain("questions");

    const msgs = listMessages(p.id);
    expect(msgs.map((m) => m.role)).toEqual(["user", "boss"]);
    expect(getProject(p.id)?.state).toBe("qna");
  });

  it("transitions to awaiting_plan_generation when boss emits READY token", async () => {
    mockedRoute.mockResolvedValue({
      text: `All clear.\n${READY_TOKEN}`,
      model: "claude-opus-4-7",
      route: "claude",
      sessionId: null,
      promptChars: 1,
      completionChars: 1,
      promptTokens: null,
      completionTokens: null,
      latencyMs: 0,
      forcedOffline: false,
    });

    const p = createProject("habit tracker pwa");
    const turn = await runBossTurn({ projectId: p.id, userMessage: "track 3 daily habits" });

    expect(turn.readyToPlan).toBe(true);
    expect(turn.newState).toBe("awaiting_plan_generation");
    expect(getProject(p.id)?.state).toBe("awaiting_plan_generation");
  });
});

describe("allocateModels", () => {
  beforeEach(resetState);

  it("respects manual overrides verbatim", () => {
    const allocation = allocateModels({
      pendingTasks: [
        { id: "t1", role: "backend", description: "x" },
      ],
      manualOverrides: { t1: "claude-opus-4-7" },
    });
    expect(allocation.t1?.model).toBe("claude-opus-4-7");
  });

  it("downgrades opus-hint to sonnet when opus headroom is zero (start-of-week default)", () => {
    // Default Cost Controller stub: days_remaining=7 → opus_reserve=140% → opus_ceiling=0
    // and sonnet_reserve=70% → sonnet_ceiling=30%. So opus-hint roles downgrade to
    // sonnet, sonnet-hint roles stay on sonnet, ollama-hint roles stay on ollama.
    const allocation = allocateModels({
      pendingTasks: [
        { id: "t1", role: "researcher", description: "scan market" },
        { id: "t2", role: "memory-keeper", description: "summarise" },
        { id: "t3", role: "backend", description: "write api" },
      ],
    });
    expect(allocation.t1?.model).toBe("claude-sonnet-4-6");
    expect(allocation.t2?.model).toBe("llama3.2:3b");
    expect(allocation.t3?.model).toBe("claude-sonnet-4-6");
  });

  it("preserves required tier even when budget would otherwise allow downgrading", () => {
    const allocation = allocateModels({
      pendingTasks: [
        { id: "t1", role: "tester", description: "tests", required_tier: "opus" },
      ],
    });
    expect(allocation.t1?.requires).toBe("opus");
    expect(allocation.t1?.model).toBe("claude-opus-4-7");
  });
});

describe("composeEscalation", () => {
  it("renders the four-button hard-stop message with current usage", () => {
    const out = composeEscalation({
      taskId: "task-42",
      projectId: "proj-x",
      taskDescription: "secure auth review",
      requiredTier: "opus",
      opus: getOpusHeadroom(),
      sonnet: getSonnetHeadroom(),
    });
    expect(out.text).toContain("OPUS");
    expect(out.text).toContain("task-42");
    expect(out.text).toContain("secure auth review");
    expect(out.buttons.map((b) => b.action)).toEqual([
      "unblock:task-42:use_sonnet",
      "unblock:task-42:use_ollama",
      "unblock:task-42:wait",
      "unblock:task-42:cancel",
    ]);
  });
});

describe("tickWatchdog", () => {
  it("returns the current opus + sonnet headroom and reports change vs prev", () => {
    const a = tickWatchdog();
    expect(a.opus.headroom_pct).toBeGreaterThanOrEqual(0);
    expect(a.sonnet.headroom_pct).toBeGreaterThanOrEqual(0);
    const b = tickWatchdog();
    expect(b.changed).toBe(false);
  });
});
