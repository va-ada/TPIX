/**
 * Centralised pause / stop controls.
 *
 * Three scopes:
 *   - global   ("/pause", "/resume", "/stop_all")
 *   - per-role ("/pause_role <role>", "/resume_role <role>", "/stop_role <role>")
 *   - per-task ("/pause_task <id>", "/resume_task <id>", "/stop_task <id>")
 *
 * Pause = soft (skip on next dispatch tick; in-flight tasks finish).
 * Stop  = hard (cancel pending tasks; in-flight tasks finish then result discarded).
 */

import { db } from "./db.ts";
import { logger } from "./logger.ts";
import { roles } from "./roles/registry.ts";
import { getSetting, setSetting } from "./repos/settings.ts";
import {
  getTask,
  listTasks,
  setTaskStatus,
  type Task,
  type TaskStatus,
} from "./repos/tasks.ts";
import { listProjects } from "./repos/projects.ts";

const SETTING_PAUSED = "control_dispatcher_paused";
const SETTING_PAUSED_ROLES = "control_paused_roles";

export function isDispatcherPaused(): boolean {
  return getSetting(SETTING_PAUSED) === "true";
}

export function pauseDispatcher(): void {
  setSetting(SETTING_PAUSED, "true");
  logger.warn("dispatcher paused (global)");
}

export function resumeDispatcher(): void {
  setSetting(SETTING_PAUSED, "false");
  logger.info("dispatcher resumed (global)");
}

export function pausedRoles(): Set<string> {
  const raw = getSetting(SETTING_PAUSED_ROLES);
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr.filter((s): s is string => typeof s === "string"));
  } catch {
    // fall through
  }
  return new Set();
}

export function pauseRole(roleId: string): void {
  if (!roles.has(roleId)) throw new Error(`unknown role: ${roleId}`);
  const set = pausedRoles();
  set.add(roleId);
  setSetting(SETTING_PAUSED_ROLES, JSON.stringify([...set]));
  logger.warn({ roleId }, "role paused");
}

export function resumeRole(roleId: string): void {
  const set = pausedRoles();
  set.delete(roleId);
  setSetting(SETTING_PAUSED_ROLES, JSON.stringify([...set]));
  logger.info({ roleId }, "role resumed");
}

export function pauseTask(taskId: string): Task {
  const t = getTask(taskId);
  if (!t) throw new Error(`unknown task: ${taskId}`);
  setTaskStatus(taskId, "paused");
  return { ...t, status: "paused" };
}

export function resumeTask(taskId: string): Task {
  const t = getTask(taskId);
  if (!t) throw new Error(`unknown task: ${taskId}`);
  // Resume into 'ready' so dispatcher picks it up (deps still re-checked there)
  const next: TaskStatus = t.status === "needs_rework" ? "needs_rework" : "ready";
  setTaskStatus(taskId, next);
  return { ...t, status: next };
}

export function stopTask(taskId: string): Task {
  const t = getTask(taskId);
  if (!t) throw new Error(`unknown task: ${taskId}`);
  setTaskStatus(taskId, "cancelled");
  return { ...t, status: "cancelled" };
}

const cancelPendingForRoleStmt = db.prepare(`
  UPDATE tasks SET status = 'cancelled', updated_at = datetime('now')
  WHERE role = ? AND status NOT IN ('done', 'cancelled')
`);

export function stopRole(roleId: string): number {
  if (!roles.has(roleId)) throw new Error(`unknown role: ${roleId}`);
  const result = cancelPendingForRoleStmt.run(roleId);
  logger.warn({ roleId, cancelled: result.changes }, "role stopped — pending tasks cancelled");
  return Number(result.changes ?? 0);
}

const cancelAllPendingStmt = db.prepare(`
  UPDATE tasks SET status = 'cancelled', updated_at = datetime('now')
  WHERE status NOT IN ('done', 'cancelled')
`);

export function stopAll(): { cancelled: number; projects: number } {
  const result = cancelAllPendingStmt.run();
  pauseDispatcher();
  const projects = listProjects().filter((p) => p.state !== "completed" && p.state !== "cancelled").length;
  logger.warn({ cancelled: result.changes, projects }, "STOP ALL — every pending task cancelled, dispatcher paused");
  return { cancelled: Number(result.changes ?? 0), projects };
}

/**
 * Filter that the dispatcher applies before running a task.
 * Returns the reason for skipping, or null if the task should run.
 */
export function dispatchSkipReason(task: Task): null | "global_paused" | "role_paused" | "task_paused" {
  if (isDispatcherPaused()) return "global_paused";
  if (pausedRoles().has(task.role)) return "role_paused";
  if (task.status === "paused") return "task_paused";
  return null;
}

export function controlSummary(): {
  dispatcher_paused: boolean;
  paused_roles: string[];
  paused_tasks: number;
} {
  const tasksList = db
    .prepare<[], { n: number }>("SELECT COUNT(*) as n FROM tasks WHERE status = 'paused'")
    .get();
  return {
    dispatcher_paused: isDispatcherPaused(),
    paused_roles: [...pausedRoles()].sort(),
    paused_tasks: tasksList?.n ?? 0,
  };
}

// also export for tests
export { listTasks };
