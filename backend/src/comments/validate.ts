import { isAwarenessCoord } from "../collab/presence.js";

/**
 * M61-A pure comment-input validation. No `Db`, no I/O. Mirrors the
 * `collab/attention.ts` sanitize discipline: strip control characters,
 * bound every length, never trust client-supplied identity or structure.
 */

export const COMMENT_MAX_LEN = 4000;
export const MAX_MENTIONS = 20;
const MAX_ANCHOR_B64 = 4096;

/** The fixed reaction set (spec §4.7). No custom emoji. */
export const EMOJI_SET: ReadonlySet<string> = new Set([
  "\u{1F44D}", // 👍
  "\u{1F44E}", // 👎
  "\u{1F389}", // 🎉
  "\u{1F440}", // 👀
  "\u{2764}\u{FE0F}", // ❤️
  "\u{1F680}", // 🚀
]);

export function isEmoji(v: unknown): v is string {
  return typeof v === "string" && EMOJI_SET.has(v);
}

function isC0Removable(code: number): boolean {
  // Strip C0 control chars and DEL, but keep newline (\n) and tab (\t).
  return (code < 0x20 && code !== 0x0a && code !== 0x09) || code === 0x7f;
}

/**
 * Strip C0/DEL (keeping `\n`/`\t`), collapse 3+ consecutive newlines to 2,
 * trim. Returns `null` when the result is empty or exceeds
 * {@link COMMENT_MAX_LEN}.
 */
export function sanitizeCommentBody(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let out = "";
  for (let i = 0; i < v.length; i++) {
    if (!isC0Removable(v.charCodeAt(i))) out += v[i];
  }
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  if (out.length === 0 || out.length > COMMENT_MAX_LEN) return null;
  return out;
}

/** Array of integers → deduped → capped at {@link MAX_MENTIONS}. */
export function parseMentionIds(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<number>();
  for (const x of v) {
    if (typeof x === "number" && Number.isInteger(x) && x > 0) seen.add(x);
    if (seen.size >= MAX_MENTIONS) break;
  }
  return [...seen].slice(0, MAX_MENTIONS);
}

export interface AnchorPayload {
  relStart: string;
  relEnd: string;
  slice: string;
  startLine: number;
  endLine: number;
  prefixHash: string;
}

export function isAnchorPayload(v: unknown): v is AnchorPayload {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  if (typeof a.relStart !== "string" || a.relStart.length > MAX_ANCHOR_B64)
    return false;
  if (typeof a.relEnd !== "string" || a.relEnd.length > MAX_ANCHOR_B64)
    return false;
  if (typeof a.slice !== "string" || a.slice.length > 256) return false;
  if (!isAwarenessCoord(a.startLine) || !isAwarenessCoord(a.endLine))
    return false;
  if (typeof a.prefixHash !== "string" || !/^[0-9a-f]{16}$/.test(a.prefixHash))
    return false;
  return true;
}
