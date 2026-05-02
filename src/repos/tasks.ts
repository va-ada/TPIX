import { db } from "../db.ts";

export type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "needs_rework"
  | "blocked_awaiting_user"
  | "awaiting_headroom"
  | "done"
  | "cancelled";

export interface Task {
  id: string;
  project_id: string;
  plan_id: number | null;
  description: string;
  role: string;
  depends_on: string;
  parallel: number;
  pass1: string | null;
  pass2: string | null;
  status: TaskStatus;
  required_tier: "opus" | "sonnet" | null;
  created_at: string;
  updated_at: string;
}

const insertStmt = db.prepare(`
  INSERT INTO tasks (id, project_id, plan_id, description, role, depends_on, parallel, pass1, pass2, status, required_tier)
  VALUES (@id, @project_id, @plan_id, @description, @role, @depends_on, @parallel, @pass1, @pass2, @status, @required_tier)
`);

const listForProjectStmt = db.prepare<[string], Task>(`
  SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC
`);

const setStatusStmt = db.prepare(`
  UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?
`);

const getStmt = db.prepare<[string], Task>(`SELECT * FROM tasks WHERE id = ?`);

export interface NewTask {
  id: string;
  project_id: string;
  plan_id: number | null;
  description: string;
  role: string;
  dependsOn?: string[];
  parallel?: boolean;
  pass1?: string;
  pass2?: string;
  required_tier?: "opus" | "sonnet";
}

export function insertTask(t: NewTask): void {
  insertStmt.run({
    id: t.id,
    project_id: t.project_id,
    plan_id: t.plan_id,
    description: t.description,
    role: t.role,
    depends_on: JSON.stringify(t.dependsOn ?? []),
    parallel: t.parallel ? 1 : 0,
    pass1: t.pass1 ?? null,
    pass2: t.pass2 ?? null,
    status: "pending",
    required_tier: t.required_tier ?? null,
  });
}

export function listTasks(projectId: string): Task[] {
  return listForProjectStmt.all(projectId);
}

export function getTask(id: string): Task | undefined {
  return getStmt.get(id);
}

export function setTaskStatus(id: string, status: TaskStatus): void {
  setStatusStmt.run(status, id);
}

export function dependsOn(t: Task): string[] {
  try {
    return JSON.parse(t.depends_on) as string[];
  } catch {
    return [];
  }
}

export function readyTasks(projectId: string): Task[] {
  const all = listTasks(projectId);
  const doneIds = new Set(all.filter((t) => t.status === "done").map((t) => t.id));
  return all.filter(
    (t) =>
      (t.status === "pending" || t.status === "ready" || t.status === "needs_rework") &&
      dependsOn(t).every((d) => doneIds.has(d)),
  );
}
