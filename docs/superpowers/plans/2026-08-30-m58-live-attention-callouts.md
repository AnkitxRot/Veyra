# M58 — Live Attention, Callouts & Spatial Collaboration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a transient ATTENTION layer (Point / Callout / targeted "Come look here" / nearby-region awareness) on top of M57 presence, so a remote collaborator can naturally get another's attention around a specific range of code — with no new transport, no persistence, and no change to the Yjs document or M57 awareness.

**Architecture:** All attention traffic rides the existing `MESSAGE_CUSTOM` (type 3) channel already used for `file_open`/`file_ready`/`run_status`/`external_mutation_notice`. A pure domain module (`backend/src/collab/attention.ts`) owns event validation, server-authoritative event construction, opaque IDs, the token-bucket rate limiter, and a bounded in-memory `AttentionRequestRegistry`. `CollaborationRoom` gains one `handleAttentionMessage` branch plus targeted delivery, a join snapshot for the recipient, expiry timers (mirroring `runStatusLingerTimers`), and disconnect cleanup. The frontend gets a matching pure module (`frontend/src/collab/attention.ts`) with an `AttentionStore` (Map + local TTL timers), sender methods on `CollaborationClient`, a throttled `attention` state in `IDE.tsx`, Monaco editor actions + decorations in `Editor.tsx`, and a non-modal `AttentionTray`. All navigation goes through the existing `openAndRevealLocation` primitive.

**Tech Stack:** TypeScript, Node ESM, `yjs`, `y-protocols`, `ws`, `lib0` encoding, `node:crypto`, React 18, Vite, Monaco, Vitest (backend: `singleThread` pool, real Yjs/`y-protocols` in collab tests, `makeWs()` fake socket; frontend: jsdom, fake timers, `@testing-library/react`).

**Spec:** `docs/superpowers/specs/2026-08-30-m58-live-attention-callouts-design.md` — read it alongside this plan. The reviewer-approved decisions in the spec's §17 and in the approval message override any ambiguity:
1. 4th outstanding request from one author → **drop the new request** (never evict a legitimate one); sender gets a lightweight "too many pending" state, not a persistent error mechanism.
2. Callout: client TTL 45 s, **server hard ceiling 90 s**, refresh-while-visible allowed but never past the ceiling; at the ceiling it must disappear.
3. Attention count badge on the existing collaborator chip; counts **only actionable incoming targeted requests** (never points/callouts); clicking the chip reaches the `AttentionTray`; TeamPanel and the per-avatar quick popover are preserved.
4. Targeted-request lifecycle is server-authoritative; only the authenticated target may dismiss/act; dismiss/acted must validate the entry exists AND is targeted at the current connection's user; no clearing another user's request by guessing an ID.
5. Attention ID is opaque and server-generated (`crypto`).
6. M58 is entirely ephemeral — no DB / Git / Yjs / workspace-file persistence.
7. Yjs document state and M57 awareness are untouched, separate layers.
8. Change attribution stays deferred to M60.

## Global Constraints

- **No new WebSocket endpoint, no new presence store, no new document-sync mechanism.** Attention uses `MESSAGE_CUSTOM` + a bounded in-memory room registry only.
- **No persistence of attention.** No SQLite table, no migration, no workspace file, no Git object, no `Y.Doc` key. `doc.share` is never accessed on any attention code path.
- **Document sync untouched.** No changes to `Y.Doc` handling, `syncProtocol`, `MonacoBinding`, coalescing windows, watermarks, or `backend/src/config.ts`.
- **M57 awareness untouched.** M58 never calls `awareness.setLocalStateField` and never adds an awareness field. It only *reads* `CollaboratorPresence`.
- **`backend/test/collab-awareness-security.test.ts` and `backend/test/m57-presence.test.ts` must pass UNCHANGED.**
- **Author identity is always server-set** from `CollaboratorClientState` (the authenticated WS session). Any `author`/`userId` in a client payload is ignored. Event `id`, `createdAt`, `expiresAt`, `color` are server-constructed.
- **Targeted requests:** deliver only to the intended recipient; survive recipient reconnect only while still valid; expire server-side; removed on dismissal, on author disconnect, on target disconnect; never persisted; never resurrect after expiry.
- **Attention text (`message`) is untrusted:** cleaned (C0/DEL → space, `\s+` → ` `, trim), capped at `ATTENTION_MAX_MESSAGE_LEN = 280`, empty-after-clean rejected for callout/request, rendered as **text only** (`textContent` / React child) — never `innerHTML`, no Markdown→HTML.
- **`file` path** goes through the existing `sanitizeAwarenessFilePath` (bounded workspace-relative: no absolute, no drive letter, no `..`, no C0/DEL, ≤512).
- **All attention navigation** (Point, Callout, Request "Go there", and the retrofitted Jump) goes through `openAndRevealLocation(openFile, target)` — open-then-reveal, never dispatch-only.
- **Constants** live in `backend/src/collab/attention.ts` and `frontend/src/collab/attention.ts`, hand-synced per repo convention (same as `presence.ts` / `types.ts`), each pinned by its own test.
- **Commits require explicit user approval** (`CLAUDE.md`) and the M58 brief says **DO NOT COMMIT**. Every task's final step is "Stage for review" (`git add` only). Do **not** run `git commit`.
- **Do not revert the existing uncommitted M56/M57 working-tree changes.** Keep M58 changes distinguishable — new files plus additive branches.
- **Verification environment:** Docker IS available. Backend baseline: **804 passed / 0 failed / 9 skipped**. Frontend baseline: **366 passed / 0 failed**. Do not report stale numbers. Run backend tests from `backend/` (`npx vitest run <file>`), frontend from `frontend/` (`npx vitest run <file>`).

---

## Shared constants (identical in both `attention.ts` modules)

```ts
export const ATTENTION_MAX_MESSAGE_LEN = 280;
export const ATTENTION_POINT_TTL_MS = 6_000;      // client fade for a point
export const ATTENTION_CALLOUT_TTL_MS = 45_000;   // client default visible life
export const ATTENTION_CALLOUT_MAX_TTL_MS = 90_000; // SERVER hard ceiling
export const ATTENTION_REQUEST_TTL_MS = 120_000;  // server registry expiry
export const ATTENTION_RATE_WINDOW_MS = 10_000;
export const ATTENTION_MAX_EVENTS_PER_WINDOW = 10; // per connection
export const ATTENTION_MAX_OUTSTANDING_REQUESTS = 3; // per author, in registry
export const ATTENTION_MAX_REGISTRY_ENTRIES = 200; // room-wide
export const RANGE_NEAR_LINES = 5;                 // nearby tier threshold
```

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `backend/src/collab/attention.ts` | **Create** | Pure domain: constants, wire types, `normalizeRange`, `rangesOverlap`, `sanitizeAttentionMessage`, `newAttentionId`, `parseAttentionInput`, `buildAttentionEvent`, `RateLimiter`, `AttentionRequestRegistry`. No `ws` / `Y.Doc` imports. |
| `backend/src/collab/manager.ts` | Modify | `CollaborationRoom`: `handleAttentionMessage` branch in the existing `case MESSAGE_CUSTOM`; `broadcastAttentionEvent` / `sendAttentionEventTo`; `clearAttentionRequest`; per-`ws` `RateLimiter` WeakMap; `attentionRegistry` + `attentionExpiryTimers`; join snapshot in `addClient`; cleanup in `removeClient`; teardown in `dispose`. |
| `backend/test/m58-attention.test.ts` | **Create** | Pure-function tests + real-`CollaborationRoom` pipeline tests (auth, targeting, validation, rate limit, registry bounds, expiry, dismissal, disconnect, reconnect snapshot, project isolation, no-persistence, Yjs-convergence guard). |
| `frontend/src/collab/attention.ts` | **Create** | Pure: constants, wire types, `normalizeRange`, `rangesOverlap`, `parseAttentionEvent`; `AttentionStore` (Map + TTL timers + change emitter). |
| `frontend/src/collab/client.ts` | Modify | `sendAttentionPoint/Callout/Request`, `dismissAttentionRequest`, `getAttention`; `MESSAGE_CUSTOM` receive branch for `attention_event` / `attention_cleared`; `attentionStore` cleared in `resetLocalCollabState()` + `dispose()`. |
| `frontend/test/collab.attention.test.ts` | **Create** | `AttentionStore` lifecycle + TTL (fake timers); `rangesOverlap` / `normalizeRange` matrix; `parseAttentionEvent` guards; sender frame shape. |
| `frontend/src/components/Collab/AttentionTray.tsx` | **Create** | Bottom-right non-modal stack of incoming targeted-request cards + sender "✓ Sent" confirmation + overflow collapse. |
| `frontend/test/AttentionTray.test.tsx` | **Create** | Card render, Go there / Dismiss handlers, sender confirmation, collapse, text-only message. |
| `frontend/src/components/Editor/Editor.tsx` | Modify | Monaco actions (Point / Call out / Come look); point + callout decorations & message composer; three-tier spatial memo. |
| `frontend/src/components/Editor/AttentionComposer.tsx` | **Create** | Small absolute-positioned message input + (for "Come look") collaborator picker, anchored near the current selection. Not a modal. |
| `frontend/test/Editor.attention.test.tsx` | **Create** | Point/callout decorations, text-only bubble, closed-file open-before-reveal ordering, no model mutation. |
| `frontend/test/Editor.nearby.test.tsx` | **Create** | Three-tier spatial awareness; no awareness/doc writes. |
| `frontend/src/components/IDE/IDE.tsx` | Modify | `attention` throttled state; `handleAttentionNavigate` via `openAndRevealLocation`; retrofit `handleJumpToCollaborator`; render `<AttentionTray>`; thread props. |
| `frontend/test/IDE.attention.test.tsx` | **Create** (or extend an existing IDE test) | Navigation goes through open-then-reveal; retrofitted Jump; no full-tree re-render storm. |
| `frontend/src/components/Toolbar/Toolbar.tsx` | Modify | Thread `incomingRequestCount` prop to `CollaboratorAvatarStack`. |
| `frontend/src/components/Collab/CollaboratorAvatarStack.tsx` | Modify | Small badge on the existing `collab-count` chip; **preserve** the per-avatar quick popover and TeamPanel opening. |
| `frontend/test/CollaboratorAvatarStack.attention.test.tsx` | **Create** (or extend `CollaboratorAvatarStack.test.tsx`) | Badge shows only when count > 0; popover still present. |
| `frontend/src/styles/collab.css` | Modify | `.attention-point`, `.attention-callout-*`, `.attention-tray*`, `.attention-composer*`, `.spatial-*` — ambient, low-alpha, collaborator-colored, fade transitions. |
| `frontend/test/collab.follow.attention.test.tsx` | **Create** | Attention arriving mid-Follow does not break follow; navigating to attention interacts with follow like a manual open. |
| `STATUS.md` | Modify | New `## Milestone 58` section (final task). |

---

## Dependency graph

```
Phase 1 (pure backend domain)  ─┐
                                ├─> Phase 2 (backend room integration) ─┐
Phase 3 (pure frontend store) ──┘                                       │
        │                                                              │
        ├─> Phase 4 (IDE wiring) ─┬─> Phase 5 (Editor UX) ──┐          │
        │                         ├─> Phase 6 (AttentionTray)├─> Phase 7 (collaborator chip badge)
        │                         └─> Phase 4 also feeds ────┘          │
        └────────────────────────────────────────────────────> Phase 8 (security/lifecycle tests) <── Phase 2
                                                                        │
                                                        Phase 9 (browser verification) <── all
                                                                        │
                                                              Final task: STATUS.md
```

- **Phases 1 and 3 are independent** and may be done in parallel (different files, no shared state).
- **Phase 2 depends on Phase 1.** **Phase 4 depends on Phase 3.** **Phases 5, 6 depend on Phase 4.** **Phase 7 depends on Phases 4 + 6.**
- **Phase 8 depends on Phases 2 + 5 + 6** (it hardens the integrated paths).
- **Phase 9 depends on everything.**

---

## PHASE 1 — Pure backend protocol / domain logic

`backend/src/collab/attention.ts`. No `ws`, no `Y.Doc`, no timers except inside `RateLimiter` (which takes `now` as a parameter — no real clock). Everything here is unit-testable synchronously.

### Task 1: Range normalization + overlap

**Files:**
- Create: `backend/src/collab/attention.ts`
- Test: `backend/test/m58-attention.test.ts`

**Interfaces:**
- Consumes: `isAwarenessCoord` from `./presence.js` (finite, `0 ≤ n ≤ 5_000_000`).
- Produces:
  - `export interface AttentionRange { startLine: number; startColumn: number; endLine: number; endColumn: number; }`
  - `export function normalizeRange(v: unknown): AttentionRange | null` — every coord through `isAwarenessCoord`; returns `null` when any coord is missing/non-finite/out of range, or when `(startLine, startColumn)` is strictly after `(endLine, endColumn)` (reversed input is **rejected, not swapped**). A zero-width range (`start === end`) is valid.
  - `export function rangesOverlap(a: AttentionRange, b: AttentionRange): boolean` — assumes both already normalized. Interval semantics: line interval `[startLine, endLine]` inclusive; on a shared single line, column intervals `[startColumn, endColumn)` half-open, so touching (`aEnd === bStart`) is **not** overlap. A zero-width range at column `c` overlaps `[s, e)` iff `s ≤ c < e`; two zero-width ranges overlap iff identical position.

- [ ] **Step 1: Write the failing tests**

```ts
// backend/test/m58-attention.test.ts
import { describe, it, expect } from "vitest";
import { normalizeRange, rangesOverlap } from "../src/collab/attention.js";

const R = (sl: number, sc: number, el: number, ec: number) => ({
  startLine: sl, startColumn: sc, endLine: el, endColumn: ec,
});

describe("M58 — normalizeRange", () => {
  it("passes an ordered range through unchanged", () => {
    expect(normalizeRange(R(40, 1, 52, 1))).toEqual(R(40, 1, 52, 1));
  });
  it("accepts a zero-width cursor range", () => {
    expect(normalizeRange(R(10, 5, 10, 5))).toEqual(R(10, 5, 10, 5));
  });
  it("rejects a reversed range (does not swap)", () => {
    expect(normalizeRange(R(52, 1, 40, 1))).toBeNull();
    expect(normalizeRange(R(10, 9, 10, 3))).toBeNull();
  });
  it("rejects non-finite / negative / out-of-range coords", () => {
    expect(normalizeRange(R(NaN, 1, 2, 1))).toBeNull();
    expect(normalizeRange(R(1, 1, Infinity, 1))).toBeNull();
    expect(normalizeRange(R(-1, 1, 2, 1))).toBeNull();
    expect(normalizeRange(R(1, 1, 9_000_000, 1))).toBeNull();
  });
  it("rejects a non-object / missing keys", () => {
    expect(normalizeRange(null)).toBeNull();
    expect(normalizeRange({ startLine: 1 })).toBeNull();
    expect(normalizeRange("x")).toBeNull();
  });
});

describe("M58 — rangesOverlap", () => {
  it("different, non-touching line spans do not overlap", () => {
    expect(rangesOverlap(R(40, 1, 50, 1), R(100, 1, 120, 1))).toBe(false);
  });
  it("shared interior lines overlap", () => {
    expect(rangesOverlap(R(40, 1, 50, 1), R(45, 1, 60, 1))).toBe(true);
  });
  it("same single line, overlapping columns overlap", () => {
    expect(rangesOverlap(R(5, 2, 5, 10), R(5, 8, 5, 20))).toBe(true);
  });
  it("same single line, touching columns do NOT overlap", () => {
    expect(rangesOverlap(R(5, 2, 5, 10), R(5, 10, 5, 20))).toBe(false);
  });
  it("same single line, disjoint columns do not overlap", () => {
    expect(rangesOverlap(R(5, 2, 5, 6), R(5, 12, 5, 20))).toBe(false);
  });
  it("identical ranges overlap", () => {
    expect(rangesOverlap(R(40, 1, 52, 1), R(40, 1, 52, 1))).toBe(true);
  });
  it("zero-width cursor inside a range overlaps", () => {
    expect(rangesOverlap(R(5, 5, 5, 5), R(5, 2, 5, 10))).toBe(true);
  });
  it("zero-width cursor at the exclusive end does not overlap", () => {
    expect(rangesOverlap(R(5, 10, 5, 10), R(5, 2, 5, 10))).toBe(false);
  });
  it("two identical zero-width cursors overlap", () => {
    expect(rangesOverlap(R(5, 5, 5, 5), R(5, 5, 5, 5))).toBe(true);
  });
  it("multi-line ranges that share only the boundary line overlap when columns allow", () => {
    expect(rangesOverlap(R(1, 1, 10, 5), R(10, 3, 20, 1))).toBe(true);
    expect(rangesOverlap(R(1, 1, 10, 3), R(10, 3, 20, 1))).toBe(false);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd backend && npx vitest run test/m58-attention.test.ts`
Expected: FAIL — `Cannot find module '../src/collab/attention.js'`.

- [ ] **Step 3: Implement**

