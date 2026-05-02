import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { logger } from "../logger.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const ROLES_DIR = join(REPO_ROOT, "roles");

export const RoleSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "id must be kebab-case ASCII"),
  name: z.string().min(1),
  category: z.enum(["leadership", "discovery", "engineering", "quality", "delivery", "meta"]),
  system_prompt: z.string().min(20),
  offline_model: z.string().min(1),
  quality_sensitivity: z.enum(["high", "medium", "low"]),
  default_tier_hint: z.enum(["opus", "sonnet", "ollama"]),
  allowed_tools: z.array(z.string()).default([]),
  inputs: z.array(z.string()).default([]),
  outputs: z.array(z.string()).default([]),
});

export type Role = z.infer<typeof RoleSchema>;

export class RoleRegistry {
  private readonly roles = new Map<string, Role>();

  load(dir: string = ROLES_DIR): void {
    this.roles.clear();
    const files = readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    if (files.length === 0) {
      throw new Error(`No role YAML files found in ${dir}`);
    }
    for (const file of files) {
      const path = join(dir, file);
      const raw = readFileSync(path, "utf8");
      const parsed = parseYaml(raw) as unknown;
      const validated = RoleSchema.safeParse(parsed);
      if (!validated.success) {
        throw new Error(
          `Role ${file} failed schema validation: ${JSON.stringify(validated.error.format())}`,
        );
      }
      const role = validated.data;
      if (this.roles.has(role.id)) {
        throw new Error(`Duplicate role id "${role.id}" in ${file}`);
      }
      this.roles.set(role.id, role);
    }
    logger.info({ count: this.roles.size }, "role registry loaded");
  }

  get(id: string): Role {
    const r = this.roles.get(id);
    if (!r) throw new Error(`Unknown role id: ${id}`);
    return r;
  }

  has(id: string): boolean {
    return this.roles.has(id);
  }

  all(): Role[] {
    return Array.from(this.roles.values());
  }

  size(): number {
    return this.roles.size;
  }
}

export const roles = new RoleRegistry();
roles.load();
