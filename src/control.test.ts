import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./llm/router.ts", () => ({
  route: vi.fn(),
}));

import { route } from "./llm/router.ts";
import { db } from "./db.ts";
import { createProject } from "./repos/projects.ts";
import { insertTask, listTasks, getTask } from "./repos/tasks.ts";
import {
  pauseDispatcher,
  resumeDispatcher,
  isDispatcherPaused,
  pauseRole,
  resumeRole,
  pausedRoles,
  pauseTask,
  resumeTask,
  stopTask,
  stopRole,
  stopAll,
  controlSummary,
} from "./control.ts";
import { dispatchProject } from "./dispatcher.ts";

const mockedRoute = vi.mocked(route);

function reset() {
  db.prepare("DELETE FROM tokens_log").run();
  db.prepare("DELETE FROM agent_runs").run();
  db.prepare("DELETE FROM task_runs").run();
  db.prepare("DELETE FROM tasks").run();
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM projects").run();
  db.prepare("DELETE FROM settings").run();
  mockedRoute.mockReset();
}

describe("control flags", () => {
  beforeEach(reset);

  it("pause/resume dispatcher round-trip", () => {
    expect(isDispatcherPaused()).toBe(false);
    pauseDispatcher();
    expect(isDispatcherPaused()).toBe(true);
    resumeDispatcher();
    expect(isDispatcherPaused()).toBe(false);
  });

  it("pause/resume role round-trip", () => {
    pauseRole("backend");
    expect(pausedRoles().has("backend")).toBe(true);
    resumeRole("backend");
    expect(pausedRoles().has("backend")).toBe(false);
  });

  it("controlSummary aggregates state", () => {
    pauseDispatcher();
    pauseRole("frontend");
    pauseRole("tester");
    const s = controlSummary();
    expect(s.dispatcher_paused).toBe(true);
    expect(s.paused_roles).toEqual(["frontend", "tester"]);
  });
});

describe("dispatcher honours control flags", () => {
  beforeEach(reset);

  function happyMock() {
    mockedRoute.mockImplementation(async () => ({
      text: "done",
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
  }

  it("global pause stops new dispatches", async () => {
    happyMock();
    const p = createProject("global pause");
    insertTask({ id: "t1", project_id: p.id, plan_id: null, description: "x", role: "tech-writer" });
    pauseDispatcher();
    const r = await dispatchProject(p.id);
    expect(r.ranTaskIds).toEqual([]);
    expect(mockedRoute).not.toHaveBeenCalled();
    expect(getTask("t1")?.status).toBe("pending");
  });

  it("paused role's tasks are skipped while other roles run", async () => {
    happyMock();
    const p = createProject("role pause");
    insertTask({ id: "t1", project_id: p.id, plan_id: null, description: "x", role: "tech-writer" });
    insertTask({ id: "t2", project_id: p.id, plan_id: null, description: "y", role: "release-manager" });
    pauseRole("tech-writer");
    const r = await dispatchProject(p.id);
    expect(r.ranTaskIds).toEqual(["t2"]);
    expect(getTask("t1")?.status).toBe("pending");
    expect(getTask("t2")?.status).toBe("done");
  });

  it("paused task is skipped; resume returns it to ready", async () => {
    happyMock();
    const p = createProject("task pause");
    insertTask({ id: "t1", project_id: p.id, plan_id: null, description: "x", role: "tech-writer" });
    pauseTask("t1");
    const r1 = await dispatchProject(p.id);
    expect(r1.ranTaskIds).toEqual([]);
    resumeTask("t1");
    const r2 = await dispatchProject(p.id);
    expect(r2.ranTaskIds).toEqual(["t1"]);
  });

  it("stopTask cancels", () => {
    const p = createProject("task stop");
    insertTask({ id: "t1", project_id: p.id, plan_id: null, description: "x", role: "tech-writer" });
    stopTask("t1");
    expect(getTask("t1")?.status).toBe("cancelled");
  });

  it("stopRole cancels every pending task for that role only", () => {
    const p = createProject("role stop");
    insertTask({ id: "t1", project_id: p.id, plan_id: null, description: "x", role: "tech-writer" });
    insertTask({ id: "t2", project_id: p.id, plan_id: null, description: "y", role: "tech-writer" });
    insertTask({ id: "t3", project_id: p.id, plan_id: null, description: "z", role: "release-manager" });
    const cancelled = stopRole("tech-writer");
    expect(cancelled).toBe(2);
    expect(getTask("t1")?.status).toBe("cancelled");
    expect(getTask("t2")?.status).toBe("cancelled");
    expect(getTask("t3")?.status).toBe("pending");
  });

  it("stopAll cancels everything pending and pauses dispatcher", () => {
    const p = createProject("stop all");
    insertTask({ id: "t1", project_id: p.id, plan_id: null, description: "x", role: "tech-writer" });
    insertTask({ id: "t2", project_id: p.id, plan_id: null, description: "y", role: "release-manager" });
    const r = stopAll();
    expect(r.cancelled).toBe(2);
    expect(isDispatcherPaused()).toBe(true);
    expect(listTasks(p.id).every((t) => t.status === "cancelled")).toBe(true);
  });
});