```ts
// backend/src/collab/attention.ts
//
// M58: transient ATTENTION layer. Pure domain logic only — no ws, no Y.Doc,
// no real clock. CollaborationRoom (manager.ts) owns transport, timers, and
// the authenticated session; this module owns validation, server-authoritative
// event construction, opaque IDs, rate limiting, and the bounded request
// registry policy.
//
// Keep the constants below in sync with frontend/src/collab/attention.ts.

import { randomBytes } from "node:crypto";
import { isAwarenessCoord, sanitizeAwarenessFilePath } from "./presence.js";

export const ATTENTION_MAX_MESSAGE_LEN = 280;
export const ATTENTION_POINT_TTL_MS = 6_000;
export const ATTENTION_CALLOUT_TTL_MS = 45_000;
export const ATTENTION_CALLOUT_MAX_TTL_MS = 90_000;
export const ATTENTION_REQUEST_TTL_MS = 120_000;
export const ATTENTION_RATE_WINDOW_MS = 10_000;
export const ATTENTION_MAX_EVENTS_PER_WINDOW = 10;
export const ATTENTION_MAX_OUTSTANDING_REQUESTS = 3;
export const ATTENTION_MAX_REGISTRY_ENTRIES = 200;
export const RANGE_NEAR_LINES = 5;

export interface AttentionRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

function beforeOrEqual(
  aL: number,
  aC: number,
  bL: number,
  bC: number,
): boolean {
  return aL < bL || (aL === bL && aC <= bC);
}

export function normalizeRange(v: unknown): AttentionRange | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const { startLine, startColumn, endLine, endColumn } = r;
  if (
    !isAwarenessCoord(startLine) ||
    !isAwarenessCoord(startColumn) ||
    !isAwarenessCoord(endLine) ||
    !isAwarenessCoord(endColumn)
  ) {
    return null;
  }
  if (!beforeOrEqual(startLine, startColumn, endLine, endColumn)) return null;
  return { startLine, startColumn, endLine, endColumn };
}

export function rangesOverlap(a: AttentionRange, b: AttentionRange): boolean {
  // No shared line at all.
  if (a.endLine < b.startLine || b.endLine < a.startLine) return false;
  // Any shared interior line (strictly between both spans' first/last) means
  // a full line is common → overlap regardless of columns.
  const sharedStart = Math.max(a.startLine, b.startLine);
  const sharedEnd = Math.min(a.endLine, b.endLine);
  if (sharedEnd - sharedStart >= 1) return true;
  // Exactly one shared line. Reduce each range to its column interval ON that
  // line: if the range starts before this line, it covers column 1..∞ up to
  // its own end; if it ends after this line, it covers its own start..∞.
  const line = sharedStart; // === sharedEnd
  const aFrom = a.startLine < line ? 1 : a.startColumn;
  const aTo = a.endLine > line ? Number.POSITIVE_INFINITY : a.endColumn;
  const bFrom = b.startLine < line ? 1 : b.startColumn;
  const bTo = b.endLine > line ? Number.POSITIVE_INFINITY : b.endColumn;
  const zeroWidthA = aFrom === aTo;
  const zeroWidthB = bFrom === bTo;
  if (zeroWidthA && zeroWidthB) return aFrom === bFrom;
  if (zeroWidthA) return bFrom <= aFrom && aFrom < bTo;
  if (zeroWidthB) return aFrom <= bFrom && bFrom < aTo;
  // Two positive-width half-open intervals [from, to).
  return aFrom < bTo && bFrom < aTo;
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd backend && npx vitest run test/m58-attention.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Stage for review** (do NOT commit)

```bash
git add backend/src/collab/attention.ts backend/test/m58-attention.test.ts
```

**Review checkpoint:** `normalizeRange` rejects (never swaps) reversed ranges; `rangesOverlap` treats touching column boundaries as non-overlapping and a zero-width cursor at the exclusive end as non-overlapping. **Rollback point:** delete `backend/src/collab/attention.ts` and the new test file — nothing else imports them yet.

---

### Task 2: Message sanitization + opaque ID + input parsing

**Files:**
- Modify: `backend/src/collab/attention.ts`
- Modify: `backend/test/m58-attention.test.ts`

**Interfaces:**
- Consumes: `sanitizeAwarenessFilePath` from `./presence.js`; `normalizeRange` (Task 1).
- Produces:
  - `export function sanitizeAttentionMessage(v: unknown): string` — non-string → `""`; else replace every C0 control char (incl. NUL/TAB/CR/LF) and DEL with a space, collapse `\s+` → ` `, trim, slice to `ATTENTION_MAX_MESSAGE_LEN`. Returns `""` when nothing survives.
  - `export function newAttentionId(): string` — 16 hex chars from `randomBytes(8)` (opaque, unguessable, not derived from any identity).
  - `export type AttentionKind = "point" | "callout" | "request";`
  - `export type AttentionInput = { kind: "point"; file: string; range: AttentionRange } | { kind: "callout"; file: string; range: AttentionRange; message: string } | { kind: "request"; targetUserId: number; file: string; range: AttentionRange; message: string };`
  - `export function parseAttentionInput(raw: unknown): AttentionInput | null` — maps wire `type` (`attention_point`/`attention_callout`/`attention_request`) to `kind`; validates `file` via `sanitizeAwarenessFilePath` (must be a non-null string), `range` via `normalizeRange`; for callout/request requires `sanitizeAttentionMessage(raw.message)` non-empty; for request requires `Number.isInteger(raw.targetUserId)`. Returns `null` on any failure. **Does not** check target membership or identity — that is the room's job. Never throws.

- [ ] **Step 1: Write the failing tests**

```ts
// append to backend/test/m58-attention.test.ts
import {
  sanitizeAttentionMessage,
  newAttentionId,
  parseAttentionInput,
} from "../src/collab/attention.js";

describe("M58 — sanitizeAttentionMessage", () => {
  it("trims, collapses whitespace, strips control chars", () => {
    expect(sanitizeAttentionMessage("  the\n\trace is here  ")).toBe(
      "the race is here",
    );
  });
  it("caps at 280 chars", () => {
    expect(sanitizeAttentionMessage("x".repeat(500))).toHaveLength(280);
  });
  it("returns empty for non-strings and whitespace-only", () => {
    expect(sanitizeAttentionMessage(42)).toBe("");
    expect(sanitizeAttentionMessage(null)).toBe("");
    expect(sanitizeAttentionMessage("   \n\t ")).toBe("");
  });
});

describe("M58 — newAttentionId", () => {
  it("is 16 lowercase hex chars", () => {
    expect(newAttentionId()).toMatch(/^[0-9a-f]{16}$/);
  });
  it("does not collide across 5000 calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(newAttentionId());
    expect(seen.size).toBe(5000);
  });
});

