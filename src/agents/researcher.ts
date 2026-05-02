import { z } from "zod";
import { logger } from "../logger.ts";
import { route } from "../llm/router.ts";
import { roles } from "../roles/registry.ts";
import { isClaudeReachable } from "../llm/probe.ts";
import { getProject } from "../repos/projects.ts";
import { listMessages, appendMessage } from "../repos/messages.ts";
import { getOpusHeadroom } from "../cost/headroom.ts";

const SimilarProductSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  inferred_stack: z.array(z.string()),
  notable_features: z.array(z.string()),
});

export const ResearchResultSchema = z.object({
  similar_products: z.array(SimilarProductSchema),
  recommended_stack: z.array(z.string()),
  rationale: z.string().min(1),
  no_offline_market_scan: z.boolean().optional(),
});

export type ResearchResult = z.infer<typeof ResearchResultSchema>;

const RESEARCH_INSTRUCTIONS = `
You are TPIX's Researcher. Use the WebSearch and WebFetch tools to find similar
products in the market for the user's idea. Then propose a tech stack to copy
or improve.

Output ONLY a JSON object matching this schema (no prose, no markdown):
{
  "similar_products": [
    {
      "name": "<product name>",
      "url": "<verifiable URL>",
      "inferred_stack": ["<lang>", "<framework>", "<db>", ...],
      "notable_features": ["<feature>", ...]
    }
  ],
  "recommended_stack": ["<lang>", "<framework>", "<db>", ...],
  "rationale": "<one paragraph: why this stack, citing the products above>"
}

Hard rules:
- Cite every URL. Refuse to fabricate. If you cannot verify a fact, exclude it.
- Use only reputable sources (official sites, GitHub repos, technical blogs
  with named authors, industry reports).
- If no similar products are found after a real search, return an empty
  similar_products array with rationale "no comparable product found; ask user".
`.trim();

const OFFLINE_RESULT: ResearchResult = {
  similar_products: [],
  recommended_stack: [],
  rationale: "no offline market scan possible — Anthropic unreachable; ask user for stack",
  no_offline_market_scan: true,
};

export async function runResearch(args: {
  projectId: string;
  query?: string;
}): Promise<ResearchResult> {
  const { projectId, query } = args;
  const project = getProject(projectId);
  if (!project) throw new Error(`unknown project: ${projectId}`);

  // Skip when offline — web search requires Claude
  const reachable = await isClaudeReachable();
  if (!reachable) {
    appendMessage({
      project_id: projectId,
      role: "system",
      author: "researcher",
      content: JSON.stringify(OFFLINE_RESULT, null, 2),
    });
    return OFFLINE_RESULT;
  }

  const role = roles.get("researcher");
  const messages = listMessages(projectId);

  const briefLines = [
    `# User idea`,
    project.idea,
    ``,
    `# Conversation context`,
    ...messages.map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 600)}`),
    ``,
    query ? `# Specific research request\n${query}\n` : "",
    `# Your task`,
    RESEARCH_INSTRUCTIONS,
  ]
    .filter(Boolean)
    .join("\n");

  const opus = getOpusHeadroom();
  const model = opus.headroom_pct >= 1 ? "claude-opus-4-7" : "claude-sonnet-4-6";

  const result = await route({
    roleId: "researcher",
    projectId,
    prompt: briefLines,
    model,
    systemPrompt: role.system_prompt,
    allowedTools: ["WebSearch", "WebFetch"],
    offlineFallbackModel: role.offline_model,
    allocatedBy: "boss",
  });

  const parsed = parseResearchResult(result.text);

  appendMessage({
    project_id: projectId,
    role: "system",
    author: "researcher",
    content: JSON.stringify(parsed, null, 2),
  });

  logger.info(
    {
      projectId,
      products: parsed.similar_products.length,
      stack: parsed.recommended_stack,
      model,
    },
    "research complete",
  );

  return parsed;
}

export function parseResearchResult(text: string): ResearchResult {
  const trimmed = stripFence(text).trim();
  let candidate: unknown;
  try {
    candidate = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      candidate = JSON.parse(trimmed.slice(start, end + 1));
    } else {
      throw new Error("researcher output was not valid JSON");
    }
  }
  const validated = ResearchResultSchema.safeParse(candidate);
  if (!validated.success) {
    throw new Error(
      `researcher JSON failed schema: ${JSON.stringify(validated.error.format())}`,
    );
  }
  return validated.data;
}

function stripFence(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return fenceMatch?.[1] ?? text;
}
