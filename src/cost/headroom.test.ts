import { describe, expect, it, beforeEach } from "vitest";
import { db } from "../db.ts";
import {
  getOpusHeadroom,
  getSonnetHeadroom,
  applyManualSync,
  setOpusCap,
  setSonnetCap,
  setPeriod,
} from "./headroom.ts";

function reset() {
  db.prepare("DELETE FROM tokens_log").run();
  db.prepare("DELETE FROM subscription_usage").run();
  db.prepare("DELETE FROM settings").run();
}

describe("headroom math", () => {
  beforeEach(reset);

  it("opus reserve 20%/day, sonnet reserve 10%/day at fresh 7-day period", () => {
    setPeriod(new Date().toISOString(), 7);
    const o = getOpusHeadroom();
    const s = getSonnetHeadroom();
    expect(o.reserve_pct).toBe(140);
    expect(o.ceiling_pct).toBe(0);
    expect(s.reserve_pct).toBe(70);
    expect(s.ceiling_pct).toBe(30);
  });

  it("manual /sync overrides internal counter for 1 hour, marked source=manual_sync", () => {
    setPeriod(new Date().toISOString(), 3); // 3 days remaining → opus_ceiling = 40
    applyManualSync(20, 50);
    const o = getOpusHeadroom();
    const s = getSonnetHeadroom();
    expect(o.source).toBe("manual_sync");
    expect(s.source).toBe("manual_sync");
    expect(o.used_pct).toBe(20);
    expect(s.used_pct).toBe(50);
    // ceiling = 100 - 3*20 = 40 → headroom = 40 - 20 = 20
    expect(o.headroom_pct).toBe(20);
    // sonnet ceiling = 100 - 3*10 = 70 → headroom = 70 - 50 = 20
    expect(s.headroom_pct).toBe(20);
  });

  it("internal counter computes used_pct from tokens_log when cap is set", () => {
    setPeriod(new Date(Date.now() - 3 * 86400_000).toISOString(), 7); // 4 days remaining
    setOpusCap(1000); // 1k token cap
    db.prepare(
      `INSERT INTO tokens_log (role_id, route, model, prompt_chars, completion_chars, prompt_tokens, completion_tokens, latency_ms)
       VALUES ('boss', 'claude', 'claude-opus-4-7', 1, 1, 200, 100, 0)`,
    ).run();
    const o = getOpusHeadroom();
    expect(o.source).toBe("internal");
    expect(o.used_pct).toBe(30); // 300 of 1000 = 30%
  });

  it("defaults to 0% used when no cap and no manual sync", () => {
    setPeriod(new Date().toISOString(), 3);
    const o = getOpusHeadroom();
    expect(o.source).toBe("default");
    expect(o.used_pct).toBe(0);
  });

  it("clamps used_pct to [0, 100]", () => {
    setPeriod(new Date().toISOString(), 3);
    applyManualSync(150, -10);
    const o = getOpusHeadroom();
    const s = getSonnetHeadroom();
    expect(o.used_pct).toBe(100);
    expect(s.used_pct).toBe(0);
  });

  it("sonnet cap path also works", () => {
    setPeriod(new Date(Date.now() - 86400_000).toISOString(), 7); // 6 days remaining
    setSonnetCap(2000);
    db.prepare(
      `INSERT INTO tokens_log (role_id, route, model, prompt_chars, completion_chars, prompt_tokens, completion_tokens, latency_ms)
       VALUES ('backend', 'claude', 'claude-sonnet-4-6', 1, 1, 800, 200, 0)`,
    ).run();
    const s = getSonnetHeadroom();
    expect(s.source).toBe("internal");
    expect(s.used_pct).toBe(50); // 1000 of 2000 = 50%
  });
});
