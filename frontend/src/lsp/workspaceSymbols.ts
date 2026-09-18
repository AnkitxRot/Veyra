import { getReadyLspBridges } from "./providers";
import { fromWorkspaceUri } from "./uri";

export interface WorkspaceSymbolHit {
  name: string;
  filePath: string;
  line: number;
  column: number;
  containerName?: string;
}

const MAX_HITS = 80;

/**
 * Ask every ready language server for workspace symbols. Paths that are
 * not under /workspace are dropped. Rename/refactor is not implemented —
 * this is navigation only.
 */
export async function searchWorkspaceSymbols(
  query: string,
): Promise<WorkspaceSymbolHit[]> {
  const bridges = getReadyLspBridges();
  if (bridges.length === 0) return [];
  const q = query.trim().slice(0, 200);
  const results = await Promise.all(
    bridges.map((bridge) =>
      bridge.request("workspace/symbol", { query: q }).catch(() => []),
    ),
  );
  const hits: WorkspaceSymbolHit[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    const list = Array.isArray(result) ? result : [];
    for (const item of list as Array<Record<string, unknown>>) {
      const name = typeof item?.name === "string" ? item.name : "";
      if (!name) continue;
      const loc = (item.location ?? item) as {
        uri?: unknown;
        range?: { start?: { line?: number; character?: number } };
      };
      const rel = fromWorkspaceUri(loc.uri ?? item.uri);
      if (!rel) continue;
      const range = loc.range ??
        (item.range as { start?: { line?: number; character?: number } } | undefined) ??
        (item.selectionRange as
          | { start?: { line?: number; character?: number } }
          | undefined);
      const line = (range?.start?.line ?? 0) + 1;
      const column = (range?.start?.character ?? 0) + 1;
      const key = `${rel}:${line}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        name,
        filePath: rel,
        line,
        column,
        containerName:
          typeof item.containerName === "string" ? item.containerName : undefined,
      });
      if (hits.length >= MAX_HITS) return hits;
    }
  }
  return hits;
}
