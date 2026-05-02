/**
 * Cost Controller stub for Phase 4. Returns optimistic defaults so the Boss can
 * exercise its allocation logic end-to-end. Phase 10 replaces the internals
 * with the real period-accounting + Account&Usage scraper.
 */

export interface Headroom {
  used_pct: number;
  ceiling_pct: number;
  headroom_pct: number;
  days_remaining: number;
  reserve_pct: number;
}

const DEFAULT_DAYS_REMAINING = 7;

export function getOpusHeadroom(): Headroom {
  const days = DEFAULT_DAYS_REMAINING;
  const reserve = days * 20;
  const ceiling = Math.max(0, 100 - reserve);
  const used = 0;
  return {
    used_pct: used,
    ceiling_pct: ceiling,
    headroom_pct: Math.max(0, ceiling - used),
    days_remaining: days,
    reserve_pct: reserve,
  };
}

export function getSonnetHeadroom(): Headroom {
  const days = DEFAULT_DAYS_REMAINING;
  const reserve = days * 10;
  const ceiling = Math.max(0, 100 - reserve);
  const used = 0;
  return {
    used_pct: used,
    ceiling_pct: ceiling,
    headroom_pct: Math.max(0, ceiling - used),
    days_remaining: days,
    reserve_pct: reserve,
  };
}

export function estimateTaskCostPct(_task: { role: string; description: string }, _tier: "opus" | "sonnet"): number {
  return 1;
}
