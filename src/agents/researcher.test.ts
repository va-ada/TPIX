import { describe, expect, it } from "vitest";
import { parseResearchResult } from "./researcher.ts";

const valid = {
  similar_products: [
    {
      name: "ERPNext",
      url: "https://erpnext.com/",
      inferred_stack: ["Python", "Frappe", "MariaDB"],
      notable_features: ["BOM", "production planning"],
    },
  ],
  recommended_stack: ["Python", "Frappe", "MariaDB"],
  rationale: "ERPNext is the most-used open source ERP with marble industry adoption.",
};

describe("parseResearchResult", () => {
  it("parses a clean JSON object", () => {
    const r = parseResearchResult(JSON.stringify(valid));
    expect(r.similar_products).toHaveLength(1);
    expect(r.recommended_stack).toContain("Python");
  });

  it("strips a markdown json fence", () => {
    const r = parseResearchResult("```json\n" + JSON.stringify(valid) + "\n```");
    expect(r.similar_products[0]?.name).toBe("ERPNext");
  });

  it("rejects when similar_products entry has invalid URL", () => {
    const bad = JSON.parse(JSON.stringify(valid));
    bad.similar_products[0].url = "not-a-url";
    expect(() => parseResearchResult(JSON.stringify(bad))).toThrow();
  });

  it("accepts an empty similar_products array (no comparable product)", () => {
    const r = parseResearchResult(
      JSON.stringify({
        similar_products: [],
        recommended_stack: ["Next.js", "PostgreSQL"],
        rationale: "no comparable product; sane default",
      }),
    );
    expect(r.similar_products).toHaveLength(0);
    expect(r.recommended_stack).toEqual(["Next.js", "PostgreSQL"]);
  });
});
