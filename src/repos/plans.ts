import { db } from "../db.ts";

export interface Plan {
  id: number;
  project_id: string;
  json: string;
  approved: number;
  created_at: string;
}

export interface PlanJson {
  phases: Array<{
    name: string;
    goal: string;
    tasks: Array<{
      id: string;
      description: string;
      role: string;
      dependsOn?: string[];
      parallel?: boolean;
      pass1?: string;
      pass2?: string;
      required_tier?: "opus" | "sonnet";
    }>;
  }>;
}

const insertStmt = db.prepare(`
  INSERT INTO plans (project_id, json, approved) VALUES (@project_id, @json, 0)
`);
const getLatestStmt = db.prepare<[string], Plan>(`
  SELECT * FROM plans WHERE project_id = ? ORDER BY id DESC LIMIT 1
`);
const approveStmt = db.prepare(`UPDATE plans SET approved = 1 WHERE id = ?`);

export function savePlan(projectId: string, plan: PlanJson): number {
  const result = insertStmt.run({ project_id: projectId, json: JSON.stringify(plan) });
  return Number(result.lastInsertRowid);
}

export function latestPlan(projectId: string): Plan | undefined {
  return getLatestStmt.get(projectId);
}

export function approvePlan(planId: number): void {
  approveStmt.run(planId);
}
