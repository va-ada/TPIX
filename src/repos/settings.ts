import { db } from "../db.ts";

const getStmt = db.prepare<[string], { value: string }>(`SELECT value FROM settings WHERE key = ?`);
const upsertStmt = db.prepare(`
  INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
`);

export function getSetting(key: string): string | undefined {
  return getStmt.get(key)?.value;
}

export function setSetting(key: string, value: string): void {
  upsertStmt.run(key, value);
}

export function getNumber(key: string, fallback: number): number {
  const raw = getSetting(key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function setNumber(key: string, value: number): void {
  setSetting(key, String(value));
}
