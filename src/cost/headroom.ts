import { db } from "../db.ts";
import { logger } from "../logger.ts";
import { getNumber, getSetting, setSetting } from "../repos/settings.ts";
import { latestUsageFromSource, recordUsage } from "../repos/usage.ts";

export interface Headroom {
  used_pct: number;
  ceiling_pct: number;
  headroom_pct: number;
  days_remaining: number;
  reserve_pct: number;
  source: "manual_sync" | "internal" | "default";
}

const SETTINGS_KEYS = {
  periodStartedAt: "period_started_at",
  periodLengthDays: "period_length_days",
  opusCapTokens: "period_opus_cap_tokens",
  sonnetCapTokens: "period_sonnet_cap_tokens",
};

const DEFAULT_PERIOD_LENGTH_DAYS = 7;
const MANUAL_SYNC_TTL_MS = 60 * 60 * 1000; // 1 hour

export function getPeriodStartedAt(): Date {
  const raw = getSetting(SETTINGS_KEYS.periodStartedAt);
  if (raw) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  // Default: assume the period started at the most recent Sunday 00:00 UTC.
  // User can override via /period command.
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const startOfThisWeek = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dayOfWeek),
  );
  return startOfThisWeek;
}

export function getPeriodLengthDays(): number {
  return getNumber(SETTINGS_KEYS.periodLengthDays, DEFAULT_PERIOD_LENGTH_DAYS);
}

export function getDaysRemaining(): number {
  const start = getPeriodStartedAt().getTime();
  const lengthMs = getPeriodLengthDays() * 24 * 60 * 60 * 1000;
  const remainingMs = start + lengthMs - Date.now();
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
}

export function setPeriod(startedAtIso: string, lengthDays: number): void {
  setSetting(SETTINGS_KEYS.periodStartedAt, startedAtIso);
  setSetting(SETTINGS_KEYS.periodLengthDays, String(lengthDays));
}

export function setOpusCap(tokens: number): void {
  setSetting(SETTINGS_KEYS.opusCapTokens, String(tokens));
}

export function setSonnetCap(tokens: number): void {
  setSetting(SETTINGS_KEYS.sonnetCapTokens, String(tokens));
}

export function getOpusCap(): number | null {
  const raw = getSetting(SETTINGS_KEYS.opusCapTokens);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function getSonnetCap(): number | null {
  const raw = getSetting(SETTINGS_KEYS.sonnetCapTokens);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const sumTokensStmt = db.prepare<[string, string], { tokens: number | null }>(`
  SELECT COALESCE(SUM(prompt_tokens) + SUM(completion_tokens), 0) AS tokens
  FROM tokens_log
  WHERE model = ? AND ts >= ?
`);

function tokensUsedSince(model: string, sinceIso: string): number {
  const row = sumTokensStmt.get(model, sinceIso);
  return row?.tokens ?? 0;
}

interface UsedPct {
  pct: number;
  source: "manual_sync" | "internal" | "default";
}

function resolveUsedPct(
  modelName: string,
  cap: number | null,
  manualPctKey: "opus_used_pct" | "sonnet_used_pct",
): UsedPct {
  // Prefer a recent manual /sync if available
  const manual = latestUsageFromSource("manual_sync");
  if (manual) {
    const ageMs = Date.now() - new Date(manual.ts + "Z").getTime();
    if (ageMs >= 0 && ageMs < MANUAL_SYNC_TTL_MS) {
      const v = manual[manualPctKey];
      if (v !== null && v !== undefined) {
        return { pct: clamp(v), source: "manual_sync" };
      }
    }
  }

  // Else fall back to internal counter, if cap is configured
  if (cap !== null) {
    const start = getPeriodStartedAt().toISOString().replace("T", " ").slice(0, 19);
    const tokens = tokensUsedSince(modelName, start);
    const pct = (tokens / cap) * 100;
    return { pct: clamp(pct), source: "internal" };
  }

  // Else default to 0% used (full headroom). Logged so it's not invisible.
  return { pct: 0, source: "default" };
}

function clamp(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

export function getOpusHeadroom(): Headroom {
  const days = getDaysRemaining();
  const reserve = days * 20;
  const ceiling = Math.max(0, 100 - reserve);
  const { pct: used, source } = resolveUsedPct("claude-opus-4-7", getOpusCap(), "opus_used_pct");
  return {
    used_pct: used,
    ceiling_pct: ceiling,
    headroom_pct: Math.max(0, ceiling - used),
    days_remaining: days,
    reserve_pct: reserve,
    source,
  };
}

export function getSonnetHeadroom(): Headroom {
  const days = getDaysRemaining();
  const reserve = days * 10;
  const ceiling = Math.max(0, 100 - reserve);
  const { pct: used, source } = resolveUsedPct("claude-sonnet-4-6", getSonnetCap(), "sonnet_used_pct");
  return {
    used_pct: used,
    ceiling_pct: ceiling,
    headroom_pct: Math.max(0, ceiling - used),
    days_remaining: days,
    reserve_pct: reserve,
    source,
  };
}

export function estimateTaskCostPct(_task: { role: string; description: string }, _tier: "opus" | "sonnet"): number {
  // Placeholder: rolling average will come once we have enough history.
  // Conservative 1% keeps the allocator from over-packing a batch.
  return 1;
}

/**
 * Persist a manual /sync from the user. Sets headroom source = manual_sync
 * for the next hour.
 */
export function applyManualSync(opusPct: number, sonnetPct: number): void {
  recordUsage({
    opus_used_pct: clamp(opusPct),
    sonnet_used_pct: clamp(sonnetPct),
    days_remaining: getDaysRemaining(),
    source: "manual_sync",
  });
  logger.info({ opusPct, sonnetPct }, "manual usage sync recorded");
}

/**
 * Snapshot the current internal counter. Called by the Boss watchdog.
 */
export function snapshotInternal(): void {
  const opus = getOpusHeadroom();
  const sonnet = getSonnetHeadroom();
  recordUsage({
    opus_used_pct: opus.used_pct,
    sonnet_used_pct: sonnet.used_pct,
    days_remaining: opus.days_remaining,
    source: "internal",
  });
}
