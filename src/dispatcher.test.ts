import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./llm/router.ts", () => ({
  route: vi.fn(),
}));

import { route } from "./llm/router.ts";
import { db } from "./db.ts";
import { createProject } from "./repos/projects.ts";
import { insertTask, listTasks, type TaskStatus } from "./repos/tasks.ts";
import { dispatchProject } from "./dispatcher.ts";

const mockedRoute = vi.mocked(route);

function reset() {
  db.prepare("DELETE FROM tokens_log").run();
  db.prepare("DELETE FROM agent_runs").run();
  db.prepare("DELETE FROM task_runs").run();
  db.prepare("DELETE FROM tasks").run();
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM projects").run();
  mockedRoute.mockReset();
}

function statusOf(id: string): TaskStatus {
  return db
    .prepare<[string], { status: TaskStatus }>(`SELECT status FROM tasks WHERE id = ?`)
    .get(id)!.status;
}

describe("dispatchProject", () => {
  beforeEach(reset);

  it("runs three independent ready tasks in parallel and marks them done", async () => {
    mockedRoute.mockImplementation(async () => ({
      text: "done",
      model: "claude-sonnet-4-6",
      route: "claude",
      sessionId: null,
      promptChars: 1,
      completionChars: 4,
      promptTokens: null,
      completionTokens: null,
      latencyMs: 10,
      forcedOffline: false,
    }));

    const p = createProject("test triple-parallel");
    insertTask({ id: "t1", project_id: p.id, plan_id: null, description: "a", role: "tech-writer", parallel: true });
    insertTask({ id: "t2", project_id: p.id, plan_id: null, description: "b", role: "tech-writer", parallel: true });
    insertTask({ id: "t3", project_id: p.id, plan_id: null, description: "c", role: "tech-writer", parallel: true });

    const result = await dispatchProject(p.id);
    expect(result.ranTaskIds.sort()).toEqual(["t1", "t2", "t3"]);
    expect(result.remainingPending).toBe(0);
    expect(statusOf("t1")).toBe("done");
    expect(statusOf("t2")).toBe("done");
    expect(statusOf("t3")).toBe("done");
    expect(mockedRoute).toHaveBeenCalledTimes(3);
  });

  it("respects dependencies — second task only runs after the first is done", async () => {
    mockedRoute.mockResolvedValue({
      text: "ok",
      model: "claude-sonnet-4-6",
      route: "claude",
      sessionId: null,
      promptChars: 1,
      completionChars: 2,
      promptTokens: null,
      completionTokens: null,
      latencyMs: 5,
      forcedOffline: false,
    });

    const p = createProject("seq dep test");
    insertTask({ id: "t1", project_id: p.id, plan_id: null, description: "first", role: "tech-writer" });
    insertTask({ id: "t2", project_id: p.id, plan_id: null, description: "second", role: "tech-writer", dependsOn: ["t1"] });

    const r1 = await dispatchProject(p.id);
    expect(r1.ranTaskIds).toEqual(["t1"]);
    expect(statusOf("t1")).toBe("done");
    expect(statusOf("t2")).toBe("pending");

    const r2 = await dispatchProject(p.id);
    expect(r2.ranTaskIds).toEqual(["t2"]);
    expect(statusOf("t2")).toBe("done");
  });

  it("hard-stops a task whose required_tier has zero headroom and never calls the LLM for it", async () => {
    const p = createProject("hard stop test");
    insertTask({
      id: "t1",
      project_id: p.id,
      plan_id: null,
      description: "needs opus",
      role: "ethical-hacker",
      required_tier: "opus",
    });

    const result = await dispatchProject(p.id);
    expect(result.blockedTaskIds).toEqual(["t1"]);
    expect(result.ranTaskIds).toEqual([]);
    expect(statusOf("t1")).toBe("blocked_awaiting_user");
    expect(mockedRoute).not.toHaveBeenCalled();
  });
});
