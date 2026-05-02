import pino from "pino";
import { config } from "./config.ts";

export const logger = pino({
  level: config.logLevel,
  base: { app: "tpix" },
  timestamp: pino.stdTimeFunctions.isoTime,
});
