import { logger } from "./logger.ts";
import { roles } from "./roles/registry.ts";
import { route } from "./llm/router.ts";
import type { Task } from "./repos/tasks.ts";

const ENGINEERING_ROLES = new Set([
  "backend",
  "frontend",
  "mobile",
  "devops",
  "data-engineer",
  "ml-engineer",
]);

const AUTH_TERMS = /\b(auth|authentication|login|password|token|jwt|session|api[\s-]?key|oauth|cookie|csrf|sql\s*injection|xss)\b/i;
const PRIVACY_TERMS = /\b(pii|email|address|phone|ssn|sensitive|personal|gdpr|consent|tracking|cookie)\b/i;
const ML_TERMS = /\b(model|train(ing)?|dataset|bias|fairness|inference|classifier|regression|embedding|prediction|protected\s*attribute)\b/i;
const PERF_TERMS = /\b(performance|latency|p95|p99|throughput|scale|load|benchmark|profil(e|ing))\b/i;

export const MAX_TASK_ATTEMPTS = 3;

export type ReviewerVerdict = "APPROVE" | "REWORK";

export interface ReviewResult {
  reviewerId: string;
  verdict: ReviewerVerdict;
  critique: string | null;
  text: string;
}

export interface ReviewBatch {
  approved: boolean;
  results: ReviewResult[];
  combinedCritique: string;
}

export function pickReviewers(task: Task, output: string): string[] {
  const haystack = `${task.description}\n${output}`;
  const reviewers: string[] = [];

  if (ENGINEERING_ROLES.has(task.role)) {
    reviewers.push("code-reviewer", "tester");
  }
  if (AUTH_TERMS.test(haystack)) reviewers.push("ethical-hacker");
  if (PRIVACY_TERMS.test(haystack)) reviewers.push("privacy-officer");
  if (ML_TERMS.test(haystack) || task.role === "ml-engineer") reviewers.push("bias-auditor");
  if (PERF_TERMS.test(haystack)) reviewers.push("perf-engineer");

  // Dedupe while preserving order
  return Array.from(new Set(reviewers));
}

export async function runReviewers(args: {
  task: Task;
  output: string;
  projectId: string;
}): Promise<ReviewBatch> {
  const { task, output, projectId } = args;
  const reviewerIds = pickReviewers(task, output);
  if (reviewerIds.length === 0) {
    return { approved: true, results: [], combinedCritique: "" };
  }

  const runs = reviewerIds.map((id) => runOneReview(id, task, output, projectId));
  const results = await Promise.all(runs);
  const failed = results.filter((r) => r.verdict === "REWORK");
  const approved = failed.length === 0;
  const combinedCritique = failed
    .map((r) => `(${r.reviewerId}) ${r.critique ?? r.text.slice(0, 400)}`)
    .join("\n\n");

  logger.info(
    { taskId: task.id, reviewers: reviewerIds, approved, failed: failed.length },
    "review batch complete",
  );

  return { approved, results, combinedCritique };
}

async function runOneReview(
  reviewerId: string,
  task: Task,
  output: string,
  projectId: string,
): Promise<ReviewResult> {
  const role = roles.get(reviewerId);
  const prompt = buildReviewerPrompt(reviewerId, task, output);

  // Reviewers default to sonnet (or their offline model when Anthropic is down).
  // Phase 4's allocator currently doesn't see reviewer subtasks; keep them on
  // sonnet for now. Phase 10 may revisit.
  const model = "claude-sonnet-4-6";

  const result = await route({
    roleId: reviewerId,
    projectId,
    prompt,
    model,
    systemPrompt: role.system_prompt,
    offlineFallbackModel: role.offline_model,
    allocatedBy: "boss",
  });

  return parseReviewerOutput(reviewerId, result.text);
}

function buildReviewerPrompt(reviewerId: string, task: Task, output: string): string {
  return [
    `# Review request — you are the ${reviewerId} role.`,
    ``,
    `## Task being reviewed`,
    `id: ${task.id}`,
    `role: ${task.role}`,
    `description: ${task.description}`,
    task.pass1 ? `pass1 (synthetic test): ${task.pass1}` : "",
    task.pass2 ? `pass2 (real-world test): ${task.pass2}` : "",
    ``,
    `## Worker's output`,
    output,
    ``,
    `## Your verdict`,
    `Reply on the FIRST line with exactly one of:`,
    `  APPROVE`,
    `  REWORK: <one-line summary of what must change>`,
    ``,
    `Then on subsequent lines provide specific findings (file:line + change).`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function parseReviewerOutput(reviewerId: string, text: string): ReviewResult {
  const trimmed = text.trim();
  const firstLine = trimmed.split(/\r?\n/, 1)[0]!.trim();
  if (/^APPROVE\b/i.test(firstLine)) {
    return { reviewerId, verdict: "APPROVE", critique: null, text };
  }
  const reworkMatch = firstLine.match(/^REWORK\s*[:\-]\s*(.+)$/i);
  if (reworkMatch) {
    return { reviewerId, verdict: "REWORK", critique: reworkMatch[1]!.trim(), text };
  }
  // Default to APPROVE if the reviewer didn't follow format — but log it.
  logger.warn({ reviewerId, firstLine }, "reviewer did not emit APPROVE/REWORK; defaulting to APPROVE");
  return { reviewerId, verdict: "APPROVE", critique: null, text };
}
