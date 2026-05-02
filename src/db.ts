import Database from "better-sqlite3";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import { logger } from "./logger.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "migrations");

mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(config.dbFile);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function appliedMigrations(): Set<string> {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const rows = db.prepare<[], { name: string }>(`SELECT name FROM _migrations`).all();
  return new Set(rows.map((r) => r.name));
}

export function runMigrations(): void {
  const applied = appliedMigrations();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const trx = db.transaction(() => {
      db.exec(sql);
      db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(file);
    });
    trx();
    logger.info({ migration: file }, "migration applied");
  }
}

runMigrations();
