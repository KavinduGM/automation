import pino from "pino";
import { env } from "./env.js";

export const logger = pino({
  level: env().LOG_LEVEL,
  base: undefined, // omit pid/hostname noise
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function child(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
