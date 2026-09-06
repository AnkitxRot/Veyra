/**
 * M62 — the ONE canonical place that turns a raw stored profile
 * `display_name` into a user-facing display string.
 *
 * Identity model:
 *   - technical identity   : userId (ownership key) + username (immutable handle)
 *   - presentation identity: displayName (free-text, user-editable, optional)
 *   - effective display    : sanitized displayName when present, else username
 *
 * `effectiveDisplayName` is presentation only. It is never used for
 * authorization, ownership, attribution, audit identity, mention resolution,
 * cache keys, or any lookup. Those all stay on userId / username.
 */

/** A C0 control character or DEL. Stripped wholesale from a single-line
 *  identity field — newline and tab included (a display name is one line). */
function isControlOrDel(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

/**
 * Single-line identity normalization, shared by `validate.ts` (input
 * validation) and the resolver below (defensive re-sanitize of stored data):
 *
 *   1. strip every C0 control char and DEL — no exceptions
 *   2. collapse remaining internal whitespace runs to one space
 *   3. trim
 *
 * Sanitization first, whitespace-collapse second, so `"a\nb"` -> `"ab"` and
 * `"  Ada   L.  "` -> `"Ada L."`.
 */
export function normalizeSingleLineIdentity(v: string): string {
  let out = "";
  for (let i = 0; i < v.length; i++) {
    if (!isControlOrDel(v.charCodeAt(i))) out += v[i];
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Defensive sanitize of a value read back from the profile store. Returns the
 * cleaned single-line string, or `null` when nothing usable remains. Also
 * hard-caps length at 48 so a resolver caller can never emit an unbounded
 * string even if a longer value somehow reached the column.
 */
export function sanitizeStoredDisplayName(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const n = normalizeSingleLineIdentity(raw);
  if (n.length === 0) return null;
  return n.length > 48 ? n.slice(0, 48) : n;
}

/**
 * The canonical resolver. `displayNameRaw` is the stored `display_name`
 * column (nullable, possibly stale/loose); `username` is the authenticated
 * technical handle. Returns a sanitized, non-empty display string — the
 * display name when valid, otherwise the username. Never returns an
 * unsanitized profile value.
 */
export function effectiveDisplayName(
  displayNameRaw: string | null | undefined,
  username: string,
): string {
  return sanitizeStoredDisplayName(displayNameRaw) ?? username;
}

/**
 * M73 — defensive sanitize of the stored `pronouns` column for presentation
 * in the collaboration surfaces. Same single-line rule as a display name
 * (strip C0/DEL, collapse whitespace, trim) but hard-capped at 24 to match
 * `PRONOUNS_MAX`. Returns `null` when nothing usable remains — pronouns are
 * genuinely optional, so there is no username-style fallback. Presentation
 * only: never a key, never a lookup.
 */
export function sanitizeStoredPronouns(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const n = normalizeSingleLineIdentity(raw);
  if (n.length === 0) return null;
  return n.length > 24 ? n.slice(0, 24) : n;
}
