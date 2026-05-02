import { logger } from "./logger.ts";
import { isClaudeReachable, clearProbeCache } from "./llm/probe.ts";
import { sendToUser, isBotConfigured } from "./bot/telegram.ts";

const PROBE_INTERVAL_MS = 30_000;

let lastReachable: boolean | null = null;
let timer: NodeJS.Timeout | null = null;

export interface ConnectivityTick {
  reachable: boolean;
  changed: boolean;
}

export async function tickConnectivity(): Promise<ConnectivityTick> {
  clearProbeCache();
  const reachable = await isClaudeReachable();
  const changed = lastReachable !== null && reachable !== lastReachable;
  if (lastReachable === null) {
    logger.info({ reachable }, "connectivity initial state");
  } else if (changed) {
    logger.info({ reachable }, "connectivity changed");
    if (isBotConfigured()) {
      try {
        await sendToUser(
          reachable
            ? "🟢 Anthropic reachable — Claude routes resumed."
            : "🔴 Anthropic unreachable — workers fall back to Ollama; Boss will pause Opus/Sonnet-required tasks.",
        );
      } catch (err) {
        logger.error({ err: (err as Error).message }, "telegram online/offline toast failed");
      }
    }
  }
  lastReachable = reachable;
  return { reachable, changed };
}

export function startConnectivityProbe(): void {
  if (timer) return;
  // Fire one immediate probe so lastReachable is set without waiting 30s
  void tickConnectivity();
  timer = setInterval(tickConnectivity, PROBE_INTERVAL_MS);
  logger.info({ intervalMs: PROBE_INTERVAL_MS }, "connectivity probe started");
}

export function stopConnectivityProbe(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function _resetForTests(): void {
  lastReachable = null;
  if (timer) clearInterval(timer);
  timer = null;
}
