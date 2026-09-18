import { normalizeRelPath } from "../lsp/uri";

const PREFIX = "veyra_debug_bp_";
const MAX_FILES = 32;
const MAX_LINES = 64;

export type BreakpointMap = Record<string, number[]>;

export function loadBreakpoints(projectId: string): BreakpointMap {
  if (!projectId) return {};
  try {
    const raw = localStorage.getItem(PREFIX + projectId);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: BreakpointMap = {};
    for (const [path, lines] of Object.entries(parsed as Record<string, unknown>)) {
      const rel = normalizeRelPath(path);
      if (!rel || !Array.isArray(lines)) continue;
      const nums = lines
        .filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1)
        .slice(0, MAX_LINES);
      if (nums.length) out[rel] = [...new Set(nums)].sort((a, b) => a - b);
      if (Object.keys(out).length >= MAX_FILES) break;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveBreakpoints(projectId: string, map: BreakpointMap): void {
  if (!projectId) return;
  try {
    localStorage.setItem(PREFIX + projectId, JSON.stringify(map));
  } catch {
    /* quota / private mode */
  }
}

export function toggleLine(map: BreakpointMap, path: string, line: number): BreakpointMap {
  const rel = normalizeRelPath(path);
  if (!rel || !Number.isInteger(line) || line < 1) return map;
  const next = { ...map };
  const cur = new Set(next[rel] ?? []);
  if (cur.has(line)) cur.delete(line);
  else cur.add(line);
  if (cur.size === 0) delete next[rel];
  else next[rel] = [...cur].sort((a, b) => a - b);
  return next;
}
