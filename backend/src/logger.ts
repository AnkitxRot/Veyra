import { pino } from "pino";

const base = pino({
  level: process.env.LOG_LEVEL ?? (process.env.VITEST ? "silent" : "info"),
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});

type Level = "debug" | "info" | "warn" | "error";

/**
 * console-shaped facade over pino: `log.error("[tag] message", err)` keeps the
 * call sites readable while emitting structured JSON (`err` is serialized with its stack).
 */
function emit(level: Level, message: unknown, args: unknown[]): void {
  const text = typeof message === "string" ? message : String(message);
  const errIndex = args.findIndex((a) => a instanceof Error);
  const rest = args.filter((_, i) => i !== errIndex);
  const fields: Record<string, unknown> = {};
  if (errIndex >= 0) fields.err = args[errIndex];
  if (rest.length > 0) fields.detail = rest;
  base[level](fields, text);
}

export const log = {
  debug: (message: unknown, ...args: unknown[]) => emit("debug", message, args),
  info: (message: unknown, ...args: unknown[]) => emit("info", message, args),
  warn: (message: unknown, ...args: unknown[]) => emit("warn", message, args),
  error: (message: unknown, ...args: unknown[]) => emit("error", message, args),
};
