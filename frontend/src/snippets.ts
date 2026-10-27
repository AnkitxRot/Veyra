/**
 * M104: user/project snippets in the VS Code JSON shape
 * ({ "name": { "prefix": "x" | ["x"], "body": "..." | ["..."], "description"? } }),
 * loaded from `.veyra/snippets/*.json`. Parsing is defensive: bad entries are dropped.
 */
export interface Snippet {
  name: string;
  prefix: string;
  body: string;
  description: string;
}

const MAX_SNIPPETS_PER_FILE = 500;

export function parseSnippets(json: string): Snippet[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: Snippet[] = [];
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (out.length >= MAX_SNIPPETS_PER_FILE) break;
    if (!v || typeof v !== "object") continue;
    const e = v as { prefix?: unknown; body?: unknown; description?: unknown };
    const prefixes = (Array.isArray(e.prefix) ? e.prefix : [e.prefix]).filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    const body = Array.isArray(e.body)
      ? e.body.every((l) => typeof l === "string")
        ? (e.body as string[]).join("\n")
        : null
      : typeof e.body === "string"
        ? e.body
        : null;
    if (!prefixes.length || body === null) continue;
    for (const prefix of prefixes)
      out.push({ name, prefix, body, description: typeof e.description === "string" ? e.description : name });
  }
  return out;
}
