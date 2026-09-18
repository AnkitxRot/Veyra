/**
 * Client ↔ backend debugger protocol. This is NOT raw DAP.
 *
 * The browser names a language + workspace-relative entry file. The backend
 * constructs the DAP launch, picks the adapter, and mediates every request.
 * `evaluate`, adapter executables, container IDs, and host paths are rejected.
 */

import {
  DEBUG_MAX_ARG_CHARS,
  DEBUG_MAX_BREAKPOINT_FILES,
  DEBUG_MAX_BREAKPOINTS_PER_FILE,
  DEBUG_MAX_PROGRAM_ARGS,
} from "./bounds.js";
import {
  getDebugLanguage,
  languageMatchesEntry,
  type DebugLanguageSpec,
} from "./languages.js";
import { isForbiddenRelPath, normalizeRelPath } from "./paths.js";

export type DebugClientCommand =
  | "launch"
  | "setBreakpoints"
  | "continue"
  | "pause"
  | "next"
  | "stepIn"
  | "stepOut"
  | "stackTrace"
  | "scopes"
  | "variables"
  | "terminate";

export const CLIENT_COMMANDS = new Set<string>([
  "launch",
  "setBreakpoints",
  "continue",
  "pause",
  "next",
  "stepIn",
  "stepOut",
  "stackTrace",
  "scopes",
  "variables",
  "terminate",
]);

/** DAP reverse-requests that must never cause host process creation. */
export const REJECTED_ADAPTER_REQUESTS = new Set<string>([
  "runInTerminal",
  "startDebugging",
  "runInTerminalRequest",
]);

/** DAP commands the backend may send to an adapter. */
export const ADAPTER_REQUESTS = new Set<string>([
  "initialize",
  "launch",
  "setBreakpoints",
  "configurationDone",
  "threads",
  "continue",
  "pause",
  "next",
  "stepIn",
  "stepOut",
  "stackTrace",
  "scopes",
  "variables",
  "terminate",
  "disconnect",
]);

export interface LaunchConfig {
  language: DebugLanguageSpec;
  entryFile: string;
  args: string[];
  breakpoints: Map<string, number[]>;
}

export interface SetBreakpointsConfig {
  path: string;
  lines: number[];
}

export function parseLaunch(raw: unknown):
  | { ok: true; value: LaunchConfig }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "invalid launch payload" };
  }
  const o = raw as Record<string, unknown>;
  const spec = getDebugLanguage(o.language);
  if (!spec) return { ok: false, error: "unsupported debug language" };
  const entryFile = normalizeRelPath(o.entryFile);
  if (!entryFile) return { ok: false, error: "invalid entry file" };
  if (isForbiddenRelPath(entryFile)) {
    return { ok: false, error: "invalid entry file" };
  }
  if (!languageMatchesEntry(spec, entryFile)) {
    return { ok: false, error: "entry file does not match language" };
  }
  const args = parseArgs(o.args);
  if (args === null) return { ok: false, error: "invalid program arguments" };
  const breakpoints = parseBreakpointMap(o.breakpoints);
  if (breakpoints === null) {
    return { ok: false, error: "invalid breakpoints" };
  }
  return { ok: true, value: { language: spec, entryFile, args, breakpoints } };
}

export function parseSetBreakpoints(raw: unknown):
  | { ok: true; value: SetBreakpointsConfig }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "invalid breakpoints payload" };
  }
  const o = raw as Record<string, unknown>;
  const path = normalizeRelPath(o.path);
  if (!path || isForbiddenRelPath(path)) {
    return { ok: false, error: "invalid source path" };
  }
  const lines = parseLines(o.lines);
  if (lines === null) return { ok: false, error: "invalid breakpoint lines" };
  return { ok: true, value: { path, lines } };
}

export function parseArgs(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  if (raw.length > DEBUG_MAX_PROGRAM_ARGS) return null;
  const out: string[] = [];
  for (const a of raw) {
    if (typeof a !== "string") return null;
    if (a.length > DEBUG_MAX_ARG_CHARS) return null;
    if (a.includes("\0") || hasC0Control(a)) return null;
    out.push(a);
  }
  return out;
}

function hasC0Control(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) return true;
  }
  return false;
}

export function parseLines(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length > DEBUG_MAX_BREAKPOINTS_PER_FILE) return null;
  const out: number[] = [];
  const seen = new Set<number>();
  for (const n of raw) {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 1_000_000) {
      return null;
    }
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export function parseBreakpointMap(
  raw: unknown,
): Map<string, number[]> | null {
  const map = new Map<string, number[]>();
  if (raw === undefined || raw === null) return map;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > DEBUG_MAX_BREAKPOINT_FILES) return null;
  for (const [pathRaw, linesRaw] of entries) {
    const path = normalizeRelPath(pathRaw);
    if (!path || isForbiddenRelPath(path)) return null;
    const lines = parseLines(linesRaw);
    if (lines === null) return null;
    map.set(path, lines);
  }
  return map;
}

export function parseFrameId(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return null;
  return raw;
}

export function parseVariablesReference(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return null;
  return raw;
}
