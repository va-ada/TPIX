import { randomUUID } from "node:crypto";
import { db } from "../db.ts";

export type ProjectState =
  | "qna"
  | "awaiting_plan_generation"
  | "awaiting_plan_approval"
  | "planning_approved"
  | "in_progress"
  | "awaiting_user"
  | "awaiting_headroom"
  | "completed"
  | "cancelled";

export interface Project {
  id: string;
  slug: string;
  idea: string;
  state: ProjectState;
  model_override: string | null;
  created_at: string;
  updated_at: string;
}

const insertStmt = db.prepare(`
  INSERT INTO projects (id, slug, idea, state, model_override)
  VALUES (@id, @slug, @idea, @state, @model_override)
`);

const getStmt = db.prepare<[string], Project>(`SELECT * FROM projects WHERE id = ?`);
const getBySlugStmt = db.prepare<[string], Project>(`SELECT * FROM projects WHERE slug = ?`);
const listStmt = db.prepare<[], Project>(`SELECT * FROM projects ORDER BY created_at DESC`);
const updateStateStmt = db.prepare(`
  UPDATE projects SET state = ?, updated_at = datetime('now') WHERE id = ?
`);
const updateModelOverrideStmt = db.prepare(`
  UPDATE projects SET model_override = ?, updated_at = datetime('now') WHERE id = ?
`);

export function createProject(idea: string): Project {
  const id = randomUUID();
  const slug = uniqueSlug(slugify(idea));
  insertStmt.run({
    id,
    slug,
    idea,
    state: "qna",
    model_override: null,
  });
  const created = getStmt.get(id);
  if (!created) throw new Error("project disappeared after insert");
  return created;
}

export function getProject(id: string): Project | undefined {
  return getStmt.get(id);
}

export function getProjectBySlug(slug: string): Project | undefined {
  return getBySlugStmt.get(slug);
}

export function listProjects(): Project[] {
  return listStmt.all();
}

export function setProjectState(id: string, state: ProjectState): void {
  updateStateStmt.run(state, id);
}

export function setModelOverride(id: string, model: string | null): void {
  updateModelOverrideStmt.run(model, id);
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "project";
}

function uniqueSlug(base: string): string {
  if (!getBySlugStmt.get(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!getBySlugStmt.get(candidate)) return candidate;
  }
  throw new Error(`could not find unique slug for base "${base}"`);
}
