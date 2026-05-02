import { db } from "../db.ts";

export interface UsageSample {
  id: number;
  ts: string;
  opus_used_pct: number | null;
  sonnet_used_pct: number | null;
  days_remaining: number | null;
  source: "internal" | "manual_sync" | "scraped";
}

const insertStmt = db.prepare(`
  INSERT INTO subscription_usage (opus_used_pct, sonnet_used_pct, days_remaining, source)
  VALUES (@opus_used_pct, @sonnet_used_pct, @days_remaining, @source)
`);

const latestStmt = db.prepare<[], UsageSample>(`
  SELECT * FROM subscription_usage ORDER BY id DESC LIMIT 1
`);

const latestBySourceStmt = db.prepare<[string], UsageSample>(`
  SELECT * FROM subscription_usage WHERE source = ? ORDER BY id DESC LIMIT 1
`);

export function recordUsage(args: {
  opus_used_pct: number;
  sonnet_used_pct: number;
  days_remaining: number;
  source: "internal" | "manual_sync" | "scraped";
}): void {
  insertStmt.run({
    opus_used_pct: args.opus_used_pct,
    sonnet_used_pct: args.sonnet_used_pct,
    days_remaining: args.days_remaining,
    source: args.source,
  });
}

export function latestUsage(): UsageSample | undefined {
  return latestStmt.get();
}

export function latestUsageFromSource(source: "internal" | "manual_sync" | "scraped"): UsageSample | undefined {
  return latestBySourceStmt.get(source);
}