describe("M58 — parseAttentionInput", () => {
  const range = { startLine: 40, startColumn: 1, endLine: 52, endColumn: 1 };
  it("parses a valid point", () => {
    expect(
      parseAttentionInput({ type: "attention_point", file: "a/b.ts", range }),
    ).toEqual({ kind: "point", file: "a/b.ts", range });
  });
  it("parses a valid callout and cleans the message", () => {
    expect(
      parseAttentionInput({
        type: "attention_callout",
        file: "a/b.ts",
        range,
        message: "  race\nhere ",
      }),
    ).toEqual({ kind: "callout", file: "a/b.ts", range, message: "race here" });
  });
  it("parses a valid request", () => {
    expect(
      parseAttentionInput({
        type: "attention_request",
        targetUserId: 12,
        file: "a/b.ts",
        range,
        message: "look",
      }),
    ).toEqual({
      kind: "request",
      targetUserId: 12,
      file: "a/b.ts",
      range,
      message: "look",
    });
  });
  it("rejects an unknown type", () => {
    expect(parseAttentionInput({ type: "attention_zzz", file: "a", range })).toBeNull();
  });
  it("rejects a traversal / absolute file path", () => {
    expect(parseAttentionInput({ type: "attention_point", file: "../etc", range })).toBeNull();
    expect(parseAttentionInput({ type: "attention_point", file: "/etc/passwd", range })).toBeNull();
  });
  it("rejects a reversed range", () => {
    expect(
      parseAttentionInput({
        type: "attention_point",
        file: "a",
        range: { startLine: 9, startColumn: 1, endLine: 2, endColumn: 1 },
      }),
    ).toBeNull();
  });
  it("rejects a callout with an empty-after-clean message", () => {
    expect(
      parseAttentionInput({ type: "attention_callout", file: "a", range, message: "  \n " }),
    ).toBeNull();
  });
  it("rejects a request with a non-integer targetUserId", () => {
    expect(
      parseAttentionInput({ type: "attention_request", targetUserId: "12", file: "a", range, message: "x" }),
    ).toBeNull();
  });
  it("never throws on garbage", () => {
    expect(parseAttentionInput(null)).toBeNull();
    expect(parseAttentionInput(42)).toBeNull();
    expect(parseAttentionInput({ type: "attention_point" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd backend && npx vitest run test/m58-attention.test.ts`
Expected: FAIL — new exports undefined.

- [ ] **Step 3: Implement** (append to `attention.ts`)

```ts
function isControlChar(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

export function sanitizeAttentionMessage(v: unknown): string {
  if (typeof v !== "string") return "";
  let out = "";
  for (let i = 0; i < v.length; i++) {
    out += isControlChar(v.charCodeAt(i)) ? " " : v[i];
  }
  const s = out.replace(/\s+/g, " ").trim();
  return s.length > ATTENTION_MAX_MESSAGE_LEN
    ? s.slice(0, ATTENTION_MAX_MESSAGE_LEN)
    : s;
}

export function newAttentionId(): string {
  return randomBytes(8).toString("hex");
}

export type AttentionKind = "point" | "callout" | "request";

export type AttentionInput =
  | { kind: "point"; file: string; range: AttentionRange }
  | { kind: "callout"; file: string; range: AttentionRange; message: string }
  | {
      kind: "request";
      targetUserId: number;
      file: string;
      range: AttentionRange;
      message: string;
    };

const WIRE_TO_KIND: Record<string, AttentionKind> = {
  attention_point: "point",
  attention_callout: "callout",
  attention_request: "request",
};

export function parseAttentionInput(raw: unknown): AttentionInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = typeof r.type === "string" ? WIRE_TO_KIND[r.type] : undefined;
  if (!kind) return null;

  const file = sanitizeAwarenessFilePath(r.file);
  if (typeof file !== "string") return null;

  const range = normalizeRange(r.range);
  if (!range) return null;

  if (kind === "point") return { kind, file, range };

  const message = sanitizeAttentionMessage(r.message);
  if (!message) return null;

  if (kind === "callout") return { kind, file, range, message };

  if (!Number.isInteger(r.targetUserId)) return null;
  return { kind, targetUserId: r.targetUserId as number, file, range, message };
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd backend && npx vitest run test/m58-attention.test.ts`
Expected: PASS.

- [ ] **Step 5: Stage for review**

```bash
git add backend/src/collab/attention.ts backend/test/m58-attention.test.ts
```

**Review checkpoint:** `parseAttentionInput` performs zero identity/target-membership checks (room's job); `newAttentionId` uses `crypto`, not a counter. **Rollback point:** revert `attention.ts` to the Task 1 state.

---

### Task 3: Server-authoritative event construction

**Files:**
- Modify: `backend/src/collab/attention.ts`
- Modify: `backend/test/m58-attention.test.ts`

**Interfaces:**
- Consumes: `AttentionInput` (Task 2), constants (Task 1).
- Produces:
  - `export interface AttentionAuthor { userId: number; username: string; color: string }`
  - `export interface AttentionEvent { type: "attention_event"; id: string; kind: AttentionKind; author: AttentionAuthor; file: string; range: AttentionRange; message?: string; targetUserId?: number; createdAt: number; expiresAt: number; }`
  - `export type AttentionClearedReason = "dismissed" | "expired" | "acted" | "author_gone";`
  - `export interface AttentionClearedMsg { type: "attention_cleared"; id: string; reason: AttentionClearedReason; }`
  - `export function buildAttentionEvent(input: AttentionInput, author: AttentionAuthor, now: number): AttentionEvent` — `id = newAttentionId()`; `createdAt = now`; `expiresAt` = `now + ATTENTION_POINT_TTL_MS` (point) / `now + ATTENTION_CALLOUT_MAX_TTL_MS` (callout) / `now + ATTENTION_REQUEST_TTL_MS` (request). `author` is taken **only** from the `author` arg — nothing from `input`. `message`/`targetUserId` set only for the kinds that carry them. The returned object is built from scratch (never spreads `input`).

- [ ] **Step 1: Write the failing tests**

```ts
// append to backend/test/m58-attention.test.ts
import {
  buildAttentionEvent,
  ATTENTION_POINT_TTL_MS,
  ATTENTION_CALLOUT_MAX_TTL_MS,
  ATTENTION_REQUEST_TTL_MS,
} from "../src/collab/attention.js";

const author = { userId: 7, username: "rahul", color: "#89b4fa" };
const rng = { startLine: 40, startColumn: 1, endLine: 52, endColumn: 1 };

describe("M58 — buildAttentionEvent", () => {
  it("builds a point event with the point TTL and no message/target", () => {
    const e = buildAttentionEvent({ kind: "point", file: "a.ts", range: rng }, author, 1000);
    expect(e).toMatchObject({
      type: "attention_event",
      kind: "point",
      author,
      file: "a.ts",
      range: rng,
      createdAt: 1000,
      expiresAt: 1000 + ATTENTION_POINT_TTL_MS,
    });
    expect(e.message).toBeUndefined();
    expect(e.targetUserId).toBeUndefined();
    expect(e.id).toMatch(/^[0-9a-f]{16}$/);
  });
  it("builds a callout with the HARD ceiling TTL", () => {
    const e = buildAttentionEvent(
      { kind: "callout", file: "a.ts", range: rng, message: "race" }, author, 1000);
    expect(e.expiresAt).toBe(1000 + ATTENTION_CALLOUT_MAX_TTL_MS);
    expect(e.message).toBe("race");
  });
  it("builds a request with the request TTL and target", () => {
    const e = buildAttentionEvent(
      { kind: "request", targetUserId: 12, file: "a.ts", range: rng, message: "look" }, author, 1000);
    expect(e.expiresAt).toBe(1000 + ATTENTION_REQUEST_TTL_MS);
    expect(e.targetUserId).toBe(12);
  });
  it("ignores any author-like field smuggled through input", () => {
    const dirty = { kind: "point", file: "a.ts", range: rng, author: { userId: 999 }, id: "deadbeef" } as any;
    const e = buildAttentionEvent(dirty, author, 1000);
    expect(e.author).toEqual(author);
    expect(e.id).not.toBe("deadbeef");
  });
  it("two events built from the same input have different ids", () => {
    const mk = () => buildAttentionEvent({ kind: "point", file: "a.ts", range: rng }, author, 1000);
    expect(mk().id).not.toBe(mk().id);
  });
});
```

- [ ] **Step 2: Run — verify fail** → `cd backend && npx vitest run test/m58-attention.test.ts` → FAIL.

- [ ] **Step 3: Implement** (append)

```ts
export interface AttentionAuthor {
  userId: number;
  username: string;
  color: string;
}

export interface AttentionEvent {
  type: "attention_event";
  id: string;
  kind: AttentionKind;
  author: AttentionAuthor;
  file: string;
  range: AttentionRange;
  message?: string;
  targetUserId?: number;
  createdAt: number;
  expiresAt: number;
}

export type AttentionClearedReason =
  | "dismissed"
  | "expired"
  | "acted"
  | "author_gone";

export interface AttentionClearedMsg {
  type: "attention_cleared";
  id: string;
  reason: AttentionClearedReason;
}

const TTL_BY_KIND: Record<AttentionKind, number> = {
  point: ATTENTION_POINT_TTL_MS,
  callout: ATTENTION_CALLOUT_MAX_TTL_MS,
  request: ATTENTION_REQUEST_TTL_MS,
};

export function buildAttentionEvent(
  input: AttentionInput,
  author: AttentionAuthor,
  now: number,
): AttentionEvent {
  const event: AttentionEvent = {
    type: "attention_event",
    id: newAttentionId(),
    kind: input.kind,
    author: { userId: author.userId, username: author.username, color: author.color },
    file: input.file,
    range: input.range,
    createdAt: now,
    expiresAt: now + TTL_BY_KIND[input.kind],
  };
  if (input.kind === "callout" || input.kind === "request") {
    event.message = input.message;
  }
  if (input.kind === "request") {
    event.targetUserId = input.targetUserId;
  }
  return event;
}
```

- [ ] **Step 4: Run — verify pass** → PASS.

- [ ] **Step 5: Stage for review**

```bash
git add backend/src/collab/attention.ts backend/test/m58-attention.test.ts
```

**Review checkpoint:** callout `expiresAt` uses `ATTENTION_CALLOUT_MAX_TTL_MS` (90 s hard ceiling), not the 45 s client default; `author` and `id` come only from server args. **Rollback point:** revert to Task 2 state.

---

### Task 4: RateLimiter (token bucket / sliding window)

**Files:**
- Modify: `backend/src/collab/attention.ts`
- Modify: `backend/test/m58-attention.test.ts`

**Interfaces:**
- Produces:
  - `export class RateLimiter { constructor(windowMs: number, max: number); tryConsume(now: number): boolean; }` — keeps a bounded array of accept timestamps within `[now - windowMs, now]`; `tryConsume` prunes stale entries, returns `false` if `count >= max`, else records `now` and returns `true`. The internal array never exceeds `max` entries.

- [ ] **Step 1: Write the failing tests**

```ts
// append
import { RateLimiter } from "../src/collab/attention.js";

describe("M58 — RateLimiter", () => {
  it("allows up to `max` in a window then blocks", () => {
    const rl = new RateLimiter(10_000, 3);
    expect(rl.tryConsume(0)).toBe(true);
    expect(rl.tryConsume(1)).toBe(true);
    expect(rl.tryConsume(2)).toBe(true);
    expect(rl.tryConsume(3)).toBe(false);
    expect(rl.tryConsume(9_999)).toBe(false);
  });
  it("refills as the window slides", () => {
    const rl = new RateLimiter(10_000, 2);
    expect(rl.tryConsume(0)).toBe(true);
    expect(rl.tryConsume(5_000)).toBe(true);
    expect(rl.tryConsume(6_000)).toBe(false);
    expect(rl.tryConsume(10_001)).toBe(true); // first entry (t=0) expired
  });
  it("a burst of 50 in one window yields exactly `max` accepts", () => {
    const rl = new RateLimiter(10_000, 10);
    let ok = 0;
    for (let i = 0; i < 50; i++) if (rl.tryConsume(i)) ok++;
    expect(ok).toBe(10);
  });
});
```

- [ ] **Step 2: Run — verify fail** → FAIL.

- [ ] **Step 3: Implement** (append)

```ts
export class RateLimiter {
  private readonly hits: number[] = [];
  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  tryConsume(now: number): boolean {
    const cutoff = now - this.windowMs;
    while (this.hits.length > 0 && this.hits[0] <= cutoff) this.hits.shift();
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}
```

- [ ] **Step 4: Run — verify pass** → PASS.

- [ ] **Step 5: Stage for review**

```bash
git add backend/src/collab/attention.ts backend/test/m58-attention.test.ts
```

**Review checkpoint:** the `hits` array is bounded by `max` (pruned before the push). **Rollback point:** revert to Task 3 state.

---

### Task 5: AttentionRequestRegistry (bounded policy, no timers)

**Files:**
- Modify: `backend/src/collab/attention.ts`
- Modify: `backend/test/m58-attention.test.ts`

**Interfaces:**
- Consumes: `AttentionEvent` (Task 3), `ATTENTION_MAX_OUTSTANDING_REQUESTS`, `ATTENTION_MAX_REGISTRY_ENTRIES`.
- Produces:
  - `export class AttentionRequestRegistry` with:
    - `constructor(opts?: { maxPerAuthor?: number; maxEntries?: number })`
    - `tryAdd(event: AttentionEvent): { ok: true; evicted: AttentionEvent | null } | { ok: false; reason: "author_limit" }` — `event.kind` must be `"request"` with a `targetUserId`. Rejects with `author_limit` when the author already has `maxPerAuthor` entries. When at `maxEntries`, evicts the oldest by `createdAt` and returns it as `evicted`.
    - `get(id: string): AttentionEvent | undefined`
    - `delete(id: string): AttentionEvent | undefined`
    - `byTarget(userId: number): AttentionEvent[]` — non-expired filtering is the caller's job (registry has no clock).
    - `deleteByAuthor(userId: number): AttentionEvent[]`
    - `deleteByTarget(userId: number): AttentionEvent[]`
    - `get size(): number`
    - `clear(): void`

- [ ] **Step 1: Write the failing tests**

```ts
// append
import { AttentionRequestRegistry, buildAttentionEvent as be } from "../src/collab/attention.js";

const mkReq = (over: Partial<{ author: number; target: number; at: number }>) =>
  be(
    { kind: "request", targetUserId: over.target ?? 2, file: "a.ts", range: rng, message: "x" },
    { userId: over.author ?? 1, username: "u", color: "#111" },
    over.at ?? 0,
  );

describe("M58 — AttentionRequestRegistry", () => {
  it("adds and looks up by id and by target", () => {
    const reg = new AttentionRequestRegistry();
    const e = mkReq({ author: 1, target: 2 });
    expect(reg.tryAdd(e)).toEqual({ ok: true, evicted: null });
    expect(reg.get(e.id)).toBe(e);
    expect(reg.byTarget(2).map((x) => x.id)).toEqual([e.id]);
    expect(reg.byTarget(9)).toEqual([]);
  });
  it("enforces the per-author outstanding cap (drop the new one)", () => {
    const reg = new AttentionRequestRegistry({ maxPerAuthor: 3 });
    for (let i = 0; i < 3; i++) expect(reg.tryAdd(mkReq({ author: 1, at: i })).ok).toBe(true);
    expect(reg.tryAdd(mkReq({ author: 1, at: 4 }))).toEqual({ ok: false, reason: "author_limit" });
    expect(reg.size).toBe(3);
    // a different author is unaffected
    expect(reg.tryAdd(mkReq({ author: 5, at: 5 })).ok).toBe(true);
  });
  it("frees an author slot on delete", () => {
    const reg = new AttentionRequestRegistry({ maxPerAuthor: 1 });
    const e = mkReq({ author: 1, at: 0 });
    reg.tryAdd(e);
    expect(reg.tryAdd(mkReq({ author: 1, at: 1 })).ok).toBe(false);
    reg.delete(e.id);
    expect(reg.tryAdd(mkReq({ author: 1, at: 2 })).ok).toBe(true);
  });
  it("evicts the oldest when the room cap is hit", () => {
    const reg = new AttentionRequestRegistry({ maxPerAuthor: 99, maxEntries: 2 });
    const a = mkReq({ author: 1, at: 10 });
    const b = mkReq({ author: 2, at: 20 });
    reg.tryAdd(a);
    reg.tryAdd(b);
    const res = reg.tryAdd(mkReq({ author: 3, at: 30 }));
    expect(res).toEqual({ ok: true, evicted: a });
    expect(reg.get(a.id)).toBeUndefined();
    expect(reg.size).toBe(2);
  });
  it("deleteByAuthor / deleteByTarget return and remove matches", () => {
    const reg = new AttentionRequestRegistry();
    const a = mkReq({ author: 1, target: 2, at: 1 });
    const b = mkReq({ author: 1, target: 3, at: 2 });
    const c = mkReq({ author: 4, target: 2, at: 3 });
    [a, b, c].forEach((e) => reg.tryAdd(e));
    expect(reg.deleteByAuthor(1).map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
    expect(reg.size).toBe(1);
    expect(reg.deleteByTarget(2).map((e) => e.id)).toEqual([c.id]);
    expect(reg.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run — verify fail** → FAIL.

- [ ] **Step 3: Implement** (append)

```ts
interface RegistryAddOk { ok: true; evicted: AttentionEvent | null }
interface RegistryAddFail { ok: false; reason: "author_limit" }

export class AttentionRequestRegistry {
  private readonly byId = new Map<string, AttentionEvent>();
  private readonly maxPerAuthor: number;
  private readonly maxEntries: number;

  constructor(opts: { maxPerAuthor?: number; maxEntries?: number } = {}) {
    this.maxPerAuthor = opts.maxPerAuthor ?? ATTENTION_MAX_OUTSTANDING_REQUESTS;
    this.maxEntries = opts.maxEntries ?? ATTENTION_MAX_REGISTRY_ENTRIES;
  }

  private countByAuthor(userId: number): number {
    let n = 0;
    for (const e of this.byId.values()) if (e.author.userId === userId) n++;
    return n;
  }

  tryAdd(event: AttentionEvent): RegistryAddOk | RegistryAddFail {
    if (this.countByAuthor(event.author.userId) >= this.maxPerAuthor) {
      return { ok: false, reason: "author_limit" };
    }
    let evicted: AttentionEvent | null = null;
    if (this.byId.size >= this.maxEntries) {
      let oldest: AttentionEvent | null = null;
      for (const e of this.byId.values()) {
        if (!oldest || e.createdAt < oldest.createdAt) oldest = e;
      }
      if (oldest) {
        this.byId.delete(oldest.id);
        evicted = oldest;
      }
    }
    this.byId.set(event.id, event);
    return { ok: true, evicted };
  }

  get(id: string): AttentionEvent | undefined {
    return this.byId.get(id);
  }

  delete(id: string): AttentionEvent | undefined {
    const e = this.byId.get(id);
    if (e) this.byId.delete(id);
    return e;
  }

  byTarget(userId: number): AttentionEvent[] {
    const out: AttentionEvent[] = [];
    for (const e of this.byId.values()) {
      if (e.targetUserId === userId) out.push(e);
    }
    return out;
  }

  deleteByAuthor(userId: number): AttentionEvent[] {
    const removed: AttentionEvent[] = [];
    for (const e of [...this.byId.values()]) {
      if (e.author.userId === userId) {
        this.byId.delete(e.id);
        removed.push(e);
      }
    }
    return removed;
  }

  deleteByTarget(userId: number): AttentionEvent[] {
    const removed: AttentionEvent[] = [];
    for (const e of [...this.byId.values()]) {
      if (e.targetUserId === userId) {
        this.byId.delete(e.id);
        removed.push(e);
      }
    }
    return removed;
  }

  get size(): number {
    return this.byId.size;
  }

  clear(): void {
    this.byId.clear();
  }
}
```

- [ ] **Step 4: Run — verify pass** → PASS.

- [ ] **Step 5: Full Phase 1 regression + lint**

Run: `cd backend && npx vitest run test/m58-attention.test.ts && npx tsc --noEmit && npx eslint src/collab/attention.ts`
Expected: PASS, 0 errors.

- [ ] **Step 6: Stage for review**

```bash
git add backend/src/collab/attention.ts backend/test/m58-attention.test.ts
```

**Review checkpoint:** per-author cap rejects the *new* request (never evicts an existing one); room cap evicts the oldest by `createdAt`; registry holds no timers and no clock. **Rollback point:** revert `attention.ts` to Task 4 state — still unreferenced by `manager.ts`.

---

## PHASE 2 — Backend room integration (`CollaborationRoom`)

All changes are additive to `backend/src/collab/manager.ts`. Tests use the real `CollaborationRoom` + the `makeWs()` / `awarenessFrame()` helpers already in `backend/test/m57-presence.test.ts` — **copy those helpers verbatim** into `m58-attention.test.ts` (or `import` from a shared spot if the repo has one; it does not — copy is the convention here). Add a `customFrame(obj)` helper:

```ts
// in m58-attention.test.ts
import * as encoding from "lib0/encoding";
const MESSAGE_CUSTOM = 3;
function customFrame(obj: unknown): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_CUSTOM);
  encoding.writeVarString(enc, JSON.stringify(obj));
  return encoding.toUint8Array(enc);
}
function makeWs() {
  const sent: Uint8Array[] = [];
  return {
    readyState: 1,
    send: (d: Uint8Array) => sent.push(d),
    close: () => {},
    sent,
  } as any;
}
function customMessages(ws: any): any[] {
  // decode every MESSAGE_CUSTOM frame this ws received
  const out: any[] = [];
  for (const buf of ws.sent as Uint8Array[]) {
    try {
      const dec = decoding.createDecoder(buf);
      if (decoding.readVarUint(dec) !== MESSAGE_CUSTOM) continue;
      out.push(JSON.parse(decoding.readVarString(dec)));
    } catch {}
  }
  return out;
}
```

### Task 6: `handleAttentionMessage` — point + callout broadcast (no registry)

**Files:**
- Modify: `backend/src/collab/attention.ts` — add `export function fallbackUserColor(userId: number): string` (the same 8-colour Catppuccin palette + `Math.abs(userId) % 8` used by `frontend/src/collab/presence.ts:getUserColor`, so a point/callout carries a stable colour even before the author has published awareness).
- Modify: `backend/src/collab/manager.ts`
- Modify: `backend/test/m58-attention.test.ts`

**Interfaces:**
- Consumes: `parseAttentionInput`, `buildAttentionEvent`, `RateLimiter`, `fallbackUserColor`, `ATTENTION_RATE_WINDOW_MS`, `ATTENTION_MAX_EVENTS_PER_WINDOW`.
- Produces on `CollaborationRoom` (all `private` except where noted):
  - `private readonly attentionRateLimiters = new WeakMap<WebSocket, RateLimiter>()`
  - `private attentionRateLimiterFor(ws: WebSocket): RateLimiter`
  - `private authorFor(clientState: CollaboratorClientState): AttentionAuthor` — `{ userId, username, color }` where `color` = the first `#hex` `user.color` found among this connection's `awarenessClientIds` in `this.awareness.getStates()`, else `fallbackUserColor(userId)`.
  - `private handleAttentionMessage(ws: WebSocket, clientState: CollaboratorClientState, parsed: Record<string, unknown>): void`
  - `private broadcastAttention(obj: unknown, exceptWs?: WebSocket): void` (mirrors `broadcastRunStatus`)
- Wiring: inside `handleMessage`'s `case MESSAGE_CUSTOM`, after the existing `file_open` branch, add:
  ```ts
  else if (
    typeof parsed.type === "string" &&
    parsed.type.startsWith("attention_")
  ) {
    this.handleAttentionMessage(ws, clientState, parsed as Record<string, unknown>);
  }
  ```
  (Still inside the existing `try { JSON.parse } catch {}` — never throws.)

- [ ] **Step 1: Write the failing tests**

```ts
// append to m58-attention.test.ts — inside the "real room pipeline" describe
// (reuse the beforeEach/afterEach + makeRoom from the M57 test's room block)

it("broadcasts a valid point to peers but not the author", async () => {
  const room = makeRoom("p1");
  const wsA = makeWs(); const wsB = makeWs();
  await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
  await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });

  room.handleMessage(wsA, customFrame({
    type: "attention_point", file: "auth/session.ts",
    range: { startLine: 47, startColumn: 1, endLine: 47, endColumn: 1 },
  }));

  const toB = customMessages(wsB).filter((m) => m.type === "attention_event");
  expect(toB).toHaveLength(1);
  expect(toB[0]).toMatchObject({
    kind: "point", file: "auth/session.ts",
    author: { userId: 1, username: "alice" },
  });
  expect(toB[0].id).toMatch(/^[0-9a-f]{16}$/);
  expect(customMessages(wsA).filter((m) => m.type === "attention_event")).toHaveLength(0);
});

it("broadcasts a callout with a cleaned message and the 90s ceiling", async () => {
  const room = makeRoom("p1");
  const wsA = makeWs(); const wsB = makeWs();
  await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
  await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
  const t0 = Date.now();
  room.handleMessage(wsA, customFrame({
    type: "attention_callout", file: "a.ts",
    range: { startLine: 40, startColumn: 1, endLine: 52, endColumn: 1 },
    message: "  the\n\trace is here  ",
  }));
  const ev = customMessages(wsB).find((m) => m.type === "attention_event");
  expect(ev.message).toBe("the race is here");
  expect(ev.expiresAt - ev.createdAt).toBe(90_000);
  expect(ev.createdAt).toBeGreaterThanOrEqual(t0);
});

it("forces author identity — a spoofed author/userId in the payload is ignored", async () => {
  const room = makeRoom("p1");
  const wsA = makeWs(); const wsB = makeWs();
  await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
  await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
  room.handleMessage(wsA, customFrame({
    type: "attention_point", file: "a.ts", author: { userId: 999, username: "eve" },
    userId: 999, id: "cafebabecafebabe",
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
  }));
  const ev = customMessages(wsB).find((m) => m.type === "attention_event");
  expect(ev.author).toEqual({ userId: 1, username: "alice", color: expect.any(String) });
  expect(ev.id).not.toBe("cafebabecafebabe");
});

it("drops a malformed attention frame without throwing or broadcasting", async () => {
  const room = makeRoom("p1");
  const wsA = makeWs(); const wsB = makeWs();
  await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
  await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
  const before = room.doc.share.size;
  expect(() => {
    room.handleMessage(wsA, customFrame({ type: "attention_point", file: "../etc", range: {} }));
    room.handleMessage(wsA, customFrame({ type: "attention_callout", file: "a.ts", range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, message: "   " }));
    room.handleMessage(wsA, customFrame({ type: "attention_zzz" }));
  }).not.toThrow();
  expect(customMessages(wsB).filter((m) => m.type === "attention_event")).toHaveLength(0);
  expect(room.doc.share.size).toBe(before);
});

it("rate-limits at 10 events / 10s per connection (burst of 50 → 10 delivered)", async () => {
  const room = makeRoom("p1");
  const wsA = makeWs(); const wsB = makeWs();
  await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
  await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
  for (let i = 0; i < 50; i++) {
    room.handleMessage(wsA, customFrame({
      type: "attention_point", file: "a.ts",
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
    }));
  }
  expect(customMessages(wsB).filter((m) => m.type === "attention_event")).toHaveLength(10);
});
```

- [ ] **Step 2: Run — verify fail** → `cd backend && npx vitest run test/m58-attention.test.ts` → FAIL (handler absent, no broadcast).

- [ ] **Step 3: Implement in `attention.ts`** (`fallbackUserColor`)

```ts
const USER_COLORS = [
  "#89b4fa", "#a6e3a1", "#fab387", "#f38ba8",
  "#cba6f7", "#f9e2af", "#94e2d5", "#f5c2e7",
];
export function fallbackUserColor(userId: number): string {
  return USER_COLORS[Math.abs(userId) % USER_COLORS.length];
}
```

- [ ] **Step 4: Implement in `manager.ts`**

Add the import:
```ts
import {
  parseAttentionInput,
  buildAttentionEvent,
  fallbackUserColor,
  RateLimiter,
  AttentionRequestRegistry,
  type AttentionAuthor,
  type AttentionEvent,
  ATTENTION_RATE_WINDOW_MS,
  ATTENTION_MAX_EVENTS_PER_WINDOW,
  ATTENTION_REQUEST_TTL_MS,
} from "./attention.js";
```

Add fields to `CollaborationRoom` (near `runStatus`):
```ts
private readonly attentionRateLimiters = new WeakMap<WebSocket, RateLimiter>();
private readonly attentionRegistry = new AttentionRequestRegistry();
private readonly attentionExpiryTimers = new Map<string, NodeJS.Timeout>();
```

Add methods:
```ts
private attentionRateLimiterFor(ws: WebSocket): RateLimiter {
  let rl = this.attentionRateLimiters.get(ws);
  if (!rl) {
    rl = new RateLimiter(
      ATTENTION_RATE_WINDOW_MS,
      ATTENTION_MAX_EVENTS_PER_WINDOW,
    );
    this.attentionRateLimiters.set(ws, rl);
  }
  return rl;
}

private authorFor(clientState: CollaboratorClientState): AttentionAuthor {
  let color = fallbackUserColor(clientState.userId);
  const ids = clientState.awarenessClientIds;
  if (ids) {
    for (const cid of ids) {
      const st = this.awareness.getStates().get(cid) as
        | { user?: { color?: unknown } }
        | undefined;
      const c = st?.user?.color;
      if (typeof c === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c)) {
        color = c;
        break;
      }
    }
  }
  return {
    userId: clientState.userId,
    username: clientState.username,
    color,
  };
}

private broadcastAttention(obj: unknown, exceptWs?: WebSocket): void {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_CUSTOM);
  encoding.writeVarString(enc, JSON.stringify(obj));
  const frame = encoding.toUint8Array(enc);
  for (const [client] of this.clients.entries()) {
    if (client === exceptWs) continue;
    if (client.readyState !== 1) continue;
    try { client.send(frame); } catch {}
  }
}

private sendAttentionTo(userId: number, obj: unknown): void {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_CUSTOM);
  encoding.writeVarString(enc, JSON.stringify(obj));
  const frame = encoding.toUint8Array(enc);
  for (const [client, s] of this.clients.entries()) {
    if (s.userId !== userId) continue;
    if (client.readyState !== 1) continue;
    try { client.send(frame); } catch {}
  }
}

private handleAttentionMessage(
  ws: WebSocket,
  clientState: CollaboratorClientState,
  parsed: Record<string, unknown>,
): void {
  if (this.disposed) return;

  // attention_dismiss is handled in Task 8; ignore for now to keep this task
  // scoped. (Task 8 replaces this guard with the dismiss branch.)
  if (parsed.type === "attention_dismiss") return;

  if (!this.attentionRateLimiterFor(ws).tryConsume(Date.now())) return;

  const input = parseAttentionInput(parsed);
  if (!input) return;

  const now = Date.now();
  const author = this.authorFor(clientState);

  if (input.kind === "point" || input.kind === "callout") {
    const event = buildAttentionEvent(input, author, now);
    this.broadcastAttention(event, ws);
    return;
  }

  // input.kind === "request" — implemented in Task 7.
}
```

Wire the dispatch in `handleMessage`'s `case MESSAGE_CUSTOM` (right after the `file_open` `if` block, still inside the `try`):
```ts
} else if (
  typeof parsed.type === "string" &&
  parsed.type.startsWith("attention_")
) {
  this.handleAttentionMessage(
    ws,
    clientState,
    parsed as Record<string, unknown>,
  );
}
```

- [ ] **Step 5: Run — verify pass** → `cd backend && npx vitest run test/m58-attention.test.ts` → PASS.

- [ ] **Step 6: Regression** → `cd backend && npx vitest run test/collab-awareness-security.test.ts test/m57-presence.test.ts test/m4-collab.test.ts` → PASS, all unchanged.

- [ ] **Step 7: Typecheck** → `cd backend && npx tsc --noEmit` → 0 errors.

- [ ] **Step 8: Stage for review**

```bash
git add backend/src/collab/attention.ts backend/src/collab/manager.ts backend/test/m58-attention.test.ts
```

**Review checkpoint:** the dispatch is inside the existing `try/catch`; `handleAttentionMessage` returns early on `this.disposed`, on rate-limit, and on parse failure; points/callouts never touch the registry; the rate limiter is per-`ws` (Task 8 tests confirm multi-tab does not share a bucket — that is intentional per-connection, and the outstanding-request cap is the per-*user* backstop). **Rollback point:** remove the dispatch `else if` and the new methods/fields; `attention.ts` stays.

---

### Task 7: `attention_request` — targeting, registry, targeted delivery, author echo

**Files:**
- Modify: `backend/src/collab/manager.ts`
- Modify: `backend/test/m58-attention.test.ts`

**Interfaces:**
- Consumes: `AttentionRequestRegistry` (added in Task 6), `sendAttentionTo` (Task 6).
- Produces on `CollaborationRoom`:
  - `private isRoomMember(userId: number, exceptWs?: WebSocket): boolean` — true iff some **currently-connected** client in `this.clients` has that `userId` (optionally excluding one socket, used to reject self-target).
  - `private scheduleAttentionExpiry(event: AttentionEvent): void` — `setTimeout` at `event.expiresAt - Date.now()` (min 0) → `this.clearAttentionRequest(event.id, "expired")`; `timer.unref?.()`; stored in `attentionExpiryTimers`.
  - Extends `handleAttentionMessage`'s `request` branch:
    1. reject if `!this.isRoomMember(input.targetUserId)` or `input.targetUserId === clientState.userId` — silent (no frame).
    2. `const event = buildAttentionEvent(input, author, now)`.
    3. `const res = this.attentionRegistry.tryAdd(event)`.
    4. if `!res.ok` → send `{ type: "attention_rate_limited", scope: "outstanding_requests" }` **to the author only** (`sendAttentionTo(author.userId, …)`) and return. (Lightweight, transient — the client shows a brief "too many pending" state; no persistent error mechanism.)
    5. if `res.evicted` → `this.clearEvictedAttention(res.evicted)` (clears its timer + notifies its target `attention_cleared {expired}`).
    6. `this.scheduleAttentionExpiry(event)`.
    7. `this.sendAttentionTo(input.targetUserId, event)` **and** `this.sendAttentionTo(author.userId, event)` (author echo → the sender's "✓ Sent" confirmation). The echo is the same `attention_event`; the client distinguishes "mine" by `author.userId === myUserId`.

- [ ] **Step 1: Write the failing tests**

```ts
// append to the room-pipeline describe

it("delivers a request to the target and echoes it to the author", async () => {
  const room = makeRoom("p1");
  const wsA = makeWs(); const wsB = makeWs(); const wsC = makeWs();
  await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
  await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
  await room.addClient(wsC, { userId: 3, username: "cara", role: "editor" });

  room.handleMessage(wsA, customFrame({
    type: "attention_request", targetUserId: 2, file: "auth/session.ts",
    range: { startLine: 40, startColumn: 1, endLine: 52, endColumn: 1 },
    message: "I think the race is here.",
  }));

  const toB = customMessages(wsB).filter((m) => m.type === "attention_event");
  const toA = customMessages(wsA).filter((m) => m.type === "attention_event");
  const toC = customMessages(wsC).filter((m) => m.type === "attention_event");
  expect(toB).toHaveLength(1);
  expect(toB[0]).toMatchObject({ kind: "request", targetUserId: 2, message: "I think the race is here." });
  expect(toA).toHaveLength(1);            // author echo
  expect(toA[0].id).toBe(toB[0].id);
  expect(toC).toHaveLength(0);            // bystander sees nothing
});

it("drops a request to a non-member userId", async () => {
  const room = makeRoom("p1");
  const wsA = makeWs(); const wsB = makeWs();
  await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
  await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
  room.handleMessage(wsA, customFrame({
    type: "attention_request", targetUserId: 4242, file: "a.ts",
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, message: "x",
  }));
  expect(customMessages(wsB).filter((m) => m.type === "attention_event")).toHaveLength(0);
  expect(customMessages(wsA).filter((m) => m.type === "attention_event")).toHaveLength(0);
});

it("drops a self-targeted request", async () => {
  const room = makeRoom("p1");
  const wsA = makeWs();
  await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
  room.handleMessage(wsA, customFrame({
    type: "attention_request", targetUserId: 1, file: "a.ts",
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, message: "x",
  }));
  expect(customMessages(wsA).filter((m) => m.type === "attention_event")).toHaveLength(0);
});

it("rejects the 4th outstanding request from one author and tells only the author", async () => {
  const room = makeRoom("p1");
  const wsA = makeWs(); const wsB = makeWs();
  await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
  await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
  const send = () => room.handleMessage(wsA, customFrame({
    type: "attention_request", targetUserId: 2, file: "a.ts",
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, message: "x",
  }));
  send(); send(); send(); send();
  const events = customMessages(wsB).filter((m) => m.type === "attention_event");
  expect(events).toHaveLength(3);                       // only 3 delivered
  const limited = customMessages(wsA).filter((m) => m.type === "attention_rate_limited");
  expect(limited).toHaveLength(1);
  expect(limited[0].scope).toBe("outstanding_requests");
});
```

- [ ] **Step 2: Run — verify fail** → FAIL.

- [ ] **Step 3: Implement** (extend `handleAttentionMessage` + add the helpers described in Interfaces). `scheduleAttentionExpiry` and `clearAttentionRequest`/`clearEvictedAttention` bodies:

```ts
private scheduleAttentionExpiry(event: AttentionEvent): void {
  const delay = Math.max(0, event.expiresAt - Date.now());
  const timer = setTimeout(() => {
    this.attentionExpiryTimers.delete(event.id);
    this.clearAttentionRequest(event.id, "expired");
  }, delay);
  timer.unref?.();
  this.attentionExpiryTimers.set(event.id, timer);
}

// Full body lands in Task 8; a minimal version here is fine and Task 8's
// tests exercise the dismiss/notify paths.
private clearAttentionRequest(id: string, reason: AttentionClearedReason): void {
  const timer = this.attentionExpiryTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    this.attentionExpiryTimers.delete(id);
  }
  const event = this.attentionRegistry.delete(id);
  if (!event || event.targetUserId === undefined) return;
  const msg = { type: "attention_cleared", id, reason };
  this.sendAttentionTo(event.targetUserId, msg);
  this.sendAttentionTo(event.author.userId, msg);
}

private clearEvictedAttention(evicted: AttentionEvent): void {
  const timer = this.attentionExpiryTimers.get(evicted.id);
  if (timer) { clearTimeout(timer); this.attentionExpiryTimers.delete(evicted.id); }
  if (evicted.targetUserId !== undefined) {
    const msg = { type: "attention_cleared", id: evicted.id, reason: "expired" as const };
    this.sendAttentionTo(evicted.targetUserId, msg);
    this.sendAttentionTo(evicted.author.userId, msg);
  }
}

private isRoomMember(userId: number, exceptWs?: WebSocket): boolean {
  for (const [client, s] of this.clients.entries()) {
    if (client === exceptWs) continue;
    if (s.userId === userId) return true;
  }
  return false;
}
```

Add `import { type AttentionClearedReason } from "./attention.js";`.

- [ ] **Step 4: Run — verify pass** → PASS.

- [ ] **Step 5: Regression** → `cd backend && npx vitest run test/m57-presence.test.ts test/collab-awareness-security.test.ts` → PASS unchanged.

- [ ] **Step 6: Stage for review**

```bash
git add backend/src/collab/manager.ts backend/test/m58-attention.test.ts
```

**Review checkpoint:** target must be a currently-connected member of *this* room; self-target rejected; 4th request rejected (not the oldest); the `attention_rate_limited` notice goes only to the author and is transient. **Rollback point:** revert the `request` branch + helpers; point/callout still work.

---

### Task 8: Dismiss / acted authorization + expiry firing

**Files:**
- Modify: `backend/src/collab/manager.ts`
- Modify: `backend/test/m58-attention.test.ts`

**Interfaces:**
- Produces: `handleAttentionMessage` gains an `attention_dismiss` branch (replacing the Task 6 early `return`):
  ```ts
  if (parsed.type === "attention_dismiss") {
    const id = typeof parsed.id === "string" ? parsed.id : null;
    if (!id) return;
    const event = this.attentionRegistry.get(id);
    // Authorization: the entry must exist AND target the dismisser's user.
    if (!event || event.targetUserId !== clientState.userId) return;
    const reason: AttentionClearedReason =
      parsed.acted === true ? "acted" : "dismissed";
    this.clearAttentionRequest(id, reason);
    return;
  }
  ```
  Note: `attention_dismiss` is **not** rate-limited (it is a de-escalation; still bounded because it only ever clears one existing entry).

- [ ] **Step 1: Write the failing tests**

```ts
it("lets the target dismiss its own request and notifies both sides", async () => {
  const room = makeRoom("p1");
  const wsA = makeWs(); const wsB = makeWs();
  await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
  await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
  room.handleMessage(wsA, customFrame({
    type: "attention_request", targetUserId: 2, file: "a.ts",
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, message: "x",
  }));
  const id = customMessages(wsB).find((m) => m.type === "attention_event").id;

  room.handleMessage(wsB, customFrame({ type: "attention_dismiss", id }));

  const clearedB = customMessages(wsB).filter((m) => m.type === "attention_cleared");
  const clearedA = customMessages(wsA).filter((m) => m.type === "attention_cleared");
  expect(clearedB.at(-1)).toMatchObject({ id, reason: "dismissed" });
  expect(clearedA.at(-1)).toMatchObject({ id, reason: "dismissed" });
});

it("marks reason 'acted' when acted:true", async () => {
  const room = makeRoom("p1");
  const wsA = makeWs(); const wsB = makeWs();
  await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
  await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
  room.handleMessage(wsA, customFrame({
    type: "attention_request", targetUserId: 2, file: "a.ts",
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, message: "x",
  }));
  const id = customMessages(wsB).find((m) => m.type === "attention_event").id;
  room.handleMessage(wsB, customFrame({ type: "attention_dismiss", id, acted: true }));
  expect(customMessages(wsB).filter((m) => m.type === "attention_cleared").at(-1).reason).toBe("acted");
});

it("ignores a dismiss from a non-target (no clearing another user's request by guessing an id)", async () => {
  const room = makeRoom("p1");
  const wsA = makeWs(); const wsB = makeWs(); const wsC = makeWs();
  await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
  await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
  await room.addClient(wsC, { userId: 3, username: "cara", role: "editor" });
  room.handleMessage(wsA, customFrame({
    type: "attention_request", targetUserId: 2, file: "a.ts",
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, message: "x",
  }));
  const id = customMessages(wsB).find((m) => m.type === "attention_event").id;
  const beforeC = customMessages(wsC).length;
  room.handleMessage(wsC, customFrame({ type: "attention_dismiss", id }));           // cara is not the target
  room.handleMessage(wsA, customFrame({ type: "attention_dismiss", id }));           // author is not the target
  room.handleMessage(wsB, customFrame({ type: "attention_dismiss", id: "0000000000000000" })); // wrong id
  expect(customMessages(wsC).length).toBe(beforeC);
  // still deliverable — the entry survived all three
  expect(room.hasAttentionRequest(id)).toBe(true); // test-only helper, see Step 3
});

it("expires a request after ATTENTION_REQUEST_TTL_MS and never re-delivers", async () => {
  vi.useFakeTimers();
  try {
    const room = makeRoom("p1");
    const wsA = makeWs(); const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    room.handleMessage(wsA, customFrame({
      type: "attention_request", targetUserId: 2, file: "a.ts",
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, message: "x",
    }));
    const id = customMessages(wsB).find((m) => m.type === "attention_event").id;
    vi.advanceTimersByTime(120_000 - 1);
    expect(customMessages(wsB).some((m) => m.type === "attention_cleared")).toBe(false);
    vi.advanceTimersByTime(2);
    expect(customMessages(wsB).filter((m) => m.type === "attention_cleared").at(-1)).toMatchObject({ id, reason: "expired" });
    expect(room.hasAttentionRequest(id)).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
```

- [ ] **Step 2: Run — verify fail** → FAIL (and `room.hasAttentionRequest` undefined).

- [ ] **Step 3: Implement**
- Add the `attention_dismiss` branch (Interfaces block).
- Add a small test-support accessor on `CollaborationRoom` (kept minimal, no state exposure): `public hasAttentionRequest(id: string): boolean { return this.attentionRegistry.get(id) !== undefined; }` — analogous to how the room already exposes `getBroadcastSendCount()` for observability.

- [ ] **Step 4: Run — verify pass** → PASS.

- [ ] **Step 5: Stage for review**

```bash
git add backend/src/collab/manager.ts backend/test/m58-attention.test.ts
```

**Review checkpoint:** dismiss authorization checks *both* existence and `targetUserId === dismisser`; a wrong / guessed id is a no-op; expiry fires exactly once at `expiresAt` and deletes. **Rollback point:** revert the dismiss branch + `hasAttentionRequest`.

---

### Task 9: Join snapshot, disconnect cleanup, dispose teardown, project isolation

**Files:**
- Modify: `backend/src/collab/manager.ts`
- Modify: `backend/test/m58-attention.test.ts`

**Interfaces:**
- `addClient` — after the existing step 3 (run-status snapshot) and step 4 (destructive notice), add step 5:
  ```ts
  // M58: replay ONLY currently-valid targeted requests aimed at THIS user.
  const now = Date.now();
  for (const event of this.attentionRegistry.byTarget(clientState.userId)) {
    if (event.expiresAt <= now) continue;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_CUSTOM);
    encoding.writeVarString(enc, JSON.stringify(event));
    try { ws.send(encoding.toUint8Array(enc)); } catch {}
  }
  ```
- `removeClient` — after the awareness-state removal block, add:
  ```ts
  // M58: an author leaving withdraws their outstanding requests; a target
  // leaving drops requests aimed at them (never persisted, never replayed).
  if (clientState) {
    for (const e of this.attentionRegistry.deleteByAuthor(clientState.userId)) {
      const t = this.attentionExpiryTimers.get(e.id);
      if (t) { clearTimeout(t); this.attentionExpiryTimers.delete(e.id); }
      if (e.targetUserId !== undefined) {
        this.sendAttentionTo(e.targetUserId, {
          type: "attention_cleared", id: e.id, reason: "author_gone",
        });
      }
    }
    for (const e of this.attentionRegistry.deleteByTarget(clientState.userId)) {
      const t = this.attentionExpiryTimers.get(e.id);
      if (t) { clearTimeout(t); this.attentionExpiryTimers.delete(e.id); }
    }
  }
  ```
  **Ordering note:** this must run **before** `if (this.clients.size === 0) this.scheduleIdleDisposal()` and after `this.clients.delete(ws)` (so the leaver is not counted as a member).
- `dispose` — after the run-status teardown block:
  ```ts
  // M58: attention teardown.
  for (const t of this.attentionExpiryTimers.values()) clearTimeout(t);
  this.attentionExpiryTimers.clear();
  this.attentionRegistry.clear();
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it("reconnecting target receives only its still-valid requests; bystander gets none", async () => {
  const room = makeRoom("p1");
  const wsA = makeWs(); const wsB = makeWs();
  await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
  await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
  room.handleMessage(wsA, customFrame({
    type: "attention_request", targetUserId: 2, file: "auth/session.ts",
    range: { startLine: 40, startColumn: 1, endLine: 52, endColumn: 1 }, message: "look",
  }));
  const id = customMessages(wsB).find((m) => m.type === "attention_event").id;

  room.removeClient(wsB);                      // bob drops
  // (author stays; target-leave cleanup deletes bob's inbound request)
  const wsB2 = makeWs();
  await room.addClient(wsB2, { userId: 2, username: "bob", role: "editor" });
  expect(customMessages(wsB2).filter((m) => m.type === "attention_event")).toHaveLength(0);
});

it("author reconnect does NOT resurrect a request they sent before dropping", async () => {
  const room = makeRoom("p1");
  const wsA = makeWs(); const wsB = makeWs();
  await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
  await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
  room.handleMessage(wsA, customFrame({
    type: "attention_request", targetUserId: 2, file: "a.ts",
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, message: "x",
  }));
  room.removeClient(wsA);                      // alice drops → author_gone to bob
  expect(customMessages(wsB).filter((m) => m.type === "attention_cleared").at(-1)).toMatchObject({ reason: "author_gone" });
  const wsA2 = makeWs();
  await room.addClient(wsA2, { userId: 1, username: "alice", role: "editor" });
  expect(customMessages(wsB).filter((m) => m.type === "attention_event")).toHaveLength(1); // unchanged
});

it("snapshots a still-valid request to a target that reconnects while the AUTHOR is still present and the entry survived", async () => {
  // author leaving clears the entry, so to prove the snapshot path we keep the
  // author connected and simulate ONLY the target reconnecting via a 2nd tab
  // BEFORE the target-leave cleanup — i.e. a fresh connection for an
  // already-present user. That is exactly the multi-tab / quick-reconnect case.
  const room = makeRoom("p1");
  const wsA = makeWs(); const wsB = makeWs();
  await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
  await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
  room.handleMessage(wsA, customFrame({
    type: "attention_request", targetUserId: 2, file: "auth/session.ts",
    range: { startLine: 40, startColumn: 1, endLine: 52, endColumn: 1 }, message: "look",
  }));
  const id = customMessages(wsB).find((m) => m.type === "attention_event").id;

  const wsB2 = makeWs();                       // bob opens a second tab
  await room.addClient(wsB2, { userId: 2, username: "bob", role: "editor" });
  const snap = customMessages(wsB2).filter((m) => m.type === "attention_event");
  expect(snap).toHaveLength(1);
  expect(snap[0].id).toBe(id);
});

it("does not replay an expired request on reconnect", async () => {
  vi.useFakeTimers();
  try {
    const room = makeRoom("p1");
    const wsA = makeWs(); const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    room.handleMessage(wsA, customFrame({
      type: "attention_request", targetUserId: 2, file: "a.ts",
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, message: "x",
    }));
    vi.advanceTimersByTime(120_001);            // expired + cleared
    const wsB2 = makeWs();
    await room.addClient(wsB2, { userId: 2, username: "bob", role: "editor" });
    expect(customMessages(wsB2).filter((m) => m.type === "attention_event")).toHaveLength(0);
  } finally { vi.useRealTimers(); }
});

it("project isolation — room B never sees room A's attention", async () => {
  const roomA = makeRoom("pA"); const roomB = makeRoom("pB");
  const a1 = makeWs(); const a2 = makeWs(); const b1 = makeWs();
  await roomA.addClient(a1, { userId: 1, username: "alice", role: "editor" });
  await roomA.addClient(a2, { userId: 2, username: "bob", role: "editor" });
  await roomB.addClient(b1, { userId: 3, username: "cara", role: "editor" });
  roomA.handleMessage(a1, customFrame({
    type: "attention_point", file: "a.ts",
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
  }));
  roomA.handleMessage(a1, customFrame({
    type: "attention_request", targetUserId: 2, file: "a.ts",
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, message: "x",
  }));
  expect(customMessages(b1).filter((m) => String(m.type).startsWith("attention_"))).toHaveLength(0);
});

it("dispose clears all attention expiry timers and the registry", async () => {
  const room = makeRoom("p1");
  const wsA = makeWs(); const wsB = makeWs();
  await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
  await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
  room.handleMessage(wsA, customFrame({
    type: "attention_request", targetUserId: 2, file: "a.ts",
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, message: "x",
  }));
  const id = customMessages(wsB).find((m) => m.type === "attention_event").id;
  room.dispose();
  expect(room.hasAttentionRequest(id)).toBe(false);
});

it("no persistence — a full point/callout/request cycle writes no Y.Doc keys", async () => {
  const room = makeRoom("p1");
  const wsA = makeWs(); const wsB = makeWs();
  await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
  await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
  const before = room.doc.share.size;
  room.handleMessage(wsA, customFrame({ type: "attention_point", file: "a.ts", range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 } }));
  room.handleMessage(wsA, customFrame({ type: "attention_callout", file: "a.ts", range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, message: "hi" }));
  room.handleMessage(wsA, customFrame({ type: "attention_request", targetUserId: 2, file: "a.ts", range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, message: "hi" }));
  expect(room.doc.share.size).toBe(before);
});

it("concurrent Yjs edits still converge with attention frames interleaved", async () => {
  const room = makeRoom("p1");
  const wsA = makeWs(); const wsB = makeWs();
  await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
  await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });

  // two independent client docs, synced through the room like m4-collab does
  const docA = new Y.Doc(); const docB = new Y.Doc();
  const applyToRoom = (u: Uint8Array, from: any) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0 /* MESSAGE_SYNC */);
    syncProtocol.writeUpdate(enc, u);
    room.handleMessage(from, encoding.toUint8Array(enc));
  };
  docA.getText("f.ts").insert(0, "AAAA");
  applyToRoom(Y.encodeStateAsUpdate(docA), wsA);
  room.handleMessage(wsA, customFrame({ type: "attention_point", file: "f.ts", range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 } }));
  docB.getText("f.ts").insert(0, "BB");
  applyToRoom(Y.encodeStateAsUpdate(docB), wsB);

  Y.applyUpdate(docA, Y.encodeStateAsUpdate(room.doc));
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(room.doc));
  expect(docA.getText("f.ts").toString()).toBe(room.doc.getText("f.ts").toString());
  expect(docB.getText("f.ts").toString()).toBe(room.doc.getText("f.ts").toString());
  expect(room.doc.getText("f.ts").toString()).toContain("AAAA");
  expect(room.doc.getText("f.ts").toString()).toContain("BB");
});
```

- [ ] **Step 2: Run — verify fail** → FAIL.

- [ ] **Step 3: Implement** the three hook-site edits (Interfaces block).

- [ ] **Step 4: Run — verify pass** → `cd backend && npx vitest run test/m58-attention.test.ts` → PASS (all Phase 1 + 2).

- [ ] **Step 5: Full backend collab regression**

Run: `cd backend && npx vitest run test/m4-collab.test.ts test/collab-awareness-security.test.ts test/m57-presence.test.ts test/m6-collab-coalesce-backpressure.test.ts test/m41-dispose-guards.test.ts test/m56-collaboration-safe-mutations.test.ts`
Expected: PASS — all unchanged.

- [ ] **Step 6: Full backend suite + typecheck + lint**

Run: `cd backend && npx vitest run && npx tsc --noEmit && npx eslint src/`
Expected: **804 + new** passed / 0 failed / 9 skipped; 0 type errors; 0 lint errors.

- [ ] **Step 7: Stage for review**

```bash
git add backend/src/collab/manager.ts backend/test/m58-attention.test.ts
```

**Review checkpoint:** the `removeClient` cleanup runs after `this.clients.delete(ws)` and before `scheduleIdleDisposal()`; author-leave notifies the target `author_gone`; target-leave is silent; the join snapshot skips expired entries and only sends `byTarget(thisUser)`; `dispose` clears every timer. **Rollback point:** revert the three hook-site edits — the handler still works for live clients, just without cleanup/snapshot.

---

## PHASE 3 — Client attention store (`frontend/src/collab/attention.ts`)

Pure module + `AttentionStore`. Parallel-safe with Phases 1–2 (different package). Frontend tests: `frontend/test/collab.attention.test.ts`, jsdom, `vi.useFakeTimers()`.

### Task 10: Pure wire types + range helpers (frontend mirror)

**Files:**
- Create: `frontend/src/collab/attention.ts`
- Test: `frontend/test/collab.attention.test.ts`

**Interfaces:**
- Produces (types mirror the backend `AttentionEvent`/`AttentionClearedMsg` **minus** the `type` discriminant already consumed by the transport switch — keep `type` on the wire objects but the store holds `StoredAttention`):
  - constants block (identical values to the backend — §"Shared constants")
  - `export type AttentionKind = "point" | "callout" | "request";`
  - `export interface AttentionRange { startLine; startColumn; endLine; endColumn; }` (all `number`)
  - `export interface AttentionEvent { id: string; kind: AttentionKind; author: { userId: number; username: string; color: string }; file: string; range: AttentionRange; message?: string; targetUserId?: number; createdAt: number; expiresAt: number; }`
  - `export type AttentionClearedReason = "dismissed" | "expired" | "acted" | "author_gone";`
  - `export function normalizeRange(v: unknown): AttentionRange | null` — same logic as backend Task 1 (finite, non-negative, `start ≤ end`, reversed → null). Copy the body; add a frontend test that pins parity on the same matrix.
  - `export function rangesOverlap(a: AttentionRange, b: AttentionRange): boolean` — copy backend Task 1 body verbatim.
  - `export function parseAttentionEvent(raw: unknown): AttentionEvent | null` — client-side shape guard for an inbound `attention_event`: requires `id` string, `kind` in the set, `author` object with numeric `userId` + string `username` + string `color`, `file` string, `normalizeRange(raw.range)` non-null, numeric `createdAt`/`expiresAt`; `message` optional string; `targetUserId` optional number. Returns `null` on any failure. Never throws.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/test/collab.attention.test.ts
import { describe, it, expect } from "vitest";
import {
  normalizeRange, rangesOverlap, parseAttentionEvent,
  ATTENTION_POINT_TTL_MS, ATTENTION_CALLOUT_TTL_MS, ATTENTION_CALLOUT_MAX_TTL_MS,
} from "../src/collab/attention";

const R = (sl: number, sc: number, el: number, ec: number) =>
  ({ startLine: sl, startColumn: sc, endLine: el, endColumn: ec });

describe("M58 client — constants match the backend", () => {
  it("pins the client TTLs", () => {
    expect(ATTENTION_POINT_TTL_MS).toBe(6_000);
    expect(ATTENTION_CALLOUT_TTL_MS).toBe(45_000);
    expect(ATTENTION_CALLOUT_MAX_TTL_MS).toBe(90_000);
  });
});

describe("M58 client — normalizeRange / rangesOverlap parity", () => {
  it("rejects reversed and non-finite", () => {
    expect(normalizeRange(R(9, 1, 2, 1))).toBeNull();
    expect(normalizeRange(R(1, 1, NaN, 1))).toBeNull();
  });
  it("touching columns do not overlap; interior lines do", () => {
    expect(rangesOverlap(R(5, 2, 5, 10), R(5, 10, 5, 20))).toBe(false);
    expect(rangesOverlap(R(40, 1, 50, 1), R(45, 1, 60, 1))).toBe(true);
  });
  it("zero-width cursor inside overlaps; at exclusive end does not", () => {
    expect(rangesOverlap(R(5, 5, 5, 5), R(5, 2, 5, 10))).toBe(true);
    expect(rangesOverlap(R(5, 10, 5, 10), R(5, 2, 5, 10))).toBe(false);
  });
});

describe("M58 client — parseAttentionEvent", () => {
  const good = {
    type: "attention_event", id: "a1b2c3d4e5f60718", kind: "callout",
    author: { userId: 7, username: "rahul", color: "#89b4fa" },
    file: "auth/session.ts", range: R(40, 1, 52, 1),
    message: "race here", createdAt: 1000, expiresAt: 91000,
  };
  it("parses a valid event", () => {
    expect(parseAttentionEvent(good)?.id).toBe("a1b2c3d4e5f60718");
  });
  it("rejects a bad range / missing author / bad kind", () => {
    expect(parseAttentionEvent({ ...good, range: R(9, 1, 2, 1) })).toBeNull();
    expect(parseAttentionEvent({ ...good, author: null })).toBeNull();
    expect(parseAttentionEvent({ ...good, kind: "zzz" })).toBeNull();
  });
  it("never throws on garbage", () => {
    expect(parseAttentionEvent(null)).toBeNull();
    expect(parseAttentionEvent(42)).toBeNull();
  });
});
```

- [ ] **Step 2: Run — verify fail** → `cd frontend && npx vitest run test/collab.attention.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `frontend/src/collab/attention.ts` — the constants block, the type exports, and `normalizeRange` / `rangesOverlap` copied verbatim from backend Task 1 (they have no `node:` imports — inline the `isAwarenessCoord` check as `Number.isFinite(n) && n >= 0 && n <= 5_000_000`). Add `parseAttentionEvent` per the Interfaces contract. Header comment:

```ts
// M58: client-side transient ATTENTION model. Mirrors backend/src/collab/
// attention.ts — keep the constants and range logic in sync (the repo
// hand-syncs frontend/src/types.ts with backend types the same way).
// The client NEVER authors id/author/createdAt/expiresAt — those arrive
// server-stamped. This module renders and locally expires.
```

- [ ] **Step 4: Run — verify pass** → PASS.

- [ ] **Step 5: Typecheck** → `cd frontend && npx tsc --noEmit` → 0 errors.

- [ ] **Step 6: Stage for review**

```bash
git add frontend/src/collab/attention.ts frontend/test/collab.attention.test.ts
```

**Review checkpoint:** frontend range logic is byte-identical to the backend; `parseAttentionEvent` guards every field. **Rollback point:** delete both files.

---

### Task 11: `AttentionStore` — lifecycle, local TTL, hard ceiling, dismiss

**Files:**
- Modify: `frontend/src/collab/attention.ts`
- Modify: `frontend/test/collab.attention.test.ts`

**Interfaces:**
- Produces:
  - `export type AttentionInboundMsg = ({ type: "attention_event" } & AttentionEvent) | { type: "attention_cleared"; id: string; reason: AttentionClearedReason };`
  - `export class AttentionStore`:
    - `apply(msg: unknown): void` — `attention_event` → `parseAttentionEvent`; on success upsert and (for point/callout) schedule local removal at `Math.min(kindLocalTtl, event.expiresAt - Date.now())` (never past `expiresAt`; if already past, remove on next tick). `request` → no local timer. `attention_cleared` → remove by id. Emits `change` after any mutation.
    - `touchCallout(id: string): void` — reschedule a callout's local timer to `Math.min(now + ATTENTION_CALLOUT_TTL_MS, event.expiresAt)`; **no-op if that is ≤ the currently scheduled fire time** (refresh only extends, never shortens) and **never past `expiresAt`**. Points/requests: no-op.
    - `dismissLocal(id: string): void` — remove by id immediately + emit (used for the local "×" on a callout bubble and optimistic request removal). Does not send anything.
    - `list(): AttentionEvent[]` — current events, stable order by `createdAt`.
    - `incomingRequestCount(currentUserId: number): number` — count of `kind === "request" && targetUserId === currentUserId && author.userId !== currentUserId`.
    - `onChange(cb: () => void): () => void` — subscribe; returns unsubscribe.
    - `clear(): void` — drop all events, clear all timers, emit.
    - `dispose(): void` — `clear()` + drop subscribers.

- [ ] **Step 1: Write the failing tests**

```ts
// append to frontend/test/collab.attention.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AttentionStore } from "../src/collab/attention";

const ev = (over: Partial<any> = {}) => ({
  type: "attention_event",
  id: over.id ?? Math.random().toString(16).slice(2),
  kind: over.kind ?? "point",
  author: over.author ?? { userId: 7, username: "rahul", color: "#89b4fa" },
  file: "a.ts",
  range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
  message: over.message,
  targetUserId: over.targetUserId,
  createdAt: over.createdAt ?? Date.now(),
  expiresAt: over.expiresAt ?? Date.now() + 9_999_999,
});

describe("M58 — AttentionStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("removes a point after the local TTL (6s)", () => {
    const s = new AttentionStore();
    s.apply(ev({ kind: "point", id: "p1" }));
    expect(s.list()).toHaveLength(1);
    vi.advanceTimersByTime(5_999);
    expect(s.list()).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(s.list()).toHaveLength(0);
  });

  it("removes a callout after 45s by default", () => {
    const s = new AttentionStore();
    s.apply(ev({ kind: "callout", id: "c1", message: "x" }));
    vi.advanceTimersByTime(45_001);
    expect(s.list()).toHaveLength(0);
  });

  it("honours the server hard ceiling even if the client tries to keep it alive", () => {
    const s = new AttentionStore();
    const created = Date.now();
    s.apply(ev({ kind: "callout", id: "c2", message: "x", createdAt: created, expiresAt: created + 90_000 }));
    // keep touching it every 40s
    for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(40_000); s.touchCallout("c2"); }
    // 200s elapsed — well past the 90s ceiling
    expect(s.list()).toHaveLength(0);
  });

  it("a request has no local timer — it stays until cleared", () => {
    const s = new AttentionStore();
    s.apply(ev({ kind: "request", id: "r1", message: "look", targetUserId: 12 }));
    vi.advanceTimersByTime(10 * 60_000);
    expect(s.list()).toHaveLength(1);
    s.apply({ type: "attention_cleared", id: "r1", reason: "dismissed" });
    expect(s.list()).toHaveLength(0);
  });

  it("dismissLocal removes immediately without waiting for the server", () => {
    const s = new AttentionStore();
    s.apply(ev({ kind: "request", id: "r2", message: "x", targetUserId: 12 }));
    s.dismissLocal("r2");
    expect(s.list()).toHaveLength(0);
  });

  it("incomingRequestCount counts only requests targeted at me", () => {
    const s = new AttentionStore();
    s.apply(ev({ kind: "point", id: "p" }));
    s.apply(ev({ kind: "callout", id: "c", message: "x" }));
    s.apply(ev({ kind: "request", id: "r-me", message: "x", targetUserId: 12, author: { userId: 7, username: "r", color: "#1" } }));
    s.apply(ev({ kind: "request", id: "r-other", message: "x", targetUserId: 99, author: { userId: 7, username: "r", color: "#1" } }));
    expect(s.incomingRequestCount(12)).toBe(1);
  });

  it("clear() drops everything and fires change", () => {
    const s = new AttentionStore();
    const seen = vi.fn();
    s.onChange(seen);
    s.apply(ev({ kind: "point", id: "p" }));
    s.clear();
    expect(s.list()).toHaveLength(0);
    expect(seen).toHaveBeenCalled();
  });

  it("ignores a malformed attention_event", () => {
    const s = new AttentionStore();
    s.apply({ type: "attention_event", id: "bad", kind: "zzz" });
    expect(s.list()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — verify fail** → FAIL.

- [ ] **Step 3: Implement** `AttentionStore`. Key details:
  - internal `Map<string, AttentionEvent>` + `Map<string, ReturnType<typeof setTimeout>>` for local timers + `Set<() => void>` subscribers.
  - `localTtlFor(kind)`: `point` → `ATTENTION_POINT_TTL_MS`, `callout` → `ATTENTION_CALLOUT_TTL_MS`, `request` → `null`.
  - scheduling helper: `const fireIn = Math.max(0, Math.min(localTtl, event.expiresAt - Date.now()));` `setTimeout(() => { this.events.delete(id); this.timers.delete(id); this.emit(); }, fireIn)`.
  - `touchCallout`: compute `target = Math.min(Date.now() + ATTENTION_CALLOUT_TTL_MS, event.expiresAt)`; if `target - Date.now() <= 0` remove now; else if there is an existing timer, only reschedule when the new fire time is *later* than the current one (track the scheduled absolute fire time in a `Map<string, number>`), always clamped to `expiresAt`.
  - `emit()` calls every subscriber inside a `try/catch`.

- [ ] **Step 4: Run — verify pass** → PASS.

- [ ] **Step 5: Full frontend collab regression**

Run: `cd frontend && npx vitest run test/collab.attention.test.ts test/collab.awareness.test.ts test/collab.presence.test.ts test/collab-initialization.test.ts`
Expected: PASS — all (existing tests untouched).

- [ ] **Step 6: Stage for review**

```bash
git add frontend/src/collab/attention.ts frontend/test/collab.attention.test.ts
```

**Review checkpoint:** callout local life is always `min(local, expiresAt - now)` and `touchCallout` never pushes past `expiresAt`; requests have no local timer; `dispose`/`clear` clear every timer. **Rollback point:** revert `attention.ts` to Task 10 state.

---

### Task 12: `CollaborationClient` — senders + receive branch + reset

**Files:**
- Modify: `frontend/src/collab/client.ts`
- Modify: `frontend/test/collab.attention.test.ts` (add a `CollaborationClient`-level block using the existing `FakeWebSocket` harness from `collab.awareness.test.ts`)

**Interfaces:**
- Consumes: `AttentionStore`, `AttentionRange`, constants from `./attention`.
- Produces on `CollaborationClient`:
  - `public readonly attentionStore = new AttentionStore()` (or a `private` field + `public getAttention(): AttentionEvent[] { return this.attentionStore.list(); }`)
  - `public sendAttentionPoint(file: string, range: AttentionRange): void`
  - `public sendAttentionCallout(file: string, range: AttentionRange, message: string): void`
  - `public sendAttentionRequest(targetUserId: number, file: string, range: AttentionRange, message: string): void`
  - `public dismissAttentionRequest(id: string, acted?: boolean): void` — sends `{ type: "attention_dismiss", id, acted }` **and** `this.attentionStore.dismissLocal(id)` (optimistic).
  - each sender: `if (this.isDisposed) return;` then build a `MESSAGE_CUSTOM` frame exactly like `notifyFileOpen` does (`encoding.writeVarUint(enc, MESSAGE_CUSTOM); encoding.writeVarString(enc, JSON.stringify({ type: "attention_point", file, range }))`), `this.send(...)`. No local echo for point/callout (the server broadcasts to peers only; the author does not render their own point/callout). For request, the server echoes it back → the receive branch stores it → the tray shows "✓ Sent".
- Wiring in `handleMessage`'s `case MESSAGE_CUSTOM` (after the `external_mutation_notice` branch):
  ```ts
  } else if (
    parsed &&
    (parsed.type === "attention_event" || parsed.type === "attention_cleared")
  ) {
    this.attentionStore.apply(parsed);
  } else if (parsed && parsed.type === "attention_rate_limited") {
    this.emit("attention_rate_limited", parsed);
  }
  ```
- `attentionStore.onChange` → `this.emit("attention_change", this.attentionStore.list())` — wired once in `initDocAndAwareness` (or the constructor).
- `resetLocalCollabState()` — add `this.attentionStore.clear();` next to `this.readyFiles.clear();` (a fresh lineage / explicit disposal drops all transient attention — matches "stale attention does not resurrect"). The server's fresh `addClient` snapshot re-sends any still-valid request targeted at this user.
- `dispose()` — add `this.attentionStore.dispose();`.

- [ ] **Step 1: Write the failing tests**

```ts
// append — client-level block. Mirror the harness setup in collab.awareness.test.ts
// (installs a FakeWebSocket on globalThis and captures sent frames).

it("sendAttentionPoint emits a well-formed MESSAGE_CUSTOM frame", () => {
  const client = new CollaborationClient("p", { id: 1, username: "a" } as any);
  const sent = captureSentCustom(client); // helper: decode MESSAGE_CUSTOM frames
  client.sendAttentionPoint("auth/session.ts", { startLine: 47, startColumn: 1, endLine: 47, endColumn: 1 });
  expect(sent()).toContainEqual({
    type: "attention_point",
    file: "auth/session.ts",
    range: { startLine: 47, startColumn: 1, endLine: 47, endColumn: 1 },
  });
  client.dispose();
});

it("an inbound attention_event lands in the store and fires attention_change", () => {
  const client = new CollaborationClient("p", { id: 1, username: "a" } as any);
  const changes: any[] = [];
  client.on("attention_change", (l: any) => changes.push(l));
  (client as any).handleMessage(makeCustomFrame({
    type: "attention_event", id: "abc0000000000000", kind: "callout",
    author: { userId: 7, username: "r", color: "#89b4fa" },
    file: "a.ts", range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
    message: "hi", createdAt: Date.now(), expiresAt: Date.now() + 90_000,
  }));
  expect(client.getAttention().map((e) => e.id)).toContain("abc0000000000000");
  expect(changes.at(-1).some((e: any) => e.id === "abc0000000000000")).toBe(true);
  client.dispose();
});

it("dismissAttentionRequest sends a dismiss frame and removes it locally", () => {
  const client = new CollaborationClient("p", { id: 1, username: "a" } as any);
  const sent = captureSentCustom(client);
  (client as any).handleMessage(makeCustomFrame({
    type: "attention_event", id: "req0000000000000", kind: "request", targetUserId: 1,
    author: { userId: 7, username: "r", color: "#89b4fa" },
    file: "a.ts", range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
    message: "look", createdAt: Date.now(), expiresAt: Date.now() + 120_000,
  }));
  client.dismissAttentionRequest("req0000000000000", true);
  expect(sent()).toContainEqual({ type: "attention_dismiss", id: "req0000000000000", acted: true });
  expect(client.getAttention()).toHaveLength?.(0) ?? expect(client.getAttention().length).toBe(0);
  client.dispose();
});

it("resetLocalCollabState clears transient attention", () => {
  const client = new CollaborationClient("p", { id: 1, username: "a" } as any);
  (client as any).handleMessage(makeCustomFrame({
    type: "attention_event", id: "x000000000000000", kind: "point",
    author: { userId: 7, username: "r", color: "#89b4fa" },
    file: "a.ts", range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
    createdAt: Date.now(), expiresAt: Date.now() + 6_000,
  }));
  (client as any).resetLocalCollabState();
  expect(client.getAttention()).toEqual([]);
  client.dispose();
});
```

(Define `captureSentCustom` / `makeCustomFrame` at the top of the block using `lib0/decoding` + `lib0/encoding`, mirroring the frame helpers used elsewhere in the frontend collab tests. `MESSAGE_CUSTOM = 3`.)

- [ ] **Step 2: Run — verify fail** → FAIL.

- [ ] **Step 3: Implement** per the Interfaces contract.

- [ ] **Step 4: Run — verify pass** → PASS.

- [ ] **Step 5: Regression**

Run: `cd frontend && npx vitest run test/collab.attention.test.ts test/collab.awareness.test.ts test/collab.follow.test.tsx test/collab-initialization.test.ts test/collab.runStatus.test.ts test/collab.explicitDisposalReset.test.ts test/collab.disposedClient.test.ts`
Expected: PASS — all unchanged.

- [ ] **Step 6: Typecheck** → `cd frontend && npx tsc --noEmit` → 0 errors.

- [ ] **Step 7: Stage for review**

```bash
git add frontend/src/collab/client.ts frontend/test/collab.attention.test.ts
```

**Review checkpoint:** the author does not locally render their own point/callout (server broadcasts to peers only); `resetLocalCollabState` + `dispose` both clear the store; the receive branch stays inside the existing `try/catch`. **Rollback point:** revert `client.ts`; `attention.ts` store stays usable.

---

## PHASE 4 — IDE integration (`IDE.tsx`)

### Task 13: `attention` state, canonical navigation, Jump retrofit

**Files:**
- Modify: `frontend/src/components/IDE/IDE.tsx`
- Create: `frontend/test/IDE.attention.test.tsx` (follow the IDE.tsx test conventions in `MEMORY.md` / `status-md-is-the-backlog` — the repo has an established pattern; extend an existing IDE test file if one already covers navigation)

**Interfaces:**
- Consumes: `client.on("attention_change", …)`, `AttentionEvent`, `openAndRevealLocation`, `handleOpenFile`.
- Produces:
  - `const [attention, setAttention] = useState<AttentionEvent[]>([]);`
  - in the collab-client effect (next to `unsubRunStatus`): `const throttledSetAttention = throttleLatest<AttentionEvent[]>(setAttention, 200); unsubAttention = client.on("attention_change", throttledSetAttention);` — cleaned up + `throttledSetAttention.cancel()` + `setAttention([])` in the effect teardown (mirror `throttledSetCollaborators`).
  - also `unsubAttnRate = client.on("attention_rate_limited", () => setAttnRateNotice(Date.now()))` → a transient `attnRateNotice` state that a 4 s timer clears; passed to `AttentionTray` as `rateLimited={boolean}`.
  - `const handleAttentionNavigate = useCallback((evt: AttentionEvent) => { void openAndRevealLocation(handleOpenFile, { filePath: evt.file, line: evt.range.startLine, column: evt.range.startColumn }); }, []);`
  - `const handleAttentionDismiss = useCallback((id: string, acted?: boolean) => { collabClientRef.current?.dismissAttentionRequest(id, acted); }, []);`
  - **Retrofit `handleJumpToCollaborator`** (currently `handleOpenFile` + `setTimeout(dispatch, 100)`):
    ```ts
    const handleJumpToCollaborator = useCallback((c: CollaboratorPresence) => {
      if (!c.activeFile) return;
      void openAndRevealLocation(handleOpenFile, {
        filePath: c.activeFile,
        line: c.cursor?.line ?? 1,
        column: c.cursor?.column ?? 1,
      });
    }, []);
    ```
  - render, after `<Toolbar>` / `<TeamPanel>`:
    ```tsx
    {user && (
      <AttentionTray
        events={attention}
        currentUserId={user.id}
        rateLimited={attnRateNotice != null}
        onNavigate={handleAttentionNavigate}
        onDismiss={handleAttentionDismiss}
      />
    )}
    ```
  - pass to `<Editor>`: `attention={attention}` and `onAttentionNavigate={handleAttentionNavigate}`.
  - pass to `<Toolbar>`: `incomingRequestCount={attention.filter(e => e.kind === "request" && e.targetUserId === user?.id && e.author.userId !== user?.id).length}` (or compute via a memo).

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/test/IDE.attention.test.tsx — focus on the navigation contract only,
// stubbing the collab client per the repo's IDE test pattern.
import { describe, it, expect, vi } from "vitest";
// ... render <IDE> with a fake collab client that lets the test emit
//     "attention_change"; see existing IDE tests for the harness.

it("navigating to attention for a CLOSED file opens it before revealing", async () => {
  const calls: string[] = [];
  const openFile = vi.fn(async () => { calls.push("open"); });
  // spy document.dispatchEvent for ide-reveal-location
  const origDispatch = document.dispatchEvent.bind(document);
  vi.spyOn(document, "dispatchEvent").mockImplementation((e: Event) => {
    if ((e as CustomEvent).type === "ide-reveal-location") calls.push("reveal");
    return origDispatch(e);
  });
  const { openAndRevealLocation } = await import("../src/utils/revealLocation");
  await openAndRevealLocation(openFile, { filePath: "auth/session.ts", line: 40, column: 1 });
  expect(calls).toEqual(["open", "reveal"]); // open STRICTLY before reveal
});

it("retrofitted Jump also uses open-then-reveal (no dispatch-only path)", async () => {
  // assert IDE.tsx's handleJumpToCollaborator body calls openAndRevealLocation:
  // easiest as a source-level guard + a behavioral test that a Jump to a
  // collaborator on a not-open file triggers openFile before the reveal event.
});
```

> Note: the strongest guard is behavioral — render `<IDE>`, emit an `attention_change` with a request whose `file` is not open, click "Go there" in the tray, and assert `api` was called to fetch that file's content (the open path) *before* `ide-reveal-location` fired. If the repo's IDE harness cannot reach the tray button, fall back to a focused unit test of `handleAttentionNavigate` exported for test, plus a `grep`-style source assertion that `handleAttentionNavigate` and `handleJumpToCollaborator` both reference `openAndRevealLocation`.

- [ ] **Step 2: Run — verify fail** → `cd frontend && npx vitest run test/IDE.attention.test.tsx` → FAIL.

- [ ] **Step 3: Implement** the state + handlers + wiring per Interfaces. Keep `AttentionTray` import lazy-safe (it is a normal component, not a Monaco chunk — direct import is fine).

- [ ] **Step 4: Run — verify pass** → PASS.

- [ ] **Step 5: Regression** → `cd frontend && npx vitest run test/collab.follow.test.tsx test/collab.follow.attention.test.tsx` (the latter is created in Task 20 — skip if not yet present) `&& npx vitest run` for the full suite once Phase 4 compiles.
Expected: existing suites green; **366 + new**.

- [ ] **Step 6: Typecheck** → `cd frontend && npx tsc --noEmit` → 0 errors.

- [ ] **Step 7: Stage for review**

```bash
git add frontend/src/components/IDE/IDE.tsx frontend/test/IDE.attention.test.tsx
```

**Review checkpoint:** `attention` is one throttled state (200 ms), no per-event global render; **both** `handleAttentionNavigate` and the retrofitted `handleJumpToCollaborator` call `openAndRevealLocation`; the follow effect's inline `handleOpenFile` is left as-is (it is already correct — open then the effect re-runs and reveals). **Rollback point:** revert `IDE.tsx`; Editor/Tray simply receive no data.

---

## PHASE 5 — Editor UX (`Editor.tsx`)

### Task 14: Author actions — Point / Call out / Come look

**Files:**
- Modify: `frontend/src/components/Editor/Editor.tsx`
- Create: `frontend/src/components/Editor/AttentionComposer.tsx`
- Test: `frontend/test/Editor.attention.test.tsx`

**Interfaces:**
- `EditorProps` gains: `attention?: AttentionEvent[]`, `onAttentionNavigate?: (e: AttentionEvent) => void`. (`collabClient`, `collaborators`, `currentUserId` already present.)
- `AttentionComposer.tsx`:
  ```ts
  export interface AttentionComposerProps {
    mode: "callout" | "comeLook";
    anchorTop: number;   // px within .editor-container
    anchorLeft: number;
    collaborators: { userId: number; name: string; color: string }[]; // for comeLook picker; connected, minus self
    onSubmit: (message: string, targetUserId?: number) => void;
    onCancel: () => void;
  }
  export default function AttentionComposer(props: AttentionComposerProps): JSX.Element
  ```
  A small absolute-positioned card: `<input maxLength={280}>` + (comeLook only) a `<select>`/list of collaborators + Send/Cancel. Enter submits, Esc cancels. Not a modal (no backdrop, no focus trap beyond the input).
- `Editor.tsx` registers three actions in the existing `monaco.editor.create` effect, alongside the AI actions, `contextMenuGroupId: "9_collab"` (after `1_ai`), enabled via `precondition`-style guard inside `run` (check `collabClientRef.current?.status === "connected"` and `!isReadOnlyRef.current`; if not, no-op):
  - `cloudide.attention.point` → `run(ed)`: `const sel = ed.getSelection(); collabClientRef.current?.sendAttentionPoint(activeFileRef.current!, rangeFromSelection(sel));`
  - `cloudide.attention.callout` → open the composer in `"callout"` mode anchored at the selection's top (`ed.getScrolledVisiblePosition(sel.getStartPosition())` + the editor DOM offset). On submit: `sendAttentionCallout(file, range, message)`.
  - `cloudide.attention.comeLook` → open the composer in `"comeLook"` mode; on submit with `targetUserId`: `sendAttentionRequest(targetUserId, file, range, message)`.
  - `rangeFromSelection(sel)`: `{ startLine: sel.startLineNumber, startColumn: sel.startColumn, endLine: sel.endLineNumber, endColumn: sel.endColumn }` — a cursor with no selection yields a zero-width range (valid).
- Composer state in `Editor`: `const [composer, setComposer] = useState<{ mode; anchorTop; anchorLeft; range } | null>(null)`.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/test/Editor.attention.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import Editor from "../src/components/Editor/Editor";

// The repo's Editor tests already stub monaco; follow that pattern. Provide a
// fake collabClient exposing sendAttentionPoint/Callout/Request spies +
// status: "connected".

it("Point action sends a point for the current selection", () => {
  const client = fakeCollabClient(); // status "connected", spies
  renderEditorWithFile(client, "auth/session.ts");
  triggerEditorAction("cloudide.attention.point", { startLineNumber: 47, startColumn: 1, endLineNumber: 47, endColumn: 1 });
  expect(client.sendAttentionPoint).toHaveBeenCalledWith("auth/session.ts", {
    startLine: 47, startColumn: 1, endLine: 47, endColumn: 1,
  });
});

it("Call out opens the composer and sends a callout on submit", () => {
  const client = fakeCollabClient();
  renderEditorWithFile(client, "a.ts");
  triggerEditorAction("cloudide.attention.callout", { startLineNumber: 40, startColumn: 1, endLineNumber: 52, endColumn: 1 });
  const input = screen.getByPlaceholderText(/call out/i);
  fireEvent.change(input, { target: { value: "the race is here" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(client.sendAttentionCallout).toHaveBeenCalledWith(
    "a.ts", { startLine: 40, startColumn: 1, endLine: 52, endColumn: 1 }, "the race is here",
  );
});

it("Come look shows a collaborator picker and targets the chosen user", () => {
  const client = fakeCollabClient();
  renderEditorWithFile(client, "a.ts", [
    { userId: 2, name: "Rahul", color: "#89b4fa" },
  ]);
  triggerEditorAction("cloudide.attention.comeLook", { startLineNumber: 40, startColumn: 1, endLineNumber: 52, endColumn: 1 });
  fireEvent.click(screen.getByRole("button", { name: /rahul/i }));
  const input = screen.getByPlaceholderText(/come look|message/i);
  fireEvent.change(input, { target: { value: "the race" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(client.sendAttentionRequest).toHaveBeenCalledWith(
    2, "a.ts", { startLine: 40, startColumn: 1, endLine: 52, endColumn: 1 }, "the race",
  );
});

it("actions are inert when the collab client is not connected", () => {
  const client = fakeCollabClient({ status: "disconnected" });
  renderEditorWithFile(client, "a.ts");
  triggerEditorAction("cloudide.attention.point", { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 });
  expect(client.sendAttentionPoint).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run — verify fail** → FAIL.

- [ ] **Step 3: Implement** `AttentionComposer.tsx` then the three actions + composer state in `Editor.tsx`.

- [ ] **Step 4: Run — verify pass** → PASS.

- [ ] **Step 5: Regression** → `cd frontend && npx vitest run test/Editor.attention.test.tsx test/collab.follow.test.tsx` + any existing `Editor.*` tests → PASS.

- [ ] **Step 6: Stage for review**

```bash
git add frontend/src/components/Editor/Editor.tsx frontend/src/components/Editor/AttentionComposer.tsx frontend/test/Editor.attention.test.tsx
```

**Review checkpoint:** actions capture file + range from editor state (no manual entry); inert when disconnected/read-only; composer is not a modal. **Rollback point:** remove the three `addAction` calls + composer; nothing else depends on them.

---

### Task 15: Incoming Point + Callout decorations (text-only, fading)

**Files:**
- Modify: `frontend/src/components/Editor/Editor.tsx`
- Modify: `frontend/src/styles/collab.css`
- Modify: `frontend/test/Editor.attention.test.tsx`

**Interfaces:**
- A `useEffect` keyed on `[attention, activeFile]` that maintains a `monaco.editor.IEditorDecorationsCollection` (created once via `editor.createDecorationsCollection()`), plus a small map of callout **content widgets**:
  - filter `attention` to `e.file === activeFile && (e.kind === "point" || e.kind === "callout")`.
  - **point** → one decoration at `range.startLine`: `glyphMarginClassName: "attention-point-glyph"`, `after: { content: ` 👉 ${e.author.username}`, inlineClassName: "attention-point-label" }`, plus `linesDecorationsClassName`. Colour via an inline `--attn-color` CSS var set on a wrapper is not possible on decorations; instead register a per-colour class or use `className` + a style tag keyed by colour hash (the repo already does colour-hashed classes for `getUserColor`). Simplest: `className: "attention-point-line"` + a `hoverMessage` naming the author; colour comes from `.attention-point-glyph` using `currentColor` driven by a data attribute is also not available — **use `overviewRuler: { color: e.author.color, position: monaco.editor.OverviewRulerLane.Right }`** for the colour cue and keep the glyph monochrome. (Decoration colour-by-collaborator is a known Monaco limitation; the overview-ruler tick + the labelled `after` text carry identity.)
  - **callout** → a range decoration (`className: "attention-callout-range"`, `overviewRuler.color = e.author.color`) + a **content widget** anchored above `range.startLine`: a `<div class="attention-callout-bubble">` with a colour dot (`style="background:${e.author.color}"`), `📣 ${username}` (set via `textContent`), the message (set via `textContent` — **never `innerHTML`**), and a `×` button that calls `collabClient.attentionStore.dismissLocal(e.id)` (local only; callouts aren't server-held). The widget's `getDomNode` builds the DOM imperatively so message text is guaranteed `textContent`.
  - on `attention` change, diff by `id`: add new widgets, remove gone ones, `dispose` removed widgets.
  - all widgets removed on unmount and on `activeFile` change.
- CSS: `.attention-point-glyph` (small 👉 or dot), `.attention-point-label` (muted, italic, fades via `@keyframes attention-fade` over the last ~1 s — but the element is removed by the store TTL, so the fade is cosmetic), `.attention-callout-range` (low-alpha left-border accent), `.attention-callout-bubble` (small `liquid-card`-style, max-width ~260px, `word-break`, `z-index` below modals).

- [ ] **Step 1: Write the failing tests**

```tsx
it("renders a point decoration on the author's line", () => {
  const client = fakeCollabClient();
  const { editorApi } = renderEditorWithFile(client, "a.ts");
  rerenderEditorAttention([pointEvent({ file: "a.ts", line: 12 })]);
  expect(editorApi.getDecorationsOnLine(12).some(d => d.options.className?.includes("attention") || d.options.overviewRuler)).toBe(true);
});

it("renders a callout bubble with the message as TEXT (no HTML injection)", () => {
  const client = fakeCollabClient();
  renderEditorWithFile(client, "a.ts");
  rerenderEditorAttention([calloutEvent({
    file: "a.ts", range: { startLine: 40, startColumn: 1, endLine: 52, endColumn: 1 },
    message: `<img src=x onerror="window.__pwned=1">`,
  })]);
  const bubble = document.querySelector(".attention-callout-bubble")!;
  expect(bubble.textContent).toContain('<img src=x onerror="window.__pwned=1">');
  expect(bubble.querySelector("img")).toBeNull();
  expect((window as any).__pwned).toBeUndefined();
});

it("clears decorations/widgets when the attention list empties", () => {
  renderEditorWithFile(fakeCollabClient(), "a.ts");
  rerenderEditorAttention([calloutEvent({ file: "a.ts" })]);
  expect(document.querySelector(".attention-callout-bubble")).not.toBeNull();
  rerenderEditorAttention([]);
  expect(document.querySelector(".attention-callout-bubble")).toBeNull();
});

it("does not mutate the Monaco model", () => {
  const { editorApi } = renderEditorWithFile(fakeCollabClient(), "a.ts");
  const before = editorApi.getValue();
  rerenderEditorAttention([pointEvent({ file: "a.ts" }), calloutEvent({ file: "a.ts", message: "x" })]);
  expect(editorApi.getValue()).toBe(before);
});
```

- [ ] **Step 2: Run — verify fail** → FAIL.

- [ ] **Step 3: Implement** the decorations/widgets effect + CSS.

- [ ] **Step 4: Run — verify pass** → PASS.

- [ ] **Step 5: Stage for review**

```bash
git add frontend/src/components/Editor/Editor.tsx frontend/src/styles/collab.css frontend/test/Editor.attention.test.tsx
```

**Review checkpoint:** message text is set via `textContent`/imperative DOM, never `innerHTML`; no decoration/widget path calls `model.setValue`/`pushEdit`; widgets are disposed on list change + unmount + file switch. **Rollback point:** remove the decorations effect + CSS block.

---

### Task 16: Three-tier spatial awareness (feature 6)

**Files:**
- Modify: `frontend/src/components/Editor/Editor.tsx`
- Create: `frontend/test/Editor.nearby.test.tsx`
- Modify: `frontend/src/styles/collab.css`

**Interfaces:**
- Replace `nearbyEditingCollaborators` with `spatialCollaborators` — a memo over `[activeFile, collaborators, currentUserId, localSelection]` where `localSelection` is tracked from `onDidChangeCursorSelection` (a new `React.useState<AttentionRange>` seeded to the cursor line as a zero-width range; the existing `localCursorLine` state can stay for other consumers or be folded in).
  ```ts
  type SpatialTier = "nearby" | "overlapping";
  interface SpatialHit { collaborator: CollaboratorPresence; tier: SpatialTier; }
  const spatialCollaborators: SpatialHit[] = useMemo(() => {
    if (!activeFile) return [];
    const out: SpatialHit[] = [];
    for (const c of collaborators ?? []) {
      if (c.userId === currentUserId || c.activeFile !== activeFile) continue;
      if (c.activity?.type !== "editing") continue;
      const theirs = normalizeRange(c.selection ?? cursorAsRange(c.cursor));
      if (!theirs) continue;
      if (rangesOverlap(localSelection, theirs)) out.push({ collaborator: c, tier: "overlapping" });
      else if (Math.abs(theirs.startLine - localSelection.startLine) <= RANGE_NEAR_LINES)
        out.push({ collaborator: c, tier: "nearby" });
    }
    return out;
  }, [activeFile, collaborators, currentUserId, localSelection]);
  ```
  `cursorAsRange({line,column})` → `{ startLine: line, startColumn: column, endLine: line, endColumn: column }`; when `c.cursor` is null return `null`.
- Render (replacing the old `proximity-warning-badge` block, keeping `role="status"` / `aria-live="polite"`):
  - any `overlapping` hit → `<div class="spatial-badge spatial-overlap">⚠ {names} — editing the same lines <button>View {name}</button></div>` where the button calls `onAttentionNavigate`-style navigation to that collaborator's cursor (reuse `handleJumpToCollaborator` threaded down, or a new `onViewCollaborator` prop → `openAndRevealLocation`).
  - else any `nearby` hit → `<div class="spatial-badge spatial-nearby">{names} editing nearby (within 5 lines)</div>`.
- The M57 **same-file strip** (`sameFileCollaborators`) is **unchanged** — it stays as the informational tier.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/test/Editor.nearby.test.tsx
it("same file but far apart and not editing → no spatial badge (same-file strip only)", () => {
  renderEditor({ activeFile: "a.ts", currentUserId: 1, localSelection: range(10, 1, 10, 1),
    collaborators: [collab({ userId: 2, activeFile: "a.ts", activity: "viewing", cursor: { line: 200, column: 1 } })] });
  expect(document.querySelector(".spatial-badge")).toBeNull();
  expect(document.querySelector(".editor-samefile-strip")).not.toBeNull();
});

it("editing within 5 lines, not overlapping → nearby badge", () => {
  renderEditor({ activeFile: "a.ts", currentUserId: 1, localSelection: range(40, 1, 50, 1),
    collaborators: [collab({ userId: 2, activeFile: "a.ts", activity: "editing", selection: sel(52, 1, 54, 1) })] });
  const b = document.querySelector(".spatial-badge")!;
  expect(b.className).toContain("spatial-nearby");
});

it("editing overlapping ranges → overlap badge with a View action", () => {
  const onView = vi.fn();
  renderEditor({ activeFile: "a.ts", currentUserId: 1, localSelection: range(40, 1, 50, 1), onViewCollaborator: onView,
    collaborators: [collab({ userId: 2, name: "Rahul", activeFile: "a.ts", activity: "editing", selection: sel(45, 1, 60, 1) })] });
  const b = document.querySelector(".spatial-badge")!;
  expect(b.className).toContain("spatial-overlap");
  fireEvent.click(screen.getByRole("button", { name: /view rahul/i }));
  expect(onView).toHaveBeenCalled();
});

it("editing far apart (100+ lines) → no badge", () => {
  renderEditor({ activeFile: "a.ts", currentUserId: 1, localSelection: range(40, 1, 50, 1),
    collaborators: [collab({ userId: 2, activeFile: "a.ts", activity: "editing", selection: sel(300, 1, 320, 1) })] });
  expect(document.querySelector(".spatial-badge")).toBeNull();
});

it("never writes awareness or the document", () => {
  const client = fakeCollabClient();
  renderEditor({ activeFile: "a.ts", currentUserId: 1, localSelection: range(40, 1, 50, 1), collabClient: client,
    collaborators: [collab({ userId: 2, activeFile: "a.ts", activity: "editing", selection: sel(45, 1, 60, 1) })] });
  expect(client.updateSelection).not.toHaveBeenCalledWith(expect.objectContaining({ startLine: 45 }));
  // (updateSelection is only ever called from the LOCAL cursor handler)
});
```

- [ ] **Step 2: Run — verify fail** → FAIL.

- [ ] **Step 3: Implement** the memo + render + CSS (`.spatial-badge`, `.spatial-nearby` subtle, `.spatial-overlap` warn-coloured).

- [ ] **Step 4: Run — verify pass** → PASS.

- [ ] **Step 5: Regression** → `cd frontend && npx vitest run test/collab.follow.test.tsx test/Editor.nearby.test.tsx` and any existing proximity test. If `collab.follow.test.tsx` asserted the old `proximity-warning-badge` copy (STATUS.md notes it shares `role="status"`), update that assertion to the new `.spatial-badge` copy and note it in the review.

- [ ] **Step 6: Stage for review**

```bash
git add frontend/src/components/Editor/Editor.tsx frontend/test/Editor.nearby.test.tsx frontend/src/styles/collab.css
```

**Review checkpoint:** three tiers are distinct (same-file strip / nearby / overlap); overlap uses `rangesOverlap` not a line heuristic; copy never says "conflict"; no awareness/doc write; `RANGE_NEAR_LINES` imported from `attention.ts`. **Rollback point:** restore the old `nearbyEditingCollaborators` block.

---

## PHASE 6 — AttentionTray

### Task 17: `AttentionTray` component

**Files:**
- Create: `frontend/src/components/Collab/AttentionTray.tsx`
- Create: `frontend/test/AttentionTray.test.tsx`
- Modify: `frontend/src/styles/collab.css`

**Interfaces:**
```ts
export interface AttentionTrayProps {
  events: AttentionEvent[];        // the full IDE attention list
  currentUserId: number;
  rateLimited: boolean;            // brief "too many pending" flag from IDE
  onNavigate: (e: AttentionEvent) => void;
  onDismiss: (id: string, acted?: boolean) => void;
}
export default function AttentionTray(props: AttentionTrayProps): JSX.Element | null
```
Behavior:
- **Incoming requests** = `events.filter(e => e.kind === "request" && e.targetUserId === currentUserId && e.author.userId !== currentUserId)`, sorted newest-first.
- **Sent confirmations** = `events.filter(e => e.kind === "request" && e.author.userId === currentUserId)` → render a muted "✓ Sent to {targetName or 'collaborator'}" line; each auto-hidden after 4 s via a per-id `useEffect` timer (component-local, cleared on unmount).
- Render bottom-right, `position: fixed`, `z-index` below modals, `role="region"` `aria-label="Attention requests"`. Returns `null` when there is nothing to show.
- Each request card: colour dot (`e.author.color`), "📣 {author.username} wants your attention", `{basename(e.file)} · L{startLine}{–endLine if different}`, the message via `{e.message}` (React child = text), `[Go there]` → `onNavigate(e); onDismiss(e.id, true)`, `[Dismiss]` → `onDismiss(e.id)`.
- At most 3 cards visible; the rest collapse to a `+N earlier` button that expands inline.
- `rateLimited` → a one-line muted banner at the top of the tray: "Too many pending requests — wait a moment." (no dismiss button; it is cleared by the IDE's 4 s timer).
- An `attention_cleared` with `reason: "author_gone"` is already removed from `events` by the store; optionally show a 2 s "Rahul withdrew a request" toast — **out of scope for this task**, keep it simple: the card just disappears.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/test/AttentionTray.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import AttentionTray from "../src/components/Collab/AttentionTray";

const reqTo = (uid: number, over: any = {}) => ({
  id: over.id ?? Math.random().toString(16).slice(2),
  kind: "request", targetUserId: uid,
  author: over.author ?? { userId: 7, username: "Rahul", color: "#89b4fa" },
  file: over.file ?? "auth/session.ts",
  range: over.range ?? { startLine: 40, startColumn: 1, endLine: 52, endColumn: 1 },
  message: over.message ?? "I think the race is here.",
  createdAt: over.createdAt ?? Date.now(), expiresAt: Date.now() + 120_000,
});

it("renders a card for a request targeted at me", () => {
  render(<AttentionTray events={[reqTo(1)]} currentUserId={1} rateLimited={false} onNavigate={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByText(/Rahul wants your attention/i)).toBeTruthy();
  expect(screen.getByText(/session\.ts · L40/i)).toBeTruthy();
  expect(screen.getByText("I think the race is here.")).toBeTruthy();
});

it("does not render requests targeted at someone else", () => {
  render(<AttentionTray events={[reqTo(99)]} currentUserId={1} rateLimited={false} onNavigate={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.queryByText(/wants your attention/i)).toBeNull();
});

it("Go there navigates and marks acted", () => {
  const onNavigate = vi.fn(); const onDismiss = vi.fn();
  const e = reqTo(1, { id: "r1" });
  render(<AttentionTray events={[e]} currentUserId={1} rateLimited={false} onNavigate={onNavigate} onDismiss={onDismiss} />);
  fireEvent.click(screen.getByRole("button", { name: /go there/i }));
  expect(onNavigate).toHaveBeenCalledWith(e);
  expect(onDismiss).toHaveBeenCalledWith("r1", true);
});

it("Dismiss calls onDismiss without acted", () => {
  const onDismiss = vi.fn();
  render(<AttentionTray events={[reqTo(1, { id: "r2" })]} currentUserId={1} rateLimited={false} onNavigate={vi.fn()} onDismiss={onDismiss} />);
  fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
  expect(onDismiss).toHaveBeenCalledWith("r2", undefined);
});

it("shows a Sent confirmation for a request I authored", () => {
  const mine = { ...reqTo(2), author: { userId: 1, username: "Me", color: "#111" } };
  render(<AttentionTray events={[mine]} currentUserId={1} rateLimited={false} onNavigate={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByText(/sent/i)).toBeTruthy();
});

it("renders the message as text (no HTML injection)", () => {
  render(<AttentionTray events={[reqTo(1, { message: `<img src=x onerror="window.__x=1">` })]} currentUserId={1} rateLimited={false} onNavigate={vi.fn()} onDismiss={vi.fn()} />);
  expect(document.querySelector(".attention-tray img")).toBeNull();
  expect((window as any).__x).toBeUndefined();
});

it("collapses beyond 3 cards", () => {
  const many = [reqTo(1), reqTo(1), reqTo(1), reqTo(1), reqTo(1)];
  render(<AttentionTray events={many} currentUserId={1} rateLimited={false} onNavigate={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getAllByRole("button", { name: /go there/i })).toHaveLength(3);
  expect(screen.getByText(/\+2 earlier/i)).toBeTruthy();
});

it("shows the rate-limited banner when rateLimited", () => {
  render(<AttentionTray events={[]} currentUserId={1} rateLimited={true} onNavigate={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByText(/too many pending/i)).toBeTruthy();
});
```

- [ ] **Step 2: Run — verify fail** → `cd frontend && npx vitest run test/AttentionTray.test.tsx` → FAIL.

- [ ] **Step 3: Implement** `AttentionTray.tsx` + CSS (`.attention-tray`, `.attention-tray-card`, `.attention-tray-sent`, `.attention-tray-banner`, `.attention-tray-more`).

- [ ] **Step 4: Run — verify pass** → PASS.

- [ ] **Step 5: Stage for review**

```bash
git add frontend/src/components/Collab/AttentionTray.tsx frontend/test/AttentionTray.test.tsx frontend/src/styles/collab.css
```

**Review checkpoint:** only requests targeted at `currentUserId` (and not self-authored) render as actionable cards; message is a React child (text); Go there marks `acted`; the "Sent" line is derived from the author echo, not a separate mechanism. **Rollback point:** delete the component + remove the `<AttentionTray>` render in `IDE.tsx` (Task 13).

---

## PHASE 7 — Collaborator chip integration

### Task 18: Attention count badge on the existing chip

**Files:**
- Modify: `frontend/src/components/Toolbar/Toolbar.tsx` (thread the prop)
- Modify: `frontend/src/components/Collab/CollaboratorAvatarStack.tsx`
- Create/extend: `frontend/test/CollaboratorAvatarStack.attention.test.tsx`
- Modify: `frontend/src/styles/collab.css`

**Interfaces:**
- `ToolbarProps` gains `incomingRequestCount?: number` → passed straight to `<CollaboratorAvatarStack>`.
- `CollaboratorAvatarStackProps` gains `incomingRequestCount?: number`.
- On the existing `.collab-count` chip (`CollaboratorAvatarStack.tsx:294`): when `incomingRequestCount && incomingRequestCount > 0`, render a small child `<span class="collab-attn-badge" aria-label="{n} attention requests">{n}</span>` positioned top-right of the chip. Clicking the chip still calls `onOpenTeamPanel` (unchanged) — the `AttentionTray` is always visible when there are requests, so "clicking the chip reaches the tray" is satisfied by the tray being on-screen; **additionally** dispatch a `document` event `ide-focus-attention-tray` on chip click so the tray can briefly highlight/scroll into view (the tray adds a listener that toggles a `.is-focused` class for ~1.5 s). Keep it lightweight.
- **Do NOT touch** the per-avatar quick popover (`selectedCollaborator` block at `:308`) or the TeamPanel opening — both stay exactly as they are.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/test/CollaboratorAvatarStack.attention.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import CollaboratorAvatarStack from "../src/components/Collab/CollaboratorAvatarStack";

const baseProps = {
  collaborators: [{ clientId: 2, userId: 2, name: "Rahul", role: "editor", color: "#89b4fa", status: "online", activity: { type: "viewing", timestamp: 0 }, lastActive: Date.now() }],
  currentUserId: 1, runStatuses: [], isDnd: false, followingUserId: null,
  onToggleDnd: vi.fn(), onFollowCollaborator: vi.fn(), onJumpToCollaborator: vi.fn(),
  onOpenTeamPanel: vi.fn(),
} as any;

it("shows the attention badge only when count > 0", () => {
  const { rerender } = render(<CollaboratorAvatarStack {...baseProps} incomingRequestCount={0} />);
  expect(document.querySelector(".collab-attn-badge")).toBeNull();
  rerender(<CollaboratorAvatarStack {...baseProps} incomingRequestCount={2} />);
  expect(screen.getByLabelText(/2 attention requests/i)).toBeTruthy();
});

it("still opens the team panel on chip click and keeps the quick popover", () => {
  const onOpenTeamPanel = vi.fn();
  render(<CollaboratorAvatarStack {...baseProps} incomingRequestCount={1} onOpenTeamPanel={onOpenTeamPanel} />);
  screen.getByRole("button", { name: /open team panel/i }).click();
  expect(onOpenTeamPanel).toHaveBeenCalled();
  // per-avatar popover still reachable
  screen.getByRole("button", { name: /Collaborator Rahul/i }).click();
  expect(document.querySelector(".collab-popover")).not.toBeNull();
});
```

- [ ] **Step 2: Run — verify fail** → FAIL.

- [ ] **Step 3: Implement** the prop threading + badge + `ide-focus-attention-tray` dispatch/listener + CSS.

- [ ] **Step 4: Run — verify pass** → PASS.

- [ ] **Step 5: Regression** → `cd frontend && npx vitest run test/CollaboratorAvatarStack.test.tsx test/TeamPanel.test.tsx test/CollaboratorAvatarStack.attention.test.tsx` → PASS, existing unchanged.

- [ ] **Step 6: Stage for review**

```bash
git add frontend/src/components/Toolbar/Toolbar.tsx frontend/src/components/Collab/CollaboratorAvatarStack.tsx frontend/test/CollaboratorAvatarStack.attention.test.tsx frontend/src/styles/collab.css
```

**Review checkpoint:** badge counts **only** `incomingRequestCount` (requests targeted at me — computed in `IDE.tsx` Task 13), never points/callouts; the quick popover and TeamPanel behaviour are byte-unchanged. **Rollback point:** remove the badge span + prop; chip reverts to the plain count.

---

## PHASE 8 — Security / lifecycle test consolidation

### Task 19: Adversarial backend + frontend security suite

**Files:**
- Modify: `backend/test/m58-attention.test.ts` (add a `describe("M58 — security")` block)
- Modify: `frontend/test/collab.attention.test.ts` / `frontend/test/Editor.attention.test.tsx` (add the XSS + no-mutation guards if not already covered)

Most items are already covered by Phases 1–7. This task adds the **explicitly-named** gaps and consolidates so a reviewer can check the security model against one block. Add tests for each of these that are not already green:

Backend (`describe("M58 — security")`):
- [ ] **spoofed author** — already Task 6; assert again here with a callout + a request.
- [ ] **forged target** — `attention_request` with `targetUserId` of a user in a *different* room → dropped (extend the isolation test).
- [ ] **forged event id on create** — `attention_point`/`callout`/`request` payloads carrying `id: "…"` → the delivered event's `id` is server-generated and ≠ the supplied one.
- [ ] **duplicate event id** — two requests in a row → different ids; a client cannot pin an id.
- [ ] **unauthorized dismissal** — Task 8 covers non-target + author; add: a user from another room sending `attention_dismiss` with a valid-looking id → no-op (rooms don't share a registry, so this is structurally impossible; assert it).
- [ ] **unauthorized "acted"** — same as dismissal but with `acted: true` → still requires `targetUserId === dismisser`.
- [ ] **huge payload** — a `message` of 100 KB → capped at 280 in the delivered event; a 2 MiB frame → rejected by `DEFAULT_WS_MAX_PAYLOAD` before the handler (document this; a unit test drives a 300 KB `message` through `handleAttentionMessage` directly and asserts ≤280 + no throw).
- [ ] **invalid file path** — `file: "/etc/passwd"`, `file: "..\\..\\x"`, `file: "C:\\x"`, `file: "a\u0000b"` → all dropped.
- [ ] **invalid/reversed ranges** — covered Task 1/2; assert through the room once.
- [ ] **control chars in message** — delivered message has them replaced by spaces.
- [ ] **cross-project leakage** — Task 9; assert points, callouts, AND requests.
- [ ] **offline target** — `attention_request` to a userId that has a DB grant but no live socket → dropped.
- [ ] **self-target** — Task 7.
- [ ] **request replay after expiry** — Task 9.
- [ ] **rate-limit multi-tab note** — two sockets for the same user each get their own 10/10s bucket (intentional: per connection), BUT the per-author outstanding-request cap (3) still bounds targeted-request spam across all their tabs. Add a test: user 1 opens 2 sockets, sends 3 requests from socket A and 1 from socket B → only 3 registry entries, the 4th (from B) rejected with `attention_rate_limited`.
- [ ] **bounded registry** — Task 5 (unit) + a room test with `ATTENTION_MAX_REGISTRY_ENTRIES` monkey-patched low.
- [ ] **author disconnect / target disconnect / reconnect snapshot / expiry** — Task 9.
- [ ] **duplicate sessions** — the multi-tab reconnect-snapshot test from Task 9.
- [ ] **no persistence** — Task 9; also assert no `db` writes by snapshotting a `SELECT count(*)` over every table before/after (mirror the pattern in `m57-presence.test.ts` if present, else `db.prepare("SELECT name FROM sqlite_master WHERE type='table'")` + per-table count).
- [ ] **document unaffected** — Task 9 convergence test.

Frontend:
- [ ] **XSS via callout bubble** — Task 15.
- [ ] **XSS via tray card** — Task 17.
- [ ] **no document mutation from any attention render** — Task 15 + add one asserting the tray render does not touch any Monaco model.
- [ ] **stale attention removal on reset/dispose** — Task 12.

- [ ] **Step: Run the consolidated suites**

Run: `cd backend && npx vitest run test/m58-attention.test.ts && cd ../frontend && npx vitest run test/collab.attention.test.ts test/Editor.attention.test.tsx test/AttentionTray.test.tsx test/Editor.nearby.test.tsx`
Expected: PASS — all.

- [ ] **Step: Stage for review**

```bash
git add backend/test/m58-attention.test.ts frontend/test/*.test.ts frontend/test/*.test.tsx
```

**Review checkpoint:** every bullet above maps to a named test; the security model in spec §10 has a corresponding assertion. **Rollback point:** N/A (tests only).

---

### Task 20: Follow / M57-integration tests

**Files:**
- Create: `frontend/test/collab.follow.attention.test.tsx`

**Interfaces:** none — behavioral only.

- [ ] **Step 1: Write the tests**

```tsx
it("a callout/request arriving mid-Follow does not cancel Follow", () => {
  // render <IDE> following user 2; emit an attention_event; assert followedUserId unchanged
});
it("navigating to attention opens the file like a manual open (Follow pause rules apply)", () => {
  // following user 2, local file dirty; click Go there for a request on another file;
  // assert openAndRevealLocation was invoked and Follow paused with the existing
  // "you have unsaved changes" reason (same as a manual open) — NOT a new code path
});
it("the same-file strip (M57) and the attention decorations coexist without duplication", () => {
  // collaborator in the same file + a callout from them; assert one samefile chip
  // AND one callout bubble, not merged/duplicated
});
```

- [ ] **Step 2: Run — verify fail** → FAIL.

- [ ] **Step 3: Implement** — no production code expected; if a test reveals Follow being cancelled by attention, the fix is to ensure attention navigation reuses `handleOpenFile`/`openAndRevealLocation` and does not call `handleUserEdit`/`setFollowedUserId(null)`. Document any fix here.

- [ ] **Step 4: Run — verify pass** → PASS.

- [ ] **Step 5: Full frontend suite**

Run: `cd frontend && npx vitest run && npx tsc --noEmit && npx eslint src/ && npm run build`
Expected: **366 + all new** passed / 0 failed; 0 type errors; 0 lint errors (pre-existing warnings OK); build exit 0.

- [ ] **Step 6: Full backend suite**

Run: `cd backend && npx vitest run && npx tsc --noEmit && npx eslint src/`
Expected: **804 + all new** passed / 0 failed / 9 skipped; 0 errors.

- [ ] **Step 7: `git diff --check`**

Run: `git diff --check`
Expected: clean (no whitespace errors).

- [ ] **Step 8: Stage for review**

```bash
git add frontend/test/collab.follow.attention.test.tsx
```

**Review checkpoint:** attention never cancels Follow; navigation reuses the existing open primitive; M57 surfaces are untouched. **Rollback point:** N/A (tests only, plus any documented Follow fix).

---

## PHASE 9 — Browser verification

### Task 21: Two-session behavioral acceptance

**Files:** none (verification only). Produces evidence for `STATUS.md` (Task 22).

**Preconditions:** Phases 1–8 complete and green. Docker running. Dev server startable (`npm run dev` from repo root → backend `:3000`; `cd frontend && npm run dev` → `:5173`).

- [ ] **Step 1: Decide the harness.** Check whether the `claude-in-chrome` extension is connected (`mcp__claude-in-chrome__tabs_context_mcp`).
  - **If connected:** drive two real authenticated Chrome tabs (two users, same project) through the full script and capture screenshots/GIF. This is **browser visual verification**.
  - **If not connected:** run a headless two-client script against the running dev server using real cookie-authenticated WebSockets to `/ws/collab` (mirror `backend/scratch-test.js`). Real transport, real `CollaborationRoom`, real registry. This is **browser behavioral verification (PARTIAL for visual)** — never reported as visual.

- [ ] **Step 2: Run the acceptance script.** Verify, recording pass/fail per step:
  1. Two sessions present (both see each other via M57 avatar stack / TeamPanel).
  2. Rahul selects lines 40–52 in `auth/session.ts`.
  3. Rahul sends a **point**. → Peer sees the point indicator at line ~40 within ~1 s.
  4. Peer clicks the point → `auth/session.ts` opens (if closed) and reveals the range, editor focused.
  5. Rahul sends a **callout** "the race is here". → Peer sees the bubble at the exact range with Rahul's colour + message as text.
  6. Peer navigates to the callout → open-then-reveal.
  7. Rahul sends **"come look here"** targeting the peer, message "look". → Peer's `AttentionTray` shows the request card; Rahul sees "✓ Sent".
  8. Peer clicks **Go there** → correct file opens, correct range revealed, editor focused; card disappears for the peer.
  9. Peer sends another request; then the peer **dismisses** it → gone for both.
  10. Rahul sends a fresh request to the peer, then **Rahul disconnects** (closes the tab). → within the grace window the peer's request card disappears (`author_gone`); Rahul's transient point/callout indicators disappear for the peer.
  11. **Rahul reconnects.** → no stale point/callout/request resurrects; the peer sees exactly one Rahul in presence.
  12. Rahul and the peer edit lines ~45–55 concurrently. → **nearby/overlap badge** appears; both edits converge; no full-file clobber; no reload.
  13. Rahul and the peer edit lines ~40 vs ~300. → **no** spatial badge.
  14. A third session in a **different project** → sees none of project 1's attention (point, callout, or request).
  15. Confirm (devtools / network) that no attention traffic hits any REST endpoint and no `MESSAGE_SYNC` frame carries attention data — attention is `MESSAGE_CUSTOM` only, and `doc` content is unchanged.

- [ ] **Step 3: Record results** — a table of the 15 checks with PASS/PARTIAL/NOT_PROVEN and the harness used. Screenshots/GIF only if the extension was connected.

**Review checkpoint:** every claim is backed by an actual run; visual claims only if the real React UI was exercised in a browser. **Rollback point:** N/A.

---

## Final Task: STATUS.md

### Task 22: Document M58

**Files:**
- Modify: `STATUS.md` — add a `## Milestone 58 — Live Attention, Callouts & Spatial Collaboration` section after the M57 section. Do **not** rewrite M1–M57.

**Content (fill with real numbers from the verification runs):**
- **Objective** — one paragraph (the "yo, come look at this" boundary).
- **Already existed (reused, not reimplemented):** `MESSAGE_CUSTOM` transport + `broadcastRunStatus`/`addClient`-snapshot pattern, `CollaborationRoom.clients` map for targeting, `requireProjectAccess` room gate, server-authoritative identity, `sanitizeAwarenessFilePath` / `isAwarenessCoord`, M57 `CollaboratorPresence` + `collaboratorsInFile` + `getUserColor`, `Editor.tsx` `nearbyEditingCollaborators` (extended), `openAndRevealLocation` open-then-reveal primitive, `throttleLatest`, Monaco `editor.addAction`. **None mutated.**
- **What M58 added:** the 4-event `MESSAGE_CUSTOM` vocabulary (`attention_point/callout/request/dismiss` in, `attention_event/attention_cleared` out); `backend/src/collab/attention.ts` (pure domain + `RateLimiter` + `AttentionRequestRegistry`); `CollaborationRoom` attention branch + targeted delivery + bounded registry + expiry timers + join snapshot + disconnect cleanup; `frontend/src/collab/attention.ts` + `AttentionStore`; `CollaborationClient` senders/receiver; `IDE.tsx` throttled `attention` state + canonical navigation + Jump retrofit; `Editor.tsx` Point/Call out/Come look actions + point & callout decorations + three-tier spatial awareness; `AttentionComposer`; `AttentionTray`; collaborator-chip attention badge.
- **Attention protocol / lifecycle / security** — summarize spec §5, §6, §10; state the reviewer-approved decisions (drop-4th-request, 90 s callout ceiling, badge counts only actionable requests, dismiss authz).
- **Deliberately NOT in M58:** change attribution (M60), activity history, while-you-were-away, persistent comments/threads/chat/reactions, semantic conflict resolution, raw terminal/stdout/stderr sharing, AI collaboration, analytics, any DB/Git/Yjs/file persistence of attention, a new WS endpoint.
- **Files added / changed** — the full list from this plan's File Structure table.
- **Verification (date, Docker available):** exact backend Vitest count (`804 baseline + N`), `collab-awareness-security.test.ts` + `m57-presence.test.ts` unchanged, `tsc`/`eslint` clean; exact frontend Vitest count (`366 baseline + M`), `tsc`/`eslint`/`build` clean; `git diff --check` clean; the Task 21 acceptance table with the harness used; **browser visual: PROVEN or PARTIAL** per what actually ran.
- **Acceptance matrix** — the full matrix from the brief with each row classified PROVEN / PARTIAL / NOT_PROVEN and one line of evidence each.
- **Remaining limitations / M59+ roadmap** — spec §15.

- [ ] **Step 1: Write the section** with real verification numbers.
- [ ] **Step 2: Re-run** `cd backend && npx vitest run` and `cd frontend && npx vitest run` one final time; paste the exact summary lines into the section.
- [ ] **Step 3: Stage for review** (do NOT commit)

```bash
git add STATUS.md docs/superpowers/specs/2026-08-30-m58-live-attention-callouts-design.md docs/superpowers/plans/2026-08-30-m58-live-attention-callouts.md
```

**Review checkpoint:** numbers are from a fresh run, not this plan's baselines; skipped tests are reported as skipped, not passed; visual vs behavioral is distinguished. **Rollback point:** revert the `STATUS.md` addition.

---

## Self-review (run against the spec after the plan is written)

**1. Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §3 reuse inventory | Tasks 6, 13, 14, 16, 18 (each reuse point named) |
| §4.1 new modules | Tasks 1–5 (backend), 10–12 (frontend), 14/17 (components) |
| §5.1–5.2 protocol | Tasks 2, 3, 6, 7, 8, 12 |
| §5.3 opaque id | Tasks 2 (`newAttentionId`), 19 (forge/dup tests) |
| §5.4 validation | Tasks 2, 6, 19 |
| §5.5 rate limiting | Tasks 4, 5, 6, 7, 19 (multi-tab) |
| §6.1 point lifecycle | Tasks 6, 11 |
| §6.2 callout ceiling | Tasks 3 (server 90 s), 11 (client `touchCallout`), 19 |
| §6.3 request registry | Tasks 5, 7, 8, 9 |
| §6.4 join snapshot | Task 9 |
| §6.5 no persistence | Tasks 9, 19 |
| §7 range semantics | Task 1 (+ Task 10 parity) |
| §8 spatial tiers | Task 16 |
| §9.1 author actions | Task 14 |
| §9.2–9.3 decorations | Task 15 |
| §9.4 tray | Task 17 |
| §9.5 navigation | Task 13 |
| §9.6 chip badge | Task 18 |
| §10 security | Task 19 (consolidated) + inline in 6/7/8/9/15/17 |
| §11 performance | Tasks 13 (throttle), 15 (decoration diffing), 9/19 (timers/bounds) |
| §12 testing | every task is TDD; Tasks 19, 20 consolidate |
| §13 browser acceptance | Task 21 |
| §14 non-goals | Task 22 (documented); no task implements any |
| §15 roadmap | Task 22 |
| §17 approved decisions | Tasks 3, 7, 11, 8, 18 |

No gaps.

**2. Placeholder scan:** the plan contains real code for every pure function and real test code for every task. The React-integration tasks (13, 14, 15, 16, 17, 18) give concrete `Interfaces` blocks with exact prop/method signatures and real test bodies; the "follow the repo's Editor/IDE test harness" notes point at named existing files (`collab.awareness.test.ts`, existing `Editor.*`/IDE tests) rather than inventing one — acceptable because those harnesses exist and the plan says which to copy. No "TBD"/"add error handling"/"similar to Task N".

**3. Type consistency:**
- `AttentionEvent` shape identical in backend Task 3 and frontend Task 10 (frontend drops the transport `type` discriminant when stored; wire objects keep it).
- `AttentionRange` = `{ startLine, startColumn, endLine, endColumn }` everywhere.
- `normalizeRange` / `rangesOverlap` — same signature and semantics both sides (Task 1 body copied in Task 10, parity-tested).
- `clearAttentionRequest(id, reason)` — same name Task 7 (minimal) → Task 8 (full). Not renamed.
- `AttentionRequestRegistry` methods (`tryAdd`/`get`/`delete`/`byTarget`/`deleteByAuthor`/`deleteByTarget`/`size`/`clear`) — defined Task 5, used unchanged in Tasks 7, 8, 9.
- `sendAttentionTo` / `broadcastAttention` — defined Task 6, used Tasks 7, 8, 9.
- Client `dismissAttentionRequest(id, acted?)` (Task 12) ↔ tray `onDismiss(id, acted?)` (Task 17) ↔ IDE `handleAttentionDismiss(id, acted?)` (Task 13) — consistent.
- `incomingRequestCount` — `AttentionStore` method (Task 11) and the IDE-computed prop for the chip (Tasks 13, 18) use the same definition (request kind, targeted at me, not self-authored).

Consistent.

---

## Adversarial plan review (per the brief's checklist)

- **Every event has a clear owner?** Yes — points/callouts: no owner (pure relay, client TTL). Requests: the room's `AttentionRequestRegistry` + one expiry timer each. The client `AttentionStore` owns *rendering* lifetime only.
- **Can a malicious client clear another user's request?** No — Task 8: dismiss requires the entry to exist AND `targetUserId === dismisser.userId`; cross-room is structurally impossible (per-room registry); guessed ids miss.
- **Can attention state survive too long?** No — point 6 s (client), callout 90 s hard server ceiling (Task 3 `expiresAt`; `touchCallout` clamped, Task 11), request 120 s server timer (Task 7/8). Registry capped at 200 with oldest-eviction (Task 5).
- **Can reconnect replay stale events?** No — join snapshot (Task 9) sends only `byTarget(thisUser)` entries with `expiresAt > now`; expired entries are already deleted by their timer; author-leave deletes the entry entirely.
- **Can project switching leak events?** No — `resetLocalCollabState` clears the client store (Task 12); rooms never cross-fan-out (Task 9 isolation test); the IDE effect `setAttention([])` on teardown (Task 13).
- **Can rate limits be bypassed through multiple tabs?** The per-connection 10/10 s bucket is per-socket by design, BUT the per-author outstanding-request cap (3, across all the author's sockets — `countByAuthor` in the registry) bounds the abuse that matters (targeted spam). Task 19 has an explicit multi-tab test. Points/callouts from N tabs are bounded at 10·N/10 s — acceptable for a broadcast that carries no target and auto-expires in 6–90 s; noted in the spec.
- **Can a room registry grow without bound?** No — `ATTENTION_MAX_REGISTRY_ENTRIES = 200`, oldest-eviction (Task 5), and every entry expires ≤120 s.
- **Can callout visibility extend beyond the hard ceiling?** No — server `expiresAt = createdAt + 90 s` is the ceiling (Task 3); `touchCallout` is `Math.min(now + 45 s, expiresAt)` and the removal timer is `min(local, expiresAt - now)` (Task 11); Task 11 test drives 200 s of touching and asserts removal.
- **Same-line range boundaries correct?** Task 1: half-open `[startColumn, endColumn)` → touching is NOT overlap; zero-width cursor at the exclusive end is NOT overlap; explicit tests for each.
- **Can closed-file navigation bypass open-before-reveal?** No — Task 13 routes `handleAttentionNavigate` AND the retrofitted `handleJumpToCollaborator` through `openAndRevealLocation`; Task 13 + Task 20 assert `open` strictly precedes `reveal`.
- **Does attention mutate the Yjs document?** No — no attention code path imports `Y` or touches `doc.share`/`doc.getText`; Tasks 9, 15, 19 assert `doc.share.size` unchanged and no `model.setValue`.
- **Does attention become another presence store?** No — the client holds `AttentionStore` (transient events, not collaborators); `IDE.tsx` still has one `collaborators` array; spatial tiers (Task 16) read `CollaboratorPresence` directly.
- **Does the UI become noisy?** Point 6 s fade; callout 45 s; tray max 3 cards + collapse; badge is a number, not a toast stack; no sound; `role="status"`/`role="region"` not `alert`. Spec §9, §16.
- **Does the badge count only actionable incoming requests?** Yes — Tasks 13 + 18: `kind === "request" && targetUserId === me && author.userId !== me`.
- **Does the quick collaborator popover remain intact?** Yes — Task 18 explicitly does not touch the `selectedCollaborator` block and has a regression test.

No revisions required.

---

## Final Plan Output (summary)

1. **Architecture** — §"Architecture" above: `MESSAGE_CUSTOM` transport, pure `attention.ts` domain module both sides, room-owned bounded registry + timers, client `AttentionStore`, `openAndRevealLocation` for all navigation. Yjs + M57 awareness untouched.
2. **Event/data model** — 4 authored types (`attention_point/callout/request/dismiss`), 2 server types (`attention_event` with `kind` point/callout/request, `attention_cleared` with `reason`), opaque `crypto` id, server-stamped `author`/`createdAt`/`expiresAt`. Full shapes in spec §5 and plan Tasks 2–3.
3. **Implementation tasks** — 22 tasks across 9 phases (above), each TDD, each with rollback + review checkpoint.
4. **Dependency graph** — §"Dependency graph" above. Phases 1 & 3 parallel; 2←1; 4←3; 5,6←4; 7←4,6; 8←2,5,6; 9←all.
5. **Test strategy** — pure-function unit tests (Tasks 1–5, 10–11), real-`CollaborationRoom` transport/lifecycle tests with `makeWs()` + fake timers (Tasks 6–9), `AttentionStore` fake-timer lifecycle (Task 11), component tests (Tasks 14–18), consolidated security block (Task 19), Follow/M57 integration (Task 20). Every essential line has a revert-failing behavioral test.
6. **Security strategy** — spec §10 mapped to Task 19 + inline assertions; author-forcing, target-membership, dismiss-authz, opaque ids, per-room isolation, bounded registry, text-only rendering, path sanitization, malformed-safe.
7. **Browser acceptance** — Task 21: 15-step two-session script; real Chrome if the extension is connected (visual), else headless dual-WS (behavioral, PARTIAL visual).
8. **Performance** — one throttled `attention` state (200 ms), decoration diffing by id, per-request single `unref` timer, registry cap 200, no DB/Yjs/awareness writes, no global interval. Asserted in Tasks 9, 13, 15, 19.
9. **Rollback/checkpoints** — every task ends with an explicit rollback point and a review checkpoint; Phases 1, 3, 10 leave new files unreferenced (trivial revert); Phases 2, 4–7 are additive branches/props (revert = remove the branch).
10. **Plan path** — `docs/superpowers/plans/2026-08-30-m58-live-attention-callouts.md`.

**No unresolved architectural decisions.** All of the brief's §17 items were decided in the approval message and are baked into Tasks 3, 7, 8, 11, 18.

**DO NOT COMMIT.** Every task stages with `git add` only.
