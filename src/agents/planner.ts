import { z } from "zod";
import { logger } from "../logger.ts";
import { route } from "../llm/router.ts";
import { listMessages } from "../repos/messages.ts";
import { getProject, setProjectState } from "../repos/projects.ts";
import { savePlan, type PlanJson } from "../repos/plans.ts";
import { insertTask } from "../repos/tasks.ts";
import { roles } from "../roles/registry.ts";
import { getOpusHeadroom } from "../cost/headroom.ts";

const TaskShape = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  role: z.string().min(1),
  dependsOn: z.array(z.string()).optional(),
  parallel: z.boolean().optional(),
  pass1: z.string().optional(),
  pass2: z.string().optional(),
  required_tier: z.enum(["opus", "sonnet"]).optional(),
});

const PlanShape = z.object({
  phases: z.array(
    z.object({
      name: z.string().min(1),
      goal: z.string().min(1),
      tasks: z.array(TaskShape).min(1),
    }),
  ).min(1),
});

const PLANNER_INSTRUCTIONS = `
You are TPIX's Planner. Read the conversation history and produce a JSON plan
that follows CLAUDE.md format.

Output ONLY valid JSON matching this shape (no prose, no markdown fences):
{
  "phases": [
    {
      "name": "Phase 1 — <name>",
      "goal": "<one sentence>",
      "tasks": [
        {
          "id": "p1.t1",
          "description": "<atomic, one outcome>",
          "role": "<role-id from /roles>",
          "dependsOn": [],
          "parallel": true,
          "pass1": "<synthetic test>",
          "pass2": "<real-world test>",
          "required_tier": "opus"
        }
      ]
    }
  ]
}

Rules:
- Every task is atomic (one outcome).
- Every task names a real role id from the registry.
- Use \`required_tier\` only when a task can ONLY be done well by that tier.
- \`parallel: true\` means independent of siblings; \`dependsOn\` lists task ids.
- Phases run in order.
`.trim();

export async function generatePlan(projectId: string): Promise<PlanJson> {
  const project = getProject(projectId);
  if (!project) throw new Error(`unknown project: ${projectId}`);

  const history = listMessages(projectId);
  const lines: string[] = [];
  lines.push(`# Conversation`);
  for (const m of history) {
    lines.push(`${m.role.toUpperCase()}: ${m.content}`);
  }
  lines.push("");
  lines.push(`# Available role ids`);
  lines.push(roles.all().map((r) => r.id).join(", "));
  lines.push("");
  lines.push(PLANNER_INSTRUCTIONS);

  const opus = getOpusHeadroom();
  const plannerModel = opus.headroom_pct >= 1 ? "claude-opus-4-7" : "claude-sonnet-4-6";

  const result = await route({
    roleId: "boss",
    projectId,
    prompt: lines.join("\n"),
    model: plannerModel,
    offlineFallbackModel: roles.get("boss").offline_model,
    allocatedBy: "boss",
  });

  const parsed = parsePlanText(result.text);
  const planId = savePlan(projectId, parsed);

  // Explode tasks into rows
  for (const phase of parsed.phases) {
    for (const task of phase.tasks) {
      insertTask({
        id: task.id,
        project_id: projectId,
        plan_id: planId,
        description: task.description,
        role: task.role,
        ...(task.dependsOn !== undefined ? { dependsOn: task.dependsOn } : {}),
        ...(task.parallel !== undefined ? { parallel: task.parallel } : {}),
        ...(task.pass1 !== undefined ? { pass1: task.pass1 } : {}),
        ...(task.pass2 !== undefined ? { pass2: task.pass2 } : {}),
        ...(task.required_tier !== undefined ? { required_tier: task.required_tier } : {}),
      });
    }
  }

  setProjectState(projectId, "awaiting_plan_approval");
  logger.info({ projectId, phases: parsed.phases.length }, "plan generated");
  return parsed;
}

export function parsePlanText(text: string): PlanJson {
  const trimmed = stripMarkdownFence(text).trim();
  let candidate: unknown;
  try {
    candidate = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      candidate = JSON.parse(trimmed.slice(start, end + 1));
    } else {
      throw new Error("planner output was not valid JSON");
    }
  }
  const validated = PlanShape.safeParse(candidate);
  if (!validated.success) {
    throw new Error(`planner JSON failed schema: ${JSON.stringify(validated.error.format())}`);
  }
  for (const phase of validated.data.phases) {
    for (const task of phase.tasks) {
      if (!roles.has(task.role)) {
        throw new Error(`planner referenced unknown role: ${task.role} (task ${task.id})`);
      }
    }
  }
  return validated.data;
}

function stripMarkdownFence(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return fenceMatch?.[1] ?? text;
}
