import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoleRegistry, roles } from "./registry.ts";

describe("RoleRegistry", () => {
  it("loads all 24 production roles from disk and validates each", () => {
    expect(roles.size()).toBe(24);
    const ids = roles.all().map((r) => r.id).sort();
    expect(ids).toContain("boss");
    expect(ids).toContain("researcher");
    expect(ids).toContain("ethical-hacker");
    expect(ids).toContain("cost-controller");
    expect(ids).toContain("devils-advocate");
  });

  it("each role has the required schema fields", () => {
    for (const r of roles.all()) {
      expect(r.id).toMatch(/^[a-z0-9-]+$/);
      expect(r.name.length).toBeGreaterThan(0);
      expect(["leadership", "discovery", "engineering", "quality", "delivery", "meta"]).toContain(r.category);
      expect(["high", "medium", "low"]).toContain(r.quality_sensitivity);
      expect(["opus", "sonnet", "ollama"]).toContain(r.default_tier_hint);
      expect(r.system_prompt.length).toBeGreaterThan(20);
      expect(r.offline_model.length).toBeGreaterThan(0);
    }
  });

  it("get() throws on unknown id", () => {
    expect(() => roles.get("does-not-exist")).toThrow(/Unknown role/);
  });

  it("rejects malformed YAML at load time", () => {
    const tmp = mkdtempSync(join(tmpdir(), "tpix-roles-"));
    try {
      writeFileSync(join(tmp, "bad.yaml"), "id: BadId\nname: x\n");
      const reg = new RoleRegistry();
      expect(() => reg.load(tmp)).toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects an empty roles directory", () => {
    const tmp = mkdtempSync(join(tmpdir(), "tpix-roles-empty-"));
    try {
      const reg = new RoleRegistry();
      expect(() => reg.load(tmp)).toThrow(/No role YAML files/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
