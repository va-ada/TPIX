import { connect } from "node:net";
import { logger } from "../logger.ts";

const ANTHROPIC_HOST = "api.anthropic.com";
const ANTHROPIC_PORT = 443;
const PROBE_TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 30_000;

interface ProbeCache {
  reachable: boolean;
  checkedAt: number;
}

let cache: ProbeCache | null = null;

export function clearProbeCache(): void {
  cache = null;
}

export async function isClaudeReachable(): Promise<boolean> {
  const now = Date.now();
  if (cache && now - cache.checkedAt < CACHE_TTL_MS) {
    return cache.reachable;
  }

  const reachable = await tcpProbe(ANTHROPIC_HOST, ANTHROPIC_PORT, PROBE_TIMEOUT_MS);
  cache = { reachable, checkedAt: now };
  logger.debug({ reachable }, "anthropic reachability probed");
  return reachable;
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });

    socket.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}
