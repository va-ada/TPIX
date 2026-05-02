import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./llm/router.ts", () => ({
  route: vi.fn(),
}));

import { route } from "./llm/router.ts";
import { db } from "./db.ts";
import { createProject } from "./repos/projects.ts";
import { insertTask, listTasks } from "./repos/tasks.ts";
import { dispatchProject } from "./dispatcher.ts";
import { pickReviewers, parseReviewerOutput, runReviewers } from "./reviewers.ts";

const mockedRoute = vi.mocked(route);

function reset() {
  db.prepare("DELETE FROM tokens_log").run();
  db.prepare("DELETE FROM agent_runs").run();
  db.prepare("DELETE FROM task_runs").run();
  db.prepare("DELETE FROM tasks").run();
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM projects").run();
  db.prepare("DELETE FROM settings").run();
  db.prepare("DELETE FROM subscription_usage").run();
  mockedRoute.mockReset();
}

describe("pickReviewers", () => {
  it("picks code-reviewer + tester for engineering roles", () => {
    const r = pickReviewers(
      {
        id: "t",
        role: "backend",
        description: "write something",
      } as never,
      "some output",
    );
    expect(r).toContain("code-reviewer");
    expect(r).toContain("tester");
  });

  it("triggers ethical-hacker on auth-related output", () => {
    const r = pickReviewers(
      { id: "t", role: "frontend", description: "add login form" } as never,
      "implements password handling and JWT tokens",
    );
    expect(r).toContain("ethical-hacker");
  });

  it("triggers privacy-officer on PII-related output", () => {
    const r = pickReviewers(
      { id: "t", role: "backend", description: "store user emails" } as never,
      "saves email and address to db",
    );
    expect(r).toContain("privacy-officer");
  });

  it("triggers bias-auditor on ml-engineer task", () => {
    const r = pickReviewers(
      { id: "t", role: "ml-engineer", description: "train classifier" } as never,
      "model achieves 92% accuracy",
    );
    expect(r).toContain("bias-auditor");
  });

  it("returns empty for non-engineering, non-trigger tasks", () => {
    const r = pickReviewers(
      { id: "t", role: "tech-writer", description: "write README" } as never,
      "wrote the readme",
    );
    expect(r).toEqual([]);
  });

  it("dedupes reviewer ids", () => {
    const r = pickReviewers(
      { id: "t", role: "backend", description: "auth + email" } as never,
      "auth + email + train model",
    );
    const seen = new Set<string>();
    for (const id of r) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});

describe("parseReviewerOutput", () => {
  it("parses APPROVE", () => {
    expect(parseReviewerOutput("code-reviewer", "APPROVE — looks good").verdict).toBe("APPROVE");
  });
  it("parses REWORK with critique", () => {
    const r = parseReviewerOutput(
      "code-reviewer",
      "REWORK: missing input validation\n\nfile.ts:42 — add zod parse",
    );
    expect(r.verdict).toBe("REWORK");
    expect(r.critique).toContain("input validation");
  });
  it("defaults to APPROVE on malformed first line", () => {
    expect(parseReviewerOutput("x", "Looks fine I guess").verdict).toBe("APPROVE");
  });
});

describe("runReviewers + dispatcher integration", () => {
  beforeEach(reset);

  it("marks engineering task done when all reviewers APPROVE", async () => {
    mockedRoute.mockImplementation(async (args) => ({
      text:
        args.roleId === "backend"
          ? "I wrote the backend"
          : "APPROVE",
      model: "claude-sonnet-4-6",
      route: "claude" as const,
      sessionId: null,
      promptChars: 1,
      completionChars: 1,
      promptTokens: null,
      completionTokens: null,
      latencyMs: 1,
      forcedOffline: false,
    }));

    const p = createProject("qa pass test");
    insertTask({
      id: "t1",
      project_id: p.id,
      plan_id: null,
      description: "write the user record CRUD",
      role: "backend",
    });

    const result = await dispatchProject(p.id);
    expect(result.ranTaskIds).toEqual(["t1"]);
    expect(listTasks(p.id)[0]?.status).toBe("done");
    // 1 worker call + 2 reviewer calls (code-reviewer + tester);
    // no auth/privacy/ml/perf trigger words in the description or output
    expect(mockedRoute).toHaveBeenCalledTimes(3);
  });

  it("marks task needs_rework when any reviewer says REWORK and attempts < max", async () => {
    mockedRoute.mockImplementation(async (args) => ({
      text:
        args.roleId === "backend"
          ? "I wrote the backend"
          : args.roleId === "code-reviewer"
            ? "REWORK: missing input validation"
            : "APPROVE",
      model: "claude-sonnet-4-6",
      route: "claude" as const,
      sessionId: null,
      promptChars: 1,
      completionChars: 1,
      promptTokens: null,
      completionTokens: null,
      latencyMs: 1,
      forcedOffline: false,
    }));

    const p = createProject("rework loop test");
    insertTask({
      id: "t1",
      project_id: p.id,
      plan_id: null,
      description: "write thing",
      role: "backend",
    });

    await dispatchProject(p.id);
    expect(listTasks(p.id)[0]?.status).toBe("needs_rework");
  });

  it("escalates to blocked_awaiting_user after 3 failed attempts", async () => {
    mockedRoute.mockImplementation(async (args) => ({
      text:
        args.roleId === "backend"
          ? "wrote it"
          : args.roleId === "code-reviewer"
            ? "REWORK: still bad"
            : "APPROVE",
      model: "claude-sonnet-4-6",
      route: "claude" as const,
      sessionId: null,
      promptChars: 1,
      completionChars: 1,
      promptTokens: null,
      completionTokens: null,
      latencyMs: 1,
      forcedOffline: false,
    }));

    const p = createProject("max attempts test");
    insertTask({
      id: "t1",
      project_id: p.id,
      plan_id: null,
      description: "write thing",
      role: "backend",
    });

    await dispatchProject(p.id); // attempt 1 → rework
    await dispatchProject(p.id); // attempt 2 → rework
    await dispatchProject(p.id); // attempt 3 → escalate
    expect(listTasks(p.id)[0]?.status).toBe("blocked_awaiting_user");
  });
});

describe("runReviewers", () => {
  beforeEach(reset);
  it("returns approved=true with no LLM calls when no reviewers triggered", async () => {
    const out = await runReviewers({
      task: { id: "t", role: "tech-writer", description: "x" } as never,
      output: "wrote the readme",
      projectId: "p1",
    });
    expect(out.approved).toBe(true);
    expect(out.results).toEqual([]);
    expect(mockedRoute).not.toHaveBeenCalled();
  });
});
