import { ApiError } from "../errors.js";
import { normalizeSingleLineIdentity } from "./identity.js";

/**
 * M62-2 — pure self-service profile identity validation. No `Db`, no I/O.
 *
 * Only `displayName`, `pronouns` and `bio` are writable in M62. Every other
 * `user_profiles` column (avatar, banners, accent, effect, visibility, the
 * `show_*` toggles, `version`, `location`) is dormant and MUST NOT be
 * reachable from the request body — an unknown key is a hard 400
 * (`invalid_profile_key`), mirroring `auth/preferences.ts`.
 *
 * `displayName` / `pronouns` are single-line: strip ALL C0 controls + DEL
 * (newline and tab included — sanitize first), then collapse internal
 * whitespace, then trim (see `normalizeSingleLineIdentity`). `bio` is the
 * separate multi-line rule: keep `\n`/`\t`, preserve intentional blank
 * lines, collapse 3+ newlines to 2 — the `comments/validate.ts` discipline.
 */

export const PROFILE_FIELDS = ["displayName", "pronouns", "bio"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

const ALLOWED_KEYS: ReadonlySet<string> = new Set(PROFILE_FIELDS);

export const DISPLAY_NAME_MAX = 48;
export const PRONOUNS_MAX = 24;
export const BIO_MAX = 280;

export interface ProfilePatch {
  displayName?: string | null;
  pronouns?: string | null;
  bio?: string | null;
}

/** Multi-line normalize: drop C0/DEL except `\n`/`\t`, collapse 3+ newlines
 *  to a single blank line, trim. Used for `bio`. Mirrors
 *  `sanitizeCommentBody`. No HTML/Markdown interpretation anywhere. */
function normalizeMultiLine(v: string): string {
  let out = "";
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if ((c < 0x20 && c !== 0x0a && c !== 0x09) || c === 0x7f) continue;
    out += v[i];
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function validateDisplayName(v: unknown): string | null {
  if (v === null) return null; // null clears
  if (typeof v !== "string") {
    throw new ApiError(
      400,
      "displayName must be a string or null",
      "invalid_display_name",
    );
  }
  const n = normalizeSingleLineIdentity(v);
  if (n.length === 0) {
    // a non-null value that normalizes to empty is invalid (unlike null)
    throw new ApiError(
      400,
      "displayName must not be empty",
      "invalid_display_name",
    );
  }
  if (n.length > DISPLAY_NAME_MAX) {
    throw new ApiError(
      400,
      `displayName must be at most ${DISPLAY_NAME_MAX} characters`,
      "invalid_display_name",
    );
  }
  return n;
}

function validatePronouns(v: unknown): string | null {
  if (v === null) return null; // null clears
  if (typeof v !== "string") {
    throw new ApiError(
      400,
      "pronouns must be a string or null",
      "invalid_pronouns",
    );
  }
  const n = normalizeSingleLineIdentity(v);
  // empty normalizes to the single cleared representation (NULL) — no second
  // semantic state for "present but blank".
  if (n.length === 0) return null;
  if (n.length > PRONOUNS_MAX) {
    throw new ApiError(
      400,
      `pronouns must be at most ${PRONOUNS_MAX} characters`,
      "invalid_pronouns",
    );
  }
  return n;
}

function validateBio(v: unknown): string | null {
  if (v === null) return null; // null clears
  if (typeof v !== "string") {
    throw new ApiError(400, "bio must be a string or null", "invalid_bio");
  }
  const n = normalizeMultiLine(v);
  if (n.length === 0) return null; // blank clears, same as null
  if (n.length > BIO_MAX) {
    throw new ApiError(
      400,
      `bio must be at most ${BIO_MAX} characters`,
      "invalid_bio",
    );
  }
  return n;
}

/**
 * Validate a PUT body against the explicit three-key allowlist. Rejects any
 * unknown key (including `userId`/`username`/`role`/`version` and every
 * dormant profile column) with 400 `invalid_profile_key`. Returns a patch
 * carrying only the keys that were actually present in the body.
 */
export function validateProfilePatch(body: unknown): ProfilePatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(
      400,
      "profile body must be an object",
      "invalid_profile_body",
    );
  }
  const rec = body as Record<string, unknown>;

  for (const key of Object.keys(rec)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new ApiError(
        400,
        `unknown profile key: "${key}"`,
        "invalid_profile_key",
      );
    }
  }

  const patch: ProfilePatch = {};
  if ("displayName" in rec) patch.displayName = validateDisplayName(rec.displayName);
  if ("pronouns" in rec) patch.pronouns = validatePronouns(rec.pronouns);
  if ("bio" in rec) patch.bio = validateBio(rec.bio);
  return patch;
}
