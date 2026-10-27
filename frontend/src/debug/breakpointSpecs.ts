/**
 * M109: per-breakpoint condition / hit count / logpoint, and watch expressions.
 * Kept beside (not inside) the line-only BreakpointMap so editor gutters and
 * the pre-M109 storage format are unchanged. Local to the browser, never Yjs.
 */
import type { BreakpointMap } from "./breakpoints";

export interface BreakpointSpec {
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}
export type SpecMap = Record<string, Record<string, BreakpointSpec>>;
export type WireBreakpoint = number | ({ line: number } & BreakpointSpec);

const SPEC_PREFIX = "veyra_debug_bpspec_";
const WATCH_PREFIX = "veyra_debug_watch_";
const MAX_TEXT = 512;
const MAX_WATCHES = 20;
const FIELDS = ["condition", "hitCondition", "logMessage"] as const;

function clean(spec: unknown): BreakpointSpec {
  const out: BreakpointSpec = {};
  if (!spec || typeof spec !== "object") return out;
  for (const f of FIELDS) {
    const v = (spec as Record<string, unknown>)[f];
    if (typeof v === "string" && v.trim()) out[f] = v.slice(0, MAX_TEXT);
  }
  return out;
}

export function loadSpecs(projectId: string): SpecMap {
  if (!projectId) return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(SPEC_PREFIX + projectId) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: SpecMap = {};
    for (const [path, byLine] of Object.entries(parsed as Record<string, unknown>)) {
      if (!byLine || typeof byLine !== "object") continue;
      for (const [line, spec] of Object.entries(byLine as Record<string, unknown>)) {
        if (!/^\d+$/.test(line)) continue;
        const c = clean(spec);
        if (Object.keys(c).length) (out[path] ??= {})[line] = c;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function saveSpecs(projectId: string, specs: SpecMap): void {
  if (!projectId) return;
  try {
    localStorage.setItem(SPEC_PREFIX + projectId, JSON.stringify(specs));
  } catch {
    /* quota / private mode */
  }
}

/** Merge `patch` into the spec for path:line; an all-empty result removes it. */
export function setSpec(specs: SpecMap, path: string, line: number, patch: BreakpointSpec): SpecMap {
  const key = String(line);
  const merged = clean({ ...specs[path]?.[key], ...patch, ...blankOverrides(patch) });
  const next: SpecMap = { ...specs };
  const byLine = { ...next[path] };
  if (Object.keys(merged).length) byLine[key] = merged;
  else delete byLine[key];
  if (Object.keys(byLine).length) next[path] = byLine;
  else delete next[path];
  return next;
}

// An explicit "" in the patch must clear that field rather than keep the old value.
function blankOverrides(patch: BreakpointSpec): BreakpointSpec {
  const o: BreakpointSpec = {};
  for (const f of FIELDS) if (patch[f] === "") o[f] = "";
  return o;
}

/** Drop specs whose line is no longer a breakpoint. */
export function pruneSpecs(specs: SpecMap, bps: BreakpointMap): SpecMap {
  const out: SpecMap = {};
  for (const [path, byLine] of Object.entries(specs)) {
    const keep = Object.entries(byLine).filter(([l]) => (bps[path] ?? []).includes(Number(l)));
    if (keep.length) out[path] = Object.fromEntries(keep);
  }
  return out;
}

export function toWireLines(lines: number[], byLine: Record<string, BreakpointSpec> | undefined): WireBreakpoint[] {
  return lines.map((line) => {
    const s = byLine?.[String(line)];
    return s && Object.keys(s).length ? { line, ...s } : line;
  });
}

export function toWireMap(bps: BreakpointMap, specs: SpecMap): Record<string, WireBreakpoint[]> {
  const out: Record<string, WireBreakpoint[]> = {};
  for (const [path, lines] of Object.entries(bps)) out[path] = toWireLines(lines, specs[path]);
  return out;
}

export function loadWatches(projectId: string): string[] {
  if (!projectId) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(WATCH_PREFIX + projectId) ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, MAX_WATCHES)
      : [];
  } catch {
    return [];
  }
}

export function saveWatches(projectId: string, watches: string[]): void {
  if (!projectId) return;
  try {
    localStorage.setItem(WATCH_PREFIX + projectId, JSON.stringify(watches));
  } catch {
    /* quota / private mode */
  }
}

export function addWatch(watches: string[], expr: string): string[] {
  const e = expr.trim().slice(0, 1024);
  if (!e || watches.includes(e) || watches.length >= MAX_WATCHES) return watches;
  return [...watches, e];
}
