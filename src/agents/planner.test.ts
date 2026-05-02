import { describe, expect, it } from "vitest";
import { parsePlanText } from "./planner.ts";

const validPlan = {
  phases: [
    {
      name: "Phase 1 — Bootstrap",
      goal: "Set up the project skeleton",
      tasks: [
        { id: "p1.t1", description: "init repo", role: "devops", dependsOn: [], parallel: true },
        { id: "p1.t2", description: "first README", role: "tech-writer", dependsOn: [], parallel: true },
      ],
    },
    {
      name: "Phase 2 — First feature",
      goal: "Stand up the first endpoint",
      tasks: [
        { id: "p2.t1", description: "auth route", role: "backend", dependsOn: ["p1.t1"], required_tier: "opus" },
      ],
    },
  ],
};

describe("parsePlanText", () => {
  it("parses a clean JSON object", () => {
    const parsed = parsePlanText(JSON.stringify(validPlan));
    expect(parsed.phases).toHaveLength(2);
    expect(parsed.phases[1]?.tasks[0]?.required_tier).toBe("opus");
  });

  it("strips a markdown json fence", () => {
    const wrapped = "```json\n" + JSON.stringify(validPlan) + "\n```";
    const parsed = parsePlanText(wrapped);
    expect(parsed.phases).toHaveLength(2);
  });

  it("rejects plans referencing unknown roles", () => {
    const bad = JSON.parse(JSON.stringify(validPlan));
    bad.phases[0].tasks[0].role = "made-up-role";
    expect(() => parsePlanText(JSON.stringify(bad))).toThrow(/unknown role/);
  });

  it("rejects plans with empty tasks array", () => {
    const bad = { phases: [{ name: "x", goal: "y", tasks: [] }] };
    expect(() => parsePlanText(JSON.stringify(bad))).toThrow();
  });

  it("rejects garbage strings", () => {
    expect(() => parsePlanText("not json at all")).toThrow();
  });
});
