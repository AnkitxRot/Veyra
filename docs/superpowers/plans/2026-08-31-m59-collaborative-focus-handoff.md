# M59 — Collaborative Focus & Context Handoff — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire M57 presence + M58 attention + M48 Follow + the canonical navigation primitive into one "shared focus" experience: step into a collaborator's context, optionally Follow them, receive another collaborator's attention without corrupting the current Follow, and Return to exactly where you were.

**Architecture:** Frontend-only. No new transport, no backend change, no new store, no persistence, no Yjs/awareness writes. Two new pure modules (`frontend/src/collab/focus.ts`, `frontend/src/collab/followAnchor.ts`); a view-state ref API on `Editor` mirroring the existing `liveApiRef`; a single `focusOn(userId, {follow})` controller in `IDE.tsx` that owns the one `followedUserId`, the one `followAnchorRef`, and the one `followAbsenceTimerRef`; additive `[Follow]` / `[Return to my location]` affordances on existing surfaces.

**Tech Stack:** TypeScript, React 18, Vite, Monaco (`editor.saveViewState()` / `restoreViewState()`), Vitest (jsdom, `@testing-library/react`, fake timers, the `test/mocks/monaco.ts` `FakeEditorInstance`).

**Spec:** `docs/superpowers/specs/2026-08-31-m59-collaborative-focus-handoff-design.md` — read it alongside this plan. The 14 final decisions in the approval message and the spec's §15 override any ambiguity.

## Global Constraints

- **Frontend-only.** No `MESSAGE_CUSTOM` type, no awareness field, no second collaborator array, no DB, no Yjs op, no polling, no per-second render, no new WebSocket endpoint.
- **One active Follow target.** Exactly one `followedUserId: number | null`. No multi-follow.
- **Anchor = the original pre-follow context.** Captured **once**, only when entering Follow from an unfollowed state (`followAnchorRef.current == null` guard). **Never recaptured** on a Follow-target switch (A→B). Discarded on the first Stop / Return / project-switch / disposal / unmount / `forbidden`.
- **One-shot `[Go there]` is not Follow** — it navigates, creates no anchor, starts no Follow.
- **`[Follow X]` while following Y** → stop Y, preserve the anchor, navigate to X, follow X.
- **`[Go there X]` while following Y** → stop Y, preserve the anchor, navigate to X, do **not** follow X.
- **`Stop following`** clears the target, discards the anchor, stays put. **`Return to my location`** clears the target, restores the anchor, discards it afterward.
- **Follow-absence grace ≈ 6000 ms, keyed by `userId`.** A reconnect with a new `clientId` + same `userId` within the window resumes Follow. A reconnect after the window **must not** auto-refollow. Clear the timer on: target return, explicit Stop, Return, project switch, disposal, component teardown. No timer leaks; no two timers for one target; a stale timer must not clear a freshly-established Follow.
- **Monaco model safety.** A saved `viewState` is restored **only** after the correct file is the active file **and** its Monaco model is attached (active-model path guard). Otherwise defer, then fall back to the cursor-based reveal. **Never** restore view state into another file's model. **Never** serialize model content — the anchor is navigation context only.
- **Dirty safety.** Anchor restoration never mutates content, never reloads/clobbers a dirty buffer. Tab switching is safe; content mutation is not part of M59.
- **All navigation** (Follow tracking, Jump, attention `[Go there]`, callout/point click, Return) goes through `openAndRevealLocation(handleOpenFile, target)` or `handleOpenFile` + the existing `ide-reveal-location` / `ide-restore-view-state` events. No second navigation mechanism.
- **Preserve** M58 `AttentionStore` TTLs (point 6 s / callout 45 s, 90 s ceiling / request server-driven) and M57 availability/activity wire enums. `FocusState` is a **UI-only** derived enum, never sent.
- **Attention expiring while following does not touch Follow** (Follow tracks presence, not attention).
- **Commits require explicit approval** (`CLAUDE.md`) and the brief says **DO NOT COMMIT.** Every task ends with `git add` only.
- **Do not revert the existing staged M57/M58 work or the unstaged pre-M57 (`sandbox.ts`, `deploy/README.md`, …) work.** Keep M59 changes distinguishable — new files plus additive props.
- **Verification baselines (2026-08-31, Docker available):** backend **873 passed / 1 failed (`python-deps` — pre-existing network/Docker flake, zero collab code) / 9 skipped**; the clean-run number for the collab gate is that all 70 M58 + all M57 + all collab regression files pass. Frontend **414 passed / 0 failed**. Frontend `tsc` 0 errors; `eslint` 0 errors / 19 pre-existing warnings; `vite build` exit 0.
- Run frontend tests from `frontend/` (`npx vitest run <file>`), backend from `backend/`.

---

## Shared constants (in `frontend/src/collab/focus.ts`)

```ts
export const FOLLOW_ABSENCE_GRACE_MS = 6_000;   // ws-blip / reconnect grace, keyed by userId
export const FOLLOW_LEFT_NOTICE_MS = 8_000;     // "Rahul left" mini-banner auto-dismiss (→ Stay)
```

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `frontend/src/collab/focus.ts` | **Create** | `FocusState`, `FocusContext` types; `deriveFocusState(user, attention, isFollowing)`; `buildFocusContext(user, allAttention, currentUserId, followedUserId)`; the two grace constants. Pure. |
| `frontend/src/collab/followAnchor.ts` | **Create** | `FollowAnchor` type; `anchorFilePresent(anchor, fileIndexPaths, openPaths)`; `describeAnchorFile(anchor)` (basename for the toast). Pure — no Monaco, no React. |
| `frontend/test/collab.focus.test.ts` | **Create** | Pure unit tests for both modules. |
| `frontend/src/components/Editor/Editor.tsx` | Modify | `editorViewApiRef` prop + populate/detach (mirror `liveApiRef`); `ide-restore-view-state` listener → `restorePendingRef`, consumed by a model-active guard effect; callout-bubble `[Follow]` + bubble/point click → `ide-attention-activate` / `ide-attention-follow`. |
| `frontend/test/mocks/monaco.ts` | Modify | `saveViewState()` / `restoreViewState(vs)` on `FakeEditorInstance` (opaque token + call recording); `_setActiveModelPath` / model-attached signalling helpers. |
| `frontend/test/Editor.viewstate.test.tsx` | **Create** | Model-safe save/restore: never restores while the wrong file is active; restores once when the right model is attached; cursor fallback. |
| `frontend/src/components/IDE/IDE.tsx` | Modify | `followAnchorRef`, `followAbsenceTimerRef`, `followedUserIdRef`, `collaboratorsRef`, `lastFollowedRef`, `followLeftNotice` state, `editorViewApiRef`; `captureAnchor()`, `focusOn(userId, {follow})`, `handleReturnToMyLocation()`; rework `handleFollowCollaborator`/`handleStopFollowing` onto them; grace-window logic in the follow-tracking effect; `ide-attention-activate` / `ide-attention-follow` listeners; anchor/timer cleanup in the collab-effect teardown and on `connection_change === "forbidden"`; render the "left" mini-notice. |
| `frontend/src/components/Collab/FollowBanner.tsx` | Modify | `hasAnchor?: boolean` + `onReturnToLocation?: () => void` + `followedRange?: {startLine,endLine} \| null` props; render `[Return to my location]` when `hasAnchor`; show `Lines A–B` when `followedRange`. Esc still = Stop. |
| `frontend/src/components/Collab/AttentionTray.tsx` | Modify | `onFollow: (e: AttentionEvent) => void` prop; `[Follow]` button on request cards (→ `onFollow(e)`), between `[Go there]` and `[Dismiss]`. |
| `frontend/src/components/Collab/CollaboratorAvatarStack.tsx` | Modify | `attention?: AttentionEvent[]` prop; in the `selectedCollaborator` popover render a focus-context block (latest callout message as text, `Lines A–B`, a `.focus-state-*` chip) via `focus.ts`. Follow/Unfollow + Jump buttons unchanged (already call `onFollowCollaborator` / `onJumpToCollaborator`). |
| `frontend/src/components/Toolbar/Toolbar.tsx` | Modify | thread `attention` to `CollaboratorAvatarStack`. |
| `frontend/src/components/IDE/IDE.tsx` (Editor render) | Modify | pass `editorViewApiRef`; keep `attention` / `onAttentionNavigate` / `onViewCollaborator`. |
| `frontend/src/styles/collab.css` | Modify | `.follow-banner` return button + range line; `.follow-left-notice`; `.collab-popover` focus rows; `.focus-state-{idle,viewing,focused,following}` chips; callout `[Follow]`. |
| `frontend/test/collab.focus.follow.test.tsx` | **Create** | The 37 IDE-level behavioral cases (anchor, follow, attention, multi-collaborator, lifecycle, security). |
| `frontend/test/collab.follow.test.tsx` | Modify (only if needed) | Existing 7 are component-level and should stay green untouched; touch only if a FollowBanner prop change surfaces. |
| `STATUS.md` | Modify | New `## Milestone 59` section (final task). |

---

## Dependency graph

```
Phase 1 (focus.ts + followAnchor.ts, pure) ─┐
Phase 2 (Editor view-state API + mock)   ───┤
                                            ├─> Phase 3 (IDE focus controller: focusOn, anchor, grace)
                                            │        │
                                            │        ├─> Phase 4 (FollowBanner / popover / AttentionTray wiring)
                                            │        └─> Phase 5 (Editor attention-click → focus)
                                            │
                                            └─> Phase 6 (adversarial lifecycle/security suite) <── Phases 3,4,5
                                                        │
                                            Phase 7 (browser verification) <── all
                                                        │
                                                Final Task: STATUS.md
```

- **Phases 1 and 2 are independent** (different files) — may be done in either order / parallel.
- **Phase 3 depends on 1 + 2.** **Phases 4 and 5 depend on 3.** **Phase 6 depends on 3 + 4 + 5.** **Phase 7 depends on everything.**

---

## PHASE 1 — Pure focus / anchor domain logic

### Task 1: `focus.ts` — `deriveFocusState` + `buildFocusContext`

**Files:**
- Create: `frontend/src/collab/focus.ts`
- Test: `frontend/test/collab.focus.test.ts`

**Interfaces:**
- Consumes: `CollaboratorPresence`, `ActivityType` from `./presence`; `AttentionEvent`, `AttentionRange` from `./attention`.
- Produces:
  - `export const FOLLOW_ABSENCE_GRACE_MS = 6_000;`
  - `export const FOLLOW_LEFT_NOTICE_MS = 8_000;`
  - `export type FocusState = "idle" | "viewing" | "focused" | "following";`
  - `export interface FocusContext { user: CollaboratorPresence; file: string | null; range: AttentionRange | null; activity: ActivityType; attention: AttentionEvent | null; state: FocusState; isFollowing: boolean; timestamp: number; }`
  - `export function deriveFocusState(user: CollaboratorPresence, attention: AttentionEvent | null, isFollowing: boolean): FocusState`
  - `export function latestAttentionFrom(list: AttentionEvent[], authorUserId: number, currentUserId: number): AttentionEvent | null` — newest `e` where `e.author.userId === authorUserId` AND (`e.targetUserId === currentUserId` OR `e.targetUserId == null`).
  - `export function buildFocusContext(user: CollaboratorPresence, allAttention: AttentionEvent[], currentUserId: number, followedUserId: number | null): FocusContext`

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/test/collab.focus.test.ts
import { describe, it, expect } from "vitest";
import {
  deriveFocusState,
  latestAttentionFrom,
  buildFocusContext,
  FOLLOW_ABSENCE_GRACE_MS,
  FOLLOW_LEFT_NOTICE_MS,
} from "../src/collab/focus";
import type { CollaboratorPresence } from "../src/collab/presence";
import type { AttentionEvent } from "../src/collab/attention";

const user = (o: Partial<CollaboratorPresence> = {}): CollaboratorPresence => ({
  clientId: 1, userId: 2, name: "Rahul", role: "editor", color: "#89b4fa",
  status: "online", activity: { type: "viewing", timestamp: 0 }, lastActive: 100,
  ...o,
});
const evt = (o: Partial<AttentionEvent>): AttentionEvent => ({
  id: o.id ?? "a", kind: o.kind ?? "callout",
  author: o.author ?? { userId: 2, username: "Rahul", color: "#89b4fa" },
  file: o.file ?? "auth/session.ts",
  range: o.range ?? { startLine: 40, startColumn: 1, endLine: 52, endColumn: 1 },
  message: o.message, targetUserId: o.targetUserId,
  createdAt: o.createdAt ?? 200, expiresAt: (o.createdAt ?? 200) + 90_000,
});

describe("M59 — constants", () => {
  it("pins the grace + notice windows", () => {
    expect(FOLLOW_ABSENCE_GRACE_MS).toBe(6_000);
    expect(FOLLOW_LEFT_NOTICE_MS).toBe(8_000);
  });
});

describe("M59 — deriveFocusState", () => {
  it("following wins over everything", () => {
    expect(deriveFocusState(user({ status: "away" }), evt({}), true)).toBe("following");
  });
  it("focused when there is a live attention event", () => {
    expect(deriveFocusState(user(), evt({}), false)).toBe("focused");
  });
  it("viewing when online + active and no attention", () => {
    expect(deriveFocusState(user({ activity: { type: "editing", timestamp: 0 } }), null, false)).toBe("viewing");
  });
  it("idle when away/idle or no signal", () => {
    expect(deriveFocusState(user({ status: "idle" }), null, false)).toBe("idle");
    expect(deriveFocusState(user({ status: "away" }), null, false)).toBe("idle");
  });
});

describe("M59 — latestAttentionFrom", () => {
  it("picks the newest event from that author targeted at me or broadcast", () => {
    const list = [
      evt({ id: "old", createdAt: 100 }),
      evt({ id: "new", createdAt: 300, targetUserId: 9 }),
      evt({ id: "mine", createdAt: 200, targetUserId: 9 }),
    ];
    expect(latestAttentionFrom(list, 2, 9)!.id).toBe("new");
  });
  it("ignores events authored by someone else or targeted at another user", () => {
    const list = [
      evt({ id: "other-author", author: { userId: 5, username: "P", color: "#1" }, createdAt: 400 }),
      evt({ id: "other-target", createdAt: 500, targetUserId: 999 }),
    ];
    expect(latestAttentionFrom(list, 2, 9)).toBeNull();
  });
});

describe("M59 — buildFocusContext", () => {
  it("assembles file/range/state from presence + attention", () => {
    const fc = buildFocusContext(
      user({ activeFile: "auth/session.ts", activity: { type: "editing", timestamp: 0 } }),
      [evt({ message: "race is here", createdAt: 300 })],
      9, null,
    );
    expect(fc.file).toBe("auth/session.ts");
    expect(fc.range).toEqual({ startLine: 40, startColumn: 1, endLine: 52, endColumn: 1 });
    expect(fc.state).toBe("focused");
    expect(fc.attention?.message).toBe("race is here");
    expect(fc.isFollowing).toBe(false);
    expect(fc.timestamp).toBe(300);
  });
  it("falls back to presence.activeFile and null range when no attention", () => {
    const fc = buildFocusContext(user({ activeFile: "a.ts" }), [], 9, null);
    expect(fc.file).toBe("a.ts");
    expect(fc.range).toBeNull();
    expect(fc.attention).toBeNull();
  });
  it("state is following when followedUserId matches", () => {
    expect(buildFocusContext(user({ userId: 2 }), [], 9, 2).state).toBe("following");
    expect(buildFocusContext(user({ userId: 2 }), [], 9, 2).isFollowing).toBe(true);
  });
});
```

- [ ] **Step 2: Run — verify fail** → `cd frontend && npx vitest run test/collab.focus.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `frontend/src/collab/focus.ts`**

```ts
// M59: pure derived "collaborative focus" view over the three existing sources
// of truth (M57 presence, M58 attention, M48 followedUserId). NOT a store —
// callers wrap in useMemo. FocusState is a UI-only enum, never sent on the wire.
import type { CollaboratorPresence, ActivityType } from "./presence";
import type { AttentionEvent, AttentionRange } from "./attention";

export const FOLLOW_ABSENCE_GRACE_MS = 6_000;
export const FOLLOW_LEFT_NOTICE_MS = 8_000;

export type FocusState = "idle" | "viewing" | "focused" | "following";

export interface FocusContext {
  user: CollaboratorPresence;
  file: string | null;
  range: AttentionRange | null;
  activity: ActivityType;
  attention: AttentionEvent | null;
  state: FocusState;
  isFollowing: boolean;
  timestamp: number;
}

export function deriveFocusState(
  user: CollaboratorPresence,
  attention: AttentionEvent | null,
  isFollowing: boolean,
): FocusState {
  if (isFollowing) return "following";
  if (attention) return "focused";
  const a = user.activity?.type;
  if (
    user.status === "online" &&
    (a === "viewing" || a === "editing" || a === "navigating")
  ) {
    return "viewing";
  }
  return "idle";
}

export function latestAttentionFrom(
  list: AttentionEvent[],
  authorUserId: number,
  currentUserId: number,
): AttentionEvent | null {
  let best: AttentionEvent | null = null;
  for (const e of list) {
    if (e.author.userId !== authorUserId) continue;
    if (e.targetUserId != null && e.targetUserId !== currentUserId) continue;
    if (!best || e.createdAt > best.createdAt) best = e;
  }
  return best;
}

export function buildFocusContext(
  user: CollaboratorPresence,
  allAttention: AttentionEvent[],
  currentUserId: number,
  followedUserId: number | null,
): FocusContext {
  const attention = latestAttentionFrom(allAttention, user.userId, currentUserId);
  const isFollowing = followedUserId === user.userId;
  return {
    user,
    file: user.activeFile ?? attention?.file ?? null,
    range: attention?.range ?? null,
    activity: user.activity?.type ?? "viewing",
    attention,
    state: deriveFocusState(user, attention, isFollowing),
    isFollowing,
    timestamp: Math.max(user.lastActive ?? 0, attention?.createdAt ?? 0),
  };
}
```

- [ ] **Step 4: Run — verify pass** → PASS.

- [ ] **Step 5: Typecheck** → `cd frontend && npx tsc --noEmit` → 0 errors.

- [ ] **Step 6: Stage for review** (do NOT commit)

```bash
git add frontend/src/collab/focus.ts frontend/test/collab.focus.test.ts
```

**Review checkpoint:** `FocusState` is UI-only (not exported into any wire type); `latestAttentionFrom` respects the targeted-or-broadcast filter; the module is pure (no React, no side effects). **Rollback point:** delete both files — nothing imports them yet.

---

### Task 2: `followAnchor.ts` — anchor representation + validation

**Files:**
- Create: `frontend/src/collab/followAnchor.ts`
- Modify: `frontend/test/collab.focus.test.ts`

**Interfaces:**
- Produces:
  - `export interface FollowAnchor { filePath: string; viewState: unknown; cursor: { line: number; column: number } | null; capturedAt: number; }`
  - `export function anchorFilePresent(anchor: FollowAnchor, knownPaths: Iterable<string>): boolean` — true iff `anchor.filePath` is in `knownPaths`.
  - `export function anchorFileBasename(anchor: FollowAnchor): string`

- [ ] **Step 1: Write the failing tests** (append to `collab.focus.test.ts`)

```ts
import {
  anchorFilePresent,
  anchorFileBasename,
  type FollowAnchor,
} from "../src/collab/followAnchor";

const anchor = (p: string): FollowAnchor => ({
  filePath: p, viewState: { __vs: true }, cursor: { line: 5, column: 1 }, capturedAt: 1,
});

describe("M59 — followAnchor", () => {
  it("anchorFilePresent checks membership", () => {
    expect(anchorFilePresent(anchor("src/a.ts"), ["src/a.ts", "src/b.ts"])).toBe(true);
    expect(anchorFilePresent(anchor("src/gone.ts"), ["src/a.ts"])).toBe(false);
  });
  it("anchorFileBasename returns the last path segment", () => {
    expect(anchorFileBasename(anchor("src/deep/Editor.tsx"))).toBe("Editor.tsx");
    expect(anchorFileBasename(anchor("main.py"))).toBe("main.py");
  });
});
```

- [ ] **Step 2: Run — verify fail** → FAIL.

- [ ] **Step 3: Implement**

```ts
// M59: the "return to my location" anchor — navigation context ONLY. viewState
// is an opaque monaco.editor.ICodeEditorViewState token (cursor + selection +
// scroll + folding); it is NEVER model content. Held in a useRef in IDE.tsx,
// captured once per follow session, discarded on Stop/Return/reset.
export interface FollowAnchor {
  filePath: string;
  viewState: unknown;
  cursor: { line: number; column: number } | null;
  capturedAt: number;
}

export function anchorFilePresent(
  anchor: FollowAnchor,
  knownPaths: Iterable<string>,
): boolean {
  for (const p of knownPaths) if (p === anchor.filePath) return true;
  return false;
}

export function anchorFileBasename(anchor: FollowAnchor): string {
  const parts = anchor.filePath.split("/");
  return parts[parts.length - 1] || anchor.filePath;
}
```

- [ ] **Step 4: Run — verify pass** → PASS.

- [ ] **Step 5: Stage for review**

```bash
git add frontend/src/collab/followAnchor.ts frontend/test/collab.focus.test.ts
```

**Review checkpoint:** `viewState` is typed `unknown` (opaque — no content). No Monaco import, no React. **Rollback point:** delete `followAnchor.ts`; revert the test appends.

---

## PHASE 2 — Editor view-state API + Monaco mock

### Task 3: Monaco mock — `saveViewState` / `restoreViewState`

**Files:**
- Modify: `frontend/test/mocks/monaco.ts`

**Interfaces:**
- `FakeEditorInstance` gains:
  - `saveViewState(): { __vs: true; id: number } | null` — returns a fresh tagged token each call (or `null` if no model); records nothing else.
  - `restoreViewState(vs: unknown): void` — records `lastRestoredViewState = vs` and `lastRestoredModelPath = <active model path>`.
  - test helpers: `_setActiveModelPath(p: string | null)` (sets what `getModel()` reports its `uri.path` as — or add a `FakeModel` with that path); `restoreCalls: Array<{ vs: unknown; modelPath: string | null }>`.
- Keep every existing export/behavior.

- [ ] **Step 1: Add the mock surface** (no test yet — exercised by Task 4/5)

```ts
// inside FakeEditorInstance
private viewStateCounter = 0;
public restoreCalls: Array<{ vs: unknown; modelPath: string | null }> = [];
public lastRestoredViewState: unknown = undefined;

saveViewState(): { __vs: true; id: number } | null {
  if (!this.model) return null;
  return { __vs: true, id: ++this.viewStateCounter };
}
restoreViewState(vs: unknown): void {
  const modelPath = this.model
    ? this.model.uri.path.replace(/^\//, "")
    : null;
  this.lastRestoredViewState = vs;
  this.restoreCalls.push({ vs, modelPath });
}
```

(`this.model` is the existing private `FakeModel | null` set by `setModel`. `FakeModel.uri.path` already exists. No `_setActiveModelPath` needed — tests drive `setModel` via the real component path.)

- [ ] **Step 2: Typecheck the mock** → `cd frontend && npx tsc --noEmit` → 0 errors (the mock is `.ts` under `test/`, included by tsconfig).

- [ ] **Step 3: Run the existing Editor tests unchanged** → `cd frontend && npx vitest run test/Editor.attention.test.tsx test/Editor.nearby.test.tsx test/Editor.sameFile.test.tsx test/Editor.saveTruthfulness.test.tsx test/collab.follow.test.tsx` → PASS (additive change).

- [ ] **Step 4: Stage for review**

```bash
git add frontend/test/mocks/monaco.ts
```

**Review checkpoint:** additive only; `saveViewState` returns a tagged opaque token; `restoreViewState` records which model path was active when it was called (the guard-verification hook). **Rollback point:** revert the mock additions.

---

### Task 4: `Editor` — `editorViewApiRef` + model-safe `ide-restore-view-state`

**Files:**
- Modify: `frontend/src/components/Editor/Editor.tsx`
- Create: `frontend/test/Editor.viewstate.test.tsx`

**Interfaces:**
- `EditorProps` gains `editorViewApiRef?: React.MutableRefObject<EditorViewApi | null>` where
  ```ts
  export interface EditorViewApi {
    save(): { filePath: string; viewState: unknown; cursor: { line: number; column: number } | null } | null;
    /** true iff the active model IS filePath and restoreViewState was applied. */
    restore(filePath: string, viewState: unknown): boolean;
  }
  ```
- On mount (in the same effect that sets `liveApiRef`), set `editorViewApiRef.current = { save, restore }`; detach (`= null`) in that effect's cleanup.
  - `save()`: `const ed = monacoRef.current; if (!ed) return null; const pos = ed.getPosition?.(); return { filePath: activeFileRef.current!, viewState: ed.saveViewState?.() ?? null, cursor: pos ? { line: pos.lineNumber, column: pos.column } : null };` — returns `null` if `activeFileRef.current` is null.
  - `restore(filePath, viewState)`: `const ed = monacoRef.current; if (!ed) return false; const m = ed.getModel?.(); const active = m ? m.uri.path.replace(/^\//, "") : null; if (active !== filePath) return false; try { ed.restoreViewState?.(viewState); ed.focus?.(); return true; } catch { return false; }`
- New listener for `ide-restore-view-state` (`{ filePath, viewState, cursor }`): store in `restorePendingRef.current`. **Do not restore inside the handler** — the model may not be attached yet.
- New effect keyed `[activeFile, openFiles]` (runs after the model-management effect): if `restorePendingRef.current` and `activeFileRef.current === restorePendingRef.current.filePath`:
  - `const applied = editorViewApiRef?.current?.restore(pending.filePath, pending.viewState) ?? false;` — actually call the local `restore` closure directly (avoid the ref round-trip).
  - if `!applied` → cursor fallback: `monacoRef.current?.revealPositionInCenter({ lineNumber: pending.cursor?.line ?? 1, column: pending.cursor?.column ?? 1 }); monacoRef.current?.setPosition(...); monacoRef.current?.focus();`
  - `restorePendingRef.current = null` in both branches.
- The `restore` closure and `save` closure are defined once with `useCallback`-free refs (or plain functions inside the mount effect capturing `monacoRef`/`activeFileRef`).

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/test/Editor.viewstate.test.tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import * as React from "react";
import { monaco, __getLastEditorInstance, __resetMonacoMocks } from "./mocks/monaco";
vi.mock("../src/monacoSetup", () => ({ monaco }));
import Editor, { type EditorViewApi } from "../src/components/Editor/Editor";

afterEach(() => { cleanup(); __resetMonacoMocks(); });

const NOOP = () => {};

function mount(openFiles: any[], activeFile: string) {
  const viewRef = React.createRef<EditorViewApi | null>() as React.MutableRefObject<EditorViewApi | null>;
  const utils = render(
    React.createElement(Editor, {
      project: {}, openFiles, setOpenFiles: NOOP, activeFile, setActiveFile: NOOP,
      liveApiRef: { current: null }, isReadOnly: false, collaborators: [], currentUserId: 1,
      editorViewApiRef: viewRef,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any),
  );
  return { ...utils, viewRef, editor: __getLastEditorInstance()! };
}

it("save() returns the active file + an opaque view-state token", () => {
  const { viewRef } = mount([{ path: "a.ts", content: "x", dirty: false }], "a.ts");
  const saved = viewRef.current!.save()!;
  expect(saved.filePath).toBe("a.ts");
  expect((saved.viewState as any).__vs).toBe(true);
});

it("restore() refuses when the active model is a different file", () => {
  const { viewRef, editor } = mount(
    [{ path: "a.ts", content: "x", dirty: false }, { path: "b.ts", content: "y", dirty: false }],
    "a.ts",
  );
  const saved = viewRef.current!.save()!;
  // active model is a.ts; ask to restore b.ts
  expect(viewRef.current!.restore("b.ts", saved.viewState)).toBe(false);
  expect(editor.restoreCalls.length).toBe(0);
});

it("ide-restore-view-state defers until the correct model is active, then restores once", () => {
  const files = [{ path: "a.ts", content: "x", dirty: false }, { path: "b.ts", content: "y", dirty: false }];
  const { viewRef, editor, rerender } = mount(files, "a.ts");
  const saved = viewRef.current!.save()!;

  // switch active file to b.ts, then dispatch a restore request for a.ts
  rerender(React.createElement(Editor, {
    project: {}, openFiles: files, setOpenFiles: NOOP, activeFile: "b.ts", setActiveFile: NOOP,
    liveApiRef: { current: null }, isReadOnly: false, collaborators: [], currentUserId: 1,
    editorViewApiRef: viewRef,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any));

  act(() => {
    document.dispatchEvent(new CustomEvent("ide-restore-view-state", {
      detail: { filePath: "a.ts", viewState: saved.viewState, cursor: { line: 3, column: 1 } },
    }));
  });
  // b.ts is active → NOT restored yet
  expect(editor.restoreCalls.length).toBe(0);

  // now make a.ts active again
  rerender(React.createElement(Editor, {
    project: {}, openFiles: files, setOpenFiles: NOOP, activeFile: "a.ts", setActiveFile: NOOP,
    liveApiRef: { current: null }, isReadOnly: false, collaborators: [], currentUserId: 1,
    editorViewApiRef: viewRef,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any));

  expect(editor.restoreCalls.length).toBe(1);
  expect(editor.restoreCalls[0].modelPath).toBe("a.ts");
  expect(editor.restoreCalls[0].vs).toBe(saved.viewState);
});

it("falls back to a cursor reveal when restore is impossible (no saved view state)", () => {
  const files = [{ path: "a.ts", content: "x", dirty: false }];
  const { editor } = mount(files, "a.ts");
  const spy = vi.spyOn(editor, "revealPositionInCenter");
  act(() => {
    document.dispatchEvent(new CustomEvent("ide-restore-view-state", {
      detail: { filePath: "a.ts", viewState: null, cursor: { line: 7, column: 2 } },
    }));
  });
  // a.ts already active → the guard effect runs; restoreViewState(null) is applied
  // by the mock (records a call), but a real editor would no-op; either way the
  // fallback path is exercised only when restore() returns false. To force the
  // fallback deterministically, assert the reveal happened OR restore recorded:
  expect(editor.restoreCalls.length + spy.mock.calls.length).toBeGreaterThan(0);
});

it("does not mutate the model", () => {
  const { editor, viewRef } = mount([{ path: "a.ts", content: "hello", dirty: false }], "a.ts");
  const saved = viewRef.current!.save()!;
  viewRef.current!.restore("a.ts", saved.viewState);
  expect(editor.getValue()).toBe("hello");
});
```

> Note: if the deterministic "cursor fallback" case is awkward under the mock (because the mock's `restoreViewState` always "succeeds"), make `restore()` return `false` when `viewState == null` and add an explicit assertion that `revealPositionInCenter` was called. Adjust the test to that contract — the key guarantees are (a) never restore while the wrong file is active, (b) restore exactly once when the right model is attached, (c) a null/failed view state degrades to a cursor reveal, (d) no model mutation.

- [ ] **Step 2: Run — verify fail** → `cd frontend && npx vitest run test/Editor.viewstate.test.tsx` → FAIL.

- [ ] **Step 3: Implement** the `editorViewApiRef` population + `restorePendingRef` + the guard effect + `restore()` returning `false` for `viewState == null` (so the fallback is deterministic).

- [ ] **Step 4: Run — verify pass** → PASS.

- [ ] **Step 5: Regression** → `cd frontend && npx vitest run test/Editor.attention.test.tsx test/Editor.nearby.test.tsx test/Editor.sameFile.test.tsx test/Editor.saveTruthfulness.test.tsx test/collab.follow.test.tsx` → PASS.

- [ ] **Step 6: Typecheck** → `cd frontend && npx tsc --noEmit` → 0 errors.

- [ ] **Step 7: Stage for review**

```bash
git add frontend/src/components/Editor/Editor.tsx frontend/test/Editor.viewstate.test.tsx
```

**Review checkpoint:** `restore()` has a strict active-model path guard; the `ide-restore-view-state` handler never restores synchronously; the guard effect fires only when `activeFile === filePath`; `viewState == null` → cursor fallback; no `model.setValue` on any path. **Rollback point:** revert `Editor.tsx`; delete the test.

---

## PHASE 3 — IDE focus controller

### Task 5: `IDE` — refs, `captureAnchor`, `focusOn`, `handleReturnToMyLocation`

**Files:**
- Modify: `frontend/src/components/IDE/IDE.tsx`

**Interfaces (all in `IDE`):**
- `const followAnchorRef = useRef<FollowAnchor | null>(null);`
- `const followAbsenceTimerRef = useRef<number | null>(null);`
- `const followedUserIdRef = useRef<number | null>(null);` + `useEffect(() => { followedUserIdRef.current = followedUserId; }, [followedUserId]);`
- `const collaboratorsRef = useRef(collaborators);` + effect to keep it fresh (there may already be `openFilesRef`; add this alongside).
- `const lastFollowedRef = useRef<{ userId: number; name: string } | null>(null);`
- `const editorViewApiRef = useRef<EditorViewApi | null>(null);`
- `const fileIndexRef = useRef(fileIndex);` + effect.
- `const [followLeftNotice, setFollowLeftNotice] = useState<{ name: string } | null>(null);`
- `const followLeftTimerRef = useRef<number | null>(null);`
- `const clearFollowAbsenceTimer = useCallback(() => { if (followAbsenceTimerRef.current) { window.clearTimeout(followAbsenceTimerRef.current); followAbsenceTimerRef.current = null; } }, []);`
- `const captureAnchor = useCallback(() => { if (followAnchorRef.current) return; const saved = editorViewApiRef.current?.save(); if (!saved) return; followAnchorRef.current = { filePath: saved.filePath, viewState: saved.viewState, cursor: saved.cursor, capturedAt: Date.now() }; }, []);`
- `const discardAnchor = useCallback(() => { followAnchorRef.current = null; }, []);`
- `const focusOn = useCallback((userId: number, opts: { follow: boolean }) => { const cur = followedUserIdRef.current; if (cur !== null && cur !== userId) { setFollowedUserId(null); setFollowPaused(false); setFollowPauseReason(""); clearFollowAbsenceTimer(); /* anchor PRESERVED */ } if (opts.follow) { if (followAnchorRef.current == null) captureAnchor(); setFollowedUserId(userId); const c = collaboratorsRef.current.find(x => x.userId === userId); if (c) lastFollowedRef.current = { userId, name: c.name }; } }, [captureAnchor, clearFollowAbsenceTimer]);`
- `const handleReturnToMyLocation = useCallback(async () => { const anchor = followAnchorRef.current; clearFollowAbsenceTimer(); setFollowedUserId(null); setFollowPaused(false); setFollowPauseReason(""); setFollowLeftNotice(null); followAnchorRef.current = null; if (!anchor) return; const known = new Set<string>([...fileIndexRef.current.map(f => f.path), ...openFilesRef.current.map(f => f.path)]); if (!anchorFilePresent(anchor, known)) { setReplaceReconcileNotice(\`Your previous file "\${anchorFileBasename(anchor)}" is no longer available.\`); return; } await handleOpenFile(anchor.filePath); document.dispatchEvent(new CustomEvent("ide-restore-view-state", { detail: { filePath: anchor.filePath, viewState: anchor.viewState, cursor: anchor.cursor } })); }, [clearFollowAbsenceTimer]);`
  - (`setReplaceReconcileNotice` is the existing lightweight-toast setter used by `reconcileExternalFileChanges`; reuse it for the missing-file toast.)

- [ ] **Step 1: Write the failing tests** — deferred to Task 8's `collab.focus.follow.test.tsx` (the IDE render harness is heavy; build it once there). For this task, add a **source-contract micro-test** so the wiring can't silently regress:

```tsx
// append to a new frontend/test/collab.focus.follow.test.tsx (skeleton for now)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
const ideSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/components/IDE/IDE.tsx"),
  "utf-8",
);

describe("M59 — IDE focus controller wiring (contract)", () => {
  it("has a single focusOn helper and one absence timer ref", () => {
    expect(ideSrc.match(/const focusOn = useCallback/g)?.length).toBe(1);
    expect(ideSrc).toContain("followAbsenceTimerRef");
    expect(ideSrc).toContain("followAnchorRef");
  });
  it("captureAnchor is null-guarded (captured once)", () => {
    const blk = ideSrc.slice(ideSrc.indexOf("const captureAnchor"), ideSrc.indexOf("const captureAnchor") + 400);
    expect(blk).toMatch(/if \(followAnchorRef\.current\)\s*return/);
  });
  it("focusOn preserves the anchor when switching targets (no capture on cur !== userId path)", () => {
    const blk = ideSrc.slice(ideSrc.indexOf("const focusOn = useCallback"), ideSrc.indexOf("const focusOn = useCallback") + 700);
    // the target-switch branch must NOT call captureAnchor / clear the anchor
    const switchBranch = blk.slice(blk.indexOf("cur !== null"), blk.indexOf("if (opts.follow)"));
    expect(switchBranch).not.toContain("captureAnchor");
    expect(switchBranch).not.toContain("followAnchorRef.current = null");
  });
  it("return-to-location clears follow, checks file presence, and reuses ide-restore-view-state", () => {
    const blk = ideSrc.slice(ideSrc.indexOf("handleReturnToMyLocation"), ideSrc.indexOf("handleReturnToMyLocation") + 900);
    expect(blk).toContain("anchorFilePresent");
    expect(blk).toContain("ide-restore-view-state");
    expect(blk).toContain("setFollowedUserId(null)");
  });
});
```

- [ ] **Step 2: Run — verify fail** → FAIL (helpers absent).

- [ ] **Step 3: Implement** the refs + helpers per Interfaces. Wire `editorViewApiRef` into `<Editor editorViewApiRef={editorViewApiRef} … />`.

- [ ] **Step 4: Run — verify pass** → PASS.

- [ ] **Step 5: Typecheck** → 0 errors.

- [ ] **Step 6: Stage for review**

```bash
git add frontend/src/components/IDE/IDE.tsx frontend/test/collab.focus.follow.test.tsx
```

**Review checkpoint:** exactly one `focusOn`; `captureAnchor` null-guarded; the target-switch branch of `focusOn` never touches the anchor; `handleReturnToMyLocation` clears follow first, checks presence, reuses `ide-restore-view-state`, and on missing file toasts + returns without opening anything. **Rollback point:** revert `IDE.tsx` (Editor still gets `editorViewApiRef` = harmless).

---

### Task 6: `IDE` — grace-window follow-tracking + `handleFollowCollaborator`/`Stop` rework

**Files:**
- Modify: `frontend/src/components/IDE/IDE.tsx`

**Interfaces:**
- Rework the follow-tracking effect (currently `[followedUser, activeFile, openFiles, followedUserId]`, IDE.tsx ~line 881):
  ```ts
  useEffect(() => {
    if (!followedUser) {
      // M59: do NOT clear immediately — start the userId-keyed grace timer once.
      if (followedUserId !== null && followAbsenceTimerRef.current === null) {
        followAbsenceTimerRef.current = window.setTimeout(() => {
          followAbsenceTimerRef.current = null;
          const stillAbsent = !collaboratorsRef.current.some(
            (c) => c.userId === followedUserIdRef.current,
          );
          if (stillAbsent && followedUserIdRef.current !== null) {
            setFollowedUserId(null);
            setFollowPaused(false);
            setFollowPauseReason("");
            const name = lastFollowedRef.current?.name ?? "Your collaborator";
            setFollowLeftNotice({ name });          // anchor PRESERVED here
            if (followLeftTimerRef.current) window.clearTimeout(followLeftTimerRef.current);
            followLeftTimerRef.current = window.setTimeout(() => {
              followLeftTimerRef.current = null;
              setFollowLeftNotice(null);
              followAnchorRef.current = null;        // "Stay here" default
            }, FOLLOW_LEFT_NOTICE_MS);
          }
        }, FOLLOW_ABSENCE_GRACE_MS);
      }
      return;
    }
    // followedUser present → seamless resume: kill any pending absence timer
    if (followAbsenceTimerRef.current !== null) {
      window.clearTimeout(followAbsenceTimerRef.current);
      followAbsenceTimerRef.current = null;
    }
    // ... existing navigate/dirty-pause/reveal-to-cursor body, UNCHANGED ...
  }, [followedUser, activeFile, openFiles, followedUserId]);
  // cleanup: clear followAbsenceTimerRef on unmount / dep-change is handled by
  // the collab-effect teardown + handlers; add an explicit cleanup here too:
  //   return () => { /* nothing — timer intentionally survives a dep re-run so a
  //                     transient collaborators change doesn't reset the grace */ };
  ```
  **Important:** the effect re-runs whenever `collaborators` changes (via `followedUser`). The absence timer must **survive** those re-runs (only `followedUser` truly reappearing clears it), so do NOT clear it in an effect cleanup — clear it only in the explicit places listed below.
- `handleStopFollowing` → also `clearFollowAbsenceTimer()`, `discardAnchor()`, `setFollowLeftNotice(null)`, clear `followLeftTimerRef`.
- `handleFollowCollaborator(c)` → becomes:
  ```ts
  const handleFollowCollaborator = useCallback((c: CollaboratorPresence) => {
    if (followedUserId === c.userId) {
      // Unfollow = Stop (discard anchor, stay put)
      handleStopFollowing();
      return;
    }
    focusOn(c.userId, { follow: true });
    if (c.activeFile) {
      const dirty = openFilesRef.current.some((f) => f.path === activeFile && f.dirty);
      if (!dirty) void handleOpenFile(c.activeFile);
      else if (c.activeFile !== activeFile) {
        setFollowPaused(true);
        setFollowPauseReason("Follow paused — you have unsaved changes");
      }
    }
  }, [followedUserId, activeFile, focusOn, handleStopFollowing]);
  ```
- Collab-effect teardown (`[project?.id, user]`) — add: `clearFollowAbsenceTimer(); if (followLeftTimerRef.current) window.clearTimeout(followLeftTimerRef.current); followLeftTimerRef.current = null; setFollowedUserId(null); setFollowPaused(false); setFollowPauseReason(""); setFollowLeftNotice(null); followAnchorRef.current = null;`
- `connection_change` handler — when `status === "forbidden"`: same clear block as teardown.

- [ ] **Step 1: Write the failing tests** — add to `collab.focus.follow.test.tsx` (real `<IDE>` render harness; see Task 8 for the harness — this task's tests are the "grace" and "stop/return" subset):

```
// Lifecycle 28–34 + Anchor 4–5 + Follow 15–16 (see Task 8's file for the full harness).
// This task delivers: grace timer starts (not immediate clear), same-userId new-clientId
// within grace resumes, absent > 6s ends + "left" notice + anchor kept, Stop discards,
// Return restores, no timer after unmount.
```

(Concrete test bodies live in Task 8's file — this task implements what they exercise. To keep the task independently testable, add the **grace-timer contract** micro-tests here:)

```tsx
// append to collab.focus.follow.test.tsx
describe("M59 — grace-window wiring (contract)", () => {
  it("the tracking effect no longer clears followedUserId synchronously on absence", () => {
    const blk = ideSrc.slice(ideSrc.indexOf("if (!followedUser) {"), ideSrc.indexOf("if (!followedUser) {") + 900);
    // the immediate `setFollowedUserId(null)` must be INSIDE a setTimeout, not the effect body
    const beforeTimeout = blk.slice(0, blk.indexOf("setTimeout"));
    expect(beforeTimeout).not.toContain("setFollowedUserId(null)");
    expect(blk).toContain("FOLLOW_ABSENCE_GRACE_MS");
  });
  it("collab-effect teardown clears the absence timer and anchor", () => {
    const teardown = ideSrc.slice(ideSrc.indexOf("return () => {\n      cancelled = true;"));
    expect(teardown.slice(0, 1200)).toContain("clearFollowAbsenceTimer");
    expect(teardown.slice(0, 1200)).toContain("followAnchorRef.current = null");
  });
});
```

- [ ] **Step 2: Run — verify fail** → FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run — verify pass** → PASS (+ existing `collab.follow.test.tsx` still green).

- [ ] **Step 5: Regression** → `cd frontend && npx vitest run test/collab.follow.test.tsx test/collab.awareness.test.ts test/collab.attention.test.ts test/collab.attention.client.test.ts test/AttentionTray.test.tsx` → PASS.

- [ ] **Step 6: Typecheck** → 0 errors.

- [ ] **Step 7: Stage for review**

```bash
git add frontend/src/components/IDE/IDE.tsx frontend/test/collab.focus.follow.test.tsx
```

**Review checkpoint:** absence does not synchronously clear Follow; the timer survives `collaborators` churn (no effect-cleanup clear) but IS cleared on Stop/Return/switch/teardown/forbidden/unmount; the "left" notice keeps the anchor and only "Stay"/timeout discards it; `handleFollowCollaborator` routes through `focusOn`. **Rollback point:** restore the original immediate-clear effect body + original `handleFollowCollaborator`.

---

## PHASE 4 — Existing-surface wiring

### Task 7: FollowBanner + collaborator popover + AttentionTray + "left" notice

**Files:**
- Modify: `frontend/src/components/Collab/FollowBanner.tsx`
- Modify: `frontend/src/components/Collab/AttentionTray.tsx`
- Modify: `frontend/src/components/Collab/CollaboratorAvatarStack.tsx`
- Modify: `frontend/src/components/Toolbar/Toolbar.tsx`
- Modify: `frontend/src/components/IDE/IDE.tsx` (render `<FollowBanner>` new props + the "left" mini-notice; pass `onFollow` to `<AttentionTray>`; pass `attention` to `<Toolbar>`)
- Modify: `frontend/src/styles/collab.css`
- Modify: `frontend/test/collab.follow.test.tsx` (add FollowBanner return-button cases), extend `frontend/test/AttentionTray.test.tsx`, extend `frontend/test/CollaboratorAvatarStack.attention.test.tsx`

**Interfaces:**
- `FollowBannerProps` gains `hasAnchor?: boolean`, `onReturnToLocation?: () => void`, `followedRange?: { startLine: number; endLine: number } | null`. Render a `[Return to my location]` `glass-btn` next to `[Stop]` **only when `hasAnchor && onReturnToLocation`**. When `followedRange`, add `· Lines {startLine}–{endLine}` (or `· Line {startLine}` when equal) to the location line. Esc → `onStopFollowing` unchanged.
- `AttentionTrayProps` gains `onFollow: (e: AttentionEvent) => void`. Request card actions become `[Go there]` `[Follow]` `[Dismiss]`; `[Follow]` → `onFollow(e)` (IDE maps to navigate + `focusOn(author, {follow:true})` + dismiss(acted)).
- `CollaboratorAvatarStackProps` gains `attention?: AttentionEvent[]`. In the `selectedCollaborator` popover, after "CURRENT ACTIVITY", render (via `buildFocusContext(selectedCollaborator, attention ?? [], currentUserId, followingUserId ?? null)`):
  - a `.focus-state-{state}` chip,
  - `fc.range` → `Lines A–B`,
  - `fc.attention?.message` → `📣 "…"` (rendered as a React text child).
  Follow/Unfollow + Jump buttons unchanged.
- `ToolbarProps` gains `attention?: AttentionEvent[]` → passed to `<CollaboratorAvatarStack attention={attention} />`.
- `IDE`:
  - `<Toolbar … attention={attention} />`
  - `<FollowBanner … hasAnchor={followAnchorRef.current != null} onReturnToLocation={handleReturnToMyLocation} followedRange={followedFocusRange} />` where `followedFocusRange = useMemo(() => followedUser ? buildFocusContext(followedUser, attention, user.id, followedUserId).range : null, [followedUser, attention, followedUserId, user])` mapped to `{startLine,endLine}`.
    - **Note:** `followAnchorRef.current` is a ref — reading it in render won't re-trigger. Mirror it into a `hasAnchor` state set in `captureAnchor`/`discardAnchor`/`handleReturnToMyLocation` (a `const [hasAnchor, setHasAnchor] = useState(false)`), OR simpler: derive `hasAnchor` from `followedUserId != null || followLeftNotice != null` — an anchor exists exactly when following OR just-left. Use the derived form (no extra state): `const hasAnchor = followedUserId != null || followLeftNotice != null;` (matches §7 lifecycle: anchor set on enter, discarded on Stop/Return/reset; it can only be non-null while following or in the left-notice window).
  - `[Go there]`/`[Follow]` handlers from the tray:
    ```ts
    const handleAttentionFollow = useCallback((e: AttentionEvent) => {
      handleAttentionNavigate(e);
      const author = collaborators.find(c => c.userId === e.author.userId);
      if (author) focusOn(e.author.userId, { follow: true });
      collabClientRef.current?.dismissAttentionRequest(e.id, true);
    }, [collaborators, handleAttentionNavigate, focusOn]);
    ```
    and update the existing tray `[Go there]` path to call `focusOn(e.author.userId, { follow: false })` **before** navigating (so following a different person ends first): wrap in a small `handleAttentionGoThere`.
  - The "left" mini-notice element (rendered near `<FollowBanner>`):
    ```tsx
    {followLeftNotice && (
      <div className="follow-left-notice" role="status">
        ⚠ {followLeftNotice.name} left
        <button onClick={handleReturnToMyLocation}>Return to your location</button>
        <button onClick={() => { setFollowLeftNotice(null); followAnchorRef.current = null; if (followLeftTimerRef.current) window.clearTimeout(followLeftTimerRef.current); }}>Stay here</button>
      </div>
    )}
    ```

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/test/collab.follow.test.tsx — add to the FollowBanner describe
it("shows Return to my location only when hasAnchor and calls onReturnToLocation", () => {
  const onReturn = vi.fn();
  const { rerender } = render(
    <FollowBanner followedUser={followedUser} onStopFollowing={vi.fn()} hasAnchor={false} onReturnToLocation={onReturn} />,
  );
  expect(screen.queryByRole("button", { name: /return to my location/i })).toBeNull();
  rerender(<FollowBanner followedUser={followedUser} onStopFollowing={vi.fn()} hasAnchor onReturnToLocation={onReturn} />);
  fireEvent.click(screen.getByRole("button", { name: /return to my location/i }));
  expect(onReturn).toHaveBeenCalled();
});
it("shows the followed range when provided", () => {
  render(<FollowBanner followedUser={followedUser} onStopFollowing={vi.fn()} followedRange={{ startLine: 40, endLine: 52 }} />);
  expect(screen.getByText(/Lines 40–52/)).toBeTruthy();
});

// frontend/test/AttentionTray.test.tsx — add
it("request card has a Follow button that calls onFollow", () => {
  const onFollow = vi.fn();
  const e = reqTo(1, { id: "r1" });
  render(<AttentionTray events={[e]} currentUserId={1} rateLimited={false} onNavigate={vi.fn()} onDismiss={vi.fn()} onFollow={onFollow} />);
  fireEvent.click(screen.getByRole("button", { name: /^follow$/i }));
  expect(onFollow).toHaveBeenCalledWith(e);
});

// frontend/test/CollaboratorAvatarStack.attention.test.tsx — add
it("popover shows the collaborator's latest callout message and a focus-state chip", () => {
  const attention = [{
    id: "c1", kind: "callout", author: { userId: 2, username: "Rahul", color: "#89b4fa" },
    file: "auth/session.ts", range: { startLine: 40, startColumn: 1, endLine: 52, endColumn: 1 },
    message: "the race is here", createdAt: Date.now(), expiresAt: Date.now() + 90_000,
  }];
  render(<CollaboratorAvatarStack {...base} attention={attention as any} />);
  fireEvent.click(screen.getByRole("button", { name: /Collaborator Rahul/i }));
  expect(screen.getByText(/the race is here/)).toBeTruthy();
  expect(document.querySelector(".focus-state-focused")).not.toBeNull();
});
```

- [ ] **Step 2: Run — verify fail** → FAIL.

- [ ] **Step 3: Implement** the four components + IDE render wiring + CSS.

- [ ] **Step 4: Run — verify pass** → `cd frontend && npx vitest run test/collab.follow.test.tsx test/AttentionTray.test.tsx test/CollaboratorAvatarStack.attention.test.tsx test/CollaboratorAvatarStack.test.tsx test/TeamPanel.test.tsx` → PASS (TeamPanel + base avatar-stack unchanged).

- [ ] **Step 5: Typecheck** → 0 errors.

- [ ] **Step 6: Stage for review**

```bash
git add frontend/src/components/Collab/FollowBanner.tsx frontend/src/components/Collab/AttentionTray.tsx frontend/src/components/Collab/CollaboratorAvatarStack.tsx frontend/src/components/Toolbar/Toolbar.tsx frontend/src/components/IDE/IDE.tsx frontend/src/styles/collab.css frontend/test/collab.follow.test.tsx frontend/test/AttentionTray.test.tsx frontend/test/CollaboratorAvatarStack.attention.test.tsx
```

**Review checkpoint:** `[Return to my location]` only when an anchor exists; `hasAnchor` derived (no ref-in-render); popover message is a text child; the per-avatar popover Follow/Jump and TeamPanel are otherwise unchanged; `[Go there]` on the tray runs `focusOn(author,{follow:false})` before navigating. **Rollback point:** revert each component to its M58 state; remove the new IDE render bits.

---

## PHASE 5 — Editor attention-click → focus

### Task 8: callout/point click-to-navigate + callout `[Follow]`

**Files:**
- Modify: `frontend/src/components/Editor/Editor.tsx`
- Modify: `frontend/src/components/IDE/IDE.tsx` (`ide-attention-activate` / `ide-attention-follow` listeners)
- Modify: `frontend/test/Editor.attention.test.tsx`
- Create/extend: `frontend/test/collab.focus.follow.test.tsx` (attention-click cases)

**Interfaces:**
- `Editor.tsx` callout content-widget DOM: the bubble root gets `onclick` → `document.dispatchEvent(new CustomEvent("ide-attention-activate", { detail: { id: e.id } }))` **unless** the click target is a `<button>` (the `×` and the new `[Follow]`); add a `[Follow]` `<button>` (before the `×`) → `ide-attention-follow { id: e.id }` (`stopPropagation`). The `×` keeps `stopPropagation`.
- Point decoration: currently only a `linesDecorations`/`after` label. Add a `glyphMarginClassName` click is not available on decorations — instead register a **mouse-down listener** on the editor (`editor.onMouseDown`) that checks `target.type === GLYPH_MARGIN` or the decoration range and, if it hits an attention-point line, dispatches `ide-attention-activate { id }`. Simpler + test-friendly: render the point label as a tiny **content widget** too (like the callout) with an `onclick` → `ide-attention-activate`. Choose the content-widget approach for parity and testability; keep it visually minimal (a 1-line chip).
- `IDE.tsx`:
  ```ts
  useEffect(() => {
    const onActivate = (ev: Event) => {
      const id = (ev as CustomEvent).detail?.id;
      const e = attentionRef.current.find(x => x.id === id);
      if (e) { focusOn(e.author.userId, { follow: false }); handleAttentionNavigate(e); }
    };
    const onFollow = (ev: Event) => {
      const id = (ev as CustomEvent).detail?.id;
      const e = attentionRef.current.find(x => x.id === id);
      if (!e) return;
      handleAttentionNavigate(e);
      if (collaboratorsRef.current.some(c => c.userId === e.author.userId)) {
        focusOn(e.author.userId, { follow: true });
      }
    };
    document.addEventListener("ide-attention-activate", onActivate);
    document.addEventListener("ide-attention-follow", onFollow);
    return () => { document.removeEventListener("ide-attention-activate", onActivate); document.removeEventListener("ide-attention-follow", onFollow); };
  }, [focusOn, handleAttentionNavigate]);
  ```
  (`attentionRef` mirrors `attention` — add it.)

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/test/Editor.attention.test.tsx — add
it("clicking a callout bubble dispatches ide-attention-activate with its id", () => {
  const spy = vi.fn();
  document.addEventListener("ide-attention-activate", (e) => spy((e as CustomEvent).detail));
  renderEditor([evt({ kind: "callout", id: "c9", file: "src/a.ts", message: "look" })]);
  (document.querySelector(".attention-callout-bubble") as HTMLElement).click();
  expect(spy).toHaveBeenCalledWith({ id: "c9" });
  document.removeEventListener("ide-attention-activate", spy as any);
});
it("clicking the callout Follow button dispatches ide-attention-follow, not activate", () => {
  const act = vi.fn(); const fol = vi.fn();
  document.addEventListener("ide-attention-activate", (e) => act((e as CustomEvent).detail));
  document.addEventListener("ide-attention-follow", (e) => fol((e as CustomEvent).detail));
  renderEditor([evt({ kind: "callout", id: "c10", file: "src/a.ts", message: "x" })]);
  (document.querySelector(".attention-callout-bubble button.attention-callout-follow") as HTMLElement).click();
  expect(fol).toHaveBeenCalledWith({ id: "c10" });
  expect(act).not.toHaveBeenCalled();
});
it("clicking the × dismisses locally and does not navigate", () => {
  const act = vi.fn();
  document.addEventListener("ide-attention-activate", (e) => act((e as CustomEvent).detail));
  const client = fakeCollabClient();
  renderEditor([evt({ kind: "callout", id: "c11", file: "src/a.ts", message: "x" })], client);
  (document.querySelector(".attention-callout-x") as HTMLElement).click();
  expect(act).not.toHaveBeenCalled();
});
it("clicking a point chip dispatches ide-attention-activate", () => {
  const spy = vi.fn();
  document.addEventListener("ide-attention-activate", (e) => spy((e as CustomEvent).detail));
  renderEditor([evt({ kind: "point", id: "p9", file: "src/a.ts" })]);
  (document.querySelector(".attention-point-chip") as HTMLElement).click();
  expect(spy).toHaveBeenCalledWith({ id: "p9" });
});
```

(`renderEditor` in that file needs a `collabClient` param for the `×` test — add an optional 2nd arg wiring `collabClient`.)

- [ ] **Step 2: Run — verify fail** → FAIL.

- [ ] **Step 3: Implement** the widget click wiring + IDE listeners.

- [ ] **Step 4: Run — verify pass** → PASS.

- [ ] **Step 5: Regression** → `cd frontend && npx vitest run test/Editor.attention.test.tsx test/Editor.nearby.test.tsx test/Editor.viewstate.test.tsx test/collab.follow.test.tsx` → PASS.

- [ ] **Step 6: Typecheck** → 0 errors.

- [ ] **Step 7: Stage for review**

```bash
git add frontend/src/components/Editor/Editor.tsx frontend/src/components/IDE/IDE.tsx frontend/test/Editor.attention.test.tsx
```

**Review checkpoint:** bubble/point click → navigate via `handleAttentionNavigate` (which uses `openAndRevealLocation`); buttons `stopPropagation`; `ide-attention-activate` runs `focusOn(author,{follow:false})` first (ends a different follow); `ide-attention-follow` needs the author still connected; no Yjs mutation; M58 decoration rendering otherwise unchanged. **Rollback point:** revert the widget click wiring + IDE listeners.

---

## PHASE 6 — Adversarial lifecycle / security suite

### Task 9: `collab.focus.follow.test.tsx` — the 37 behavioral cases

**Files:**
- Modify (complete): `frontend/test/collab.focus.follow.test.tsx`

**Harness:** render `<IDE project={…} user={…} onSwitchToAdmin={…} />` with a **fake collab client** injected via a module mock of `../../collab/client`'s `CollaborationClient` (mirror the existing IDE test conventions in `MEMORY.md` / `status-md-is-the-backlog`). The fake exposes: `on(event, cb)` returning an unsub; test-side `emit(event, payload)`; `dismissAttentionRequest` spy; `setIntent`/`setDnd` no-ops; `dispose`. Drive `awareness_change` with `CollaboratorPresence[]` and `attention_change` with `AttentionEvent[]`. Use the `test/mocks/monaco.ts` editor mock. `vi.useFakeTimers()` for the grace/notice windows.

**The 37 cases (grouped; each an `it(...)`):**

*Anchor (1–10):*
1. entering Follow (popover `[Follow]`) captures an anchor once — `editorViewApiRef.save` called exactly once, `followAnchorRef` populated (assert via the FollowBanner `[Return to my location]` becoming visible).
2. the anchor's file === the pre-follow active file; its `viewState` is the token `save()` returned.
3. Follow Rahul → switch to Follow Priya → `save()` is **not** called again; `[Return]` still points at Rahul-era file (assert Return opens *that* file).
4. `[Stop following]` → `[Return]` disappears; a later manual nav is unaffected.
5. `[Return to my location]` → `handleOpenFile(anchorFile)` + `ide-restore-view-state` dispatched with the saved token; Follow cleared.
6. `[Return]` when the anchor file is absent from `fileIndex` + `openFiles` → `setReplaceReconcileNotice` toast, no `handleOpenFile`, no throw.
7. `[Return]` never causes a `setValue`/`applyLiveContent` (spy on the live API) — dirty buffer content preserved.
8. `[Return]` sets `followedUserId` null.
9. project switch (`rerender` with a new `project.id`) → `followAnchorRef` null, `[Return]` gone.
10. unmount → no anchor, no pending timer (see 34).

*Follow (11–16):*
11. follow an online collaborator with an `activeFile` → that file opens.
12. followed user's `activeFile` changes → `openAndRevealLocation` path (spy call-order: `openFile` before `ide-reveal-location`).
13. followed user's `activeFile` is a **closed** file → `openFile` strictly before `ide-reveal-location`.
14. local active file dirty + follow target navigates → `followPaused` true, file **not** switched.
15. `[Stop following]` clears all three follow states + the anchor.
16. Esc (FollowBanner) → same as Stop.

*Attention (17–24):*
17. tray `[Go there]` while **not** following → navigates, `followedUserId` stays null, no anchor.
18. tray `[Go there]` on Priya's request while following Rahul → `followedUserId` becomes null (Rahul follow ends), navigates to Priya, `[Return]` still shows (anchor preserved), and Return opens the **original** file.
19. tray `[Follow]` on Priya's request while following Rahul → Rahul ends, Priya followed, anchor preserved (== original file).
20. after 18/19, `[Return to my location]` opens the pre-Rahul file (not Priya's).
21. callout click (`ide-attention-activate`) → `handleAttentionNavigate` (open-then-reveal).
22. point click → same.
23. attention nav into a **closed** file → open before reveal.
24. an `attention_change` that drops the followed user's callout (TTL) → `followedUserId` unchanged, FollowBanner still shown.

*Multi-collaborator (25–27):*
25. `attention_change` adding Priya's request while following Rahul → `followedUserId` still Rahul; the tray shows Priya's card; no auto anything.
26. clicking Priya's `[Go there]` deterministically: Rahul ends, navigate to Priya, no Priya follow. Clicking `[Follow]` instead: Rahul ends, Priya followed.
27. at no point are two follow targets set (`followedUserId` is always a single value or null).

*Lifecycle (28–34):*
28. following Rahul; `awareness_change` emits a list **without** Rahul → advance `< 6000 ms` → `followedUserId` still Rahul (grace, not cleared).
29. within the window, `awareness_change` re-emits a list with Rahul at a **new `clientId`, same `userId`** → grace timer cleared, Follow continues (advance past 6000 ms → still following).
30. Rahul stays absent → advance `> 6000 ms` → `followedUserId` null, `.follow-left-notice` rendered with "Rahul left", `[Return to your location]` present (anchor preserved).
31. after 30, a later `awareness_change` re-adds Rahul → `followedUserId` stays null (no auto-refollow).
32. project switch while following → Follow + anchor + timers cleared; `.follow-left-notice` gone.
33. `connection_change` emits `"forbidden"` → Follow + anchor cleared.
34. following Rahul with the grace timer pending → **unmount `<IDE>`** → advance timers → the grace callback does **not** run `setFollowedUserId` (spy / no React "update on unmounted" warning); no `.follow-left-notice`.

*Security (35–37):*
35. set `followedUserId` via `[Follow]` for a user, then `awareness_change` with a list that never contains that `userId` → after grace, Follow ends (a `userId` not in `collaborators` can never be an active follow target long-term); and a crafted `awareness_change` entry cannot make `followedUser` resolve to a different person (identity is `userId`-keyed).
36. every navigation in the suite went through `handleOpenFile` (the authorized `/api/projects/:id/file` route) — assert the fake `api` (or `handleOpenFile` spy) was the path for closed-file opens; no direct fetch of another project's path.
37. project switch clears `collaborators`, `attention`, `followedUserId`, anchor, and `.follow-left-notice` together (no leak of any into the new project).

- [ ] **Step 1: Build the harness + write all 37 (they will fail where behavior is missing).**
- [ ] **Step 2: Run — verify the expected failures** → `cd frontend && npx vitest run test/collab.focus.follow.test.tsx`.
- [ ] **Step 3: Fix any real gaps** the suite exposes in Phases 3–5 code (document each).
- [ ] **Step 4: Run — all 37 + the earlier contract micro-tests pass.**
- [ ] **Step 5: Full frontend regression** → `cd frontend && npx vitest run` → **414 baseline + N new, 0 failed.**
- [ ] **Step 6: Typecheck / lint / build** → `npx tsc --noEmit` 0; `npx eslint src/` 0 errors; `npm run build` exit 0.
- [ ] **Step 7: Full backend regression** → `cd backend && npx vitest run` → record exact result; classify any `python-deps` failure as the known network flake, distinct from M59 (M59 touches no backend).
- [ ] **Step 8: `git diff --check`** → clean. Inspect `git diff` (should still be only the pre-M57 sandbox/README work) and `git diff --cached` (M57+M58+M59).
- [ ] **Step 9: Stage for review**

```bash
git add frontend/test/collab.focus.follow.test.tsx frontend/src/components/IDE/IDE.tsx frontend/src/components/Editor/Editor.tsx
```

**Review checkpoint:** all 37 assert observable transitions (rendered text / dispatched events / spy call-order), not raw state; fake timers for grace; no sleeps; the unmount-no-fire case is real. **Rollback point:** N/A (tests + any documented fixes).

---

## PHASE 7 — Browser verification

### Task 10: Two-session acceptance

**Files:** none (verification only) — produces evidence for STATUS.

**Preconditions:** Phases 1–6 green. Docker running. Backend + frontend dev servers startable.

- [ ] **Step 1: Determine the harness.** Call `mcp__claude-in-chrome__list_connected_browsers` + `tabs_context_mcp`. Two authenticated sessions need two cookie jars — try two Chrome profiles / an incognito window, or drive one session in the UI + one via a headless authenticated collab client feeding presence/attention.
  - **If a real two-session Chrome UI is achievable:** run the 25-step walkthrough (brief §BROWSER ACCEPTANCE 1–25) and the 17-step focused list (this plan's brief). Capture screenshots/GIF of: FollowBanner appearing, editor following a file switch, the "Rahul left" notice, `[Return to my location]` restoring position. This is **browser visual verification**.
  - **If not:** run the strongest integration path — the full `collab.focus.follow.test.tsx` suite (already done) **plus** a live two-client transport script proving presence + attention still flow end-to-end against the running server (reuse/extend the M58 `m58-live` script pattern). Report **browser visual = NOT_PROVEN**, **browser behavioral = PROVEN** (integration + live transport). **Never** call the headless script "visual."

- [ ] **Step 2: Record results** — a table of every step with PASS / PARTIAL / NOT_PROVEN and the harness used.

**Review checkpoint:** visual claims only if the real React UI was exercised in a browser with two authenticated identities. **Rollback point:** N/A.

---

## Final Task: STATUS.md

### Task 11: Document M59

**Files:** Modify `STATUS.md` — add `## Milestone 59 — Collaborative Focus & Context Handoff` after the M58 section. Do **not** rewrite M1–M58.

**Content (real numbers from the Task 6/9/10 runs):**
- **Objective** — the M57→M58→M59 sentence.
- **Reused (not reimplemented):** M48 Follow (`followedUserId` + tracking effect + FollowBanner + dirty-pause), M57 `CollaboratorPresence` + the single `collaborators` array, M58 `AttentionStore` + `AttentionTray` + `attention` throttled state + `handleAttentionNavigate` + `openAndRevealLocation`, Monaco `saveViewState`/`restoreViewState`, the `liveApiRef` ref-API pattern. **None mutated destructively.**
- **What M59 added:** `focus.ts` (`FocusContext` / `FocusState` derived, no store), `followAnchor.ts`, the `editorViewApiRef` model-safe save/restore, the single `focusOn(userId,{follow})` controller + `followAnchorRef` + the `userId`-keyed ~6 s `followAbsenceTimerRef`, `handleReturnToMyLocation`, `[Return to my location]` on FollowBanner, `[Follow]` on AttentionTray request cards + the callout bubble, callout/point click-to-navigate, the collaborator-popover focus block, the "Rahul left" grace notice.
- **State machine** — the §4.3 diagram + the §7 lifecycle matrix.
- **Decisions** — the 14 from the approval message.
- **Non-goals** — change attribution (M60), history, while-you-were-away, feed, comments/threads/chat/reactions, semantic conflict, multi-target follow, analytics, terminal/output sharing, AI. No new transport/store/DB/Yjs/awareness write.
- **Files added / changed** — from this plan.
- **Verification (date, Docker available):** frontend Vitest exact (`414 baseline + N`); `collab.follow.test.tsx` / `collab.awareness.test.ts` / all M58 / all M57 suites green; `tsc` 0 / `eslint` 0 errors / `build` exit 0; full backend Vitest exact result with the `python-deps` flake classified separately; `git diff --check` clean; the Task 10 acceptance table; **browser visual PROVEN or NOT_PROVEN** per what actually ran.
- **Acceptance matrix** — the brief's 19 rows, each classified with one line of evidence.
- **Known limitations / M60+ roadmap.**

- [ ] **Step 1: Write the section.**
- [ ] **Step 2: Re-run** `cd frontend && npx vitest run` and `cd backend && npx vitest run` once more; paste exact summary lines.
- [ ] **Step 3: Stage** — `git add STATUS.md docs/superpowers/specs/2026-08-31-m59-collaborative-focus-handoff-design.md docs/superpowers/plans/2026-08-31-m59-collaborative-focus-handoff.md`. **Do NOT commit.**

**Review checkpoint:** numbers from a fresh run; visual vs behavioral distinguished; `python-deps` classified, not hand-waved. **Rollback point:** revert the STATUS addition.

---

## Self-review (plan vs spec)

**1. Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §3.1 new pure modules | 1, 2 |
| §4.1 `FocusContext` / `FocusState` | 1 |
| §4.2 `FollowAnchor` | 2, 5 |
| §4.3 transitions | 5 (`focusOn`), 6 (grace), 9 (all) |
| §4.4 absence grace (userId-keyed) | 6, 9 (#28–31, #34) |
| §4.5 `handleReturnToMyLocation` | 5, 9 (#5–8) |
| §4.6 model-safe restore | 3, 4, 9 (#5) |
| §5 attention→focus, `focusOn` rule | 7, 8, 9 (#17–20, #25–27) |
| §6.1 popover | 7 |
| §6.2 FollowBanner + Return + "left" notice | 6, 7 |
| §6.3 tray `[Follow]` | 7 |
| §6.4 callout/point click | 8 |
| §7 lifecycle matrix | 6, 9 |
| §8 security | 9 (#35–37) |
| §9 performance | 5/6 (one timer, one ref), 9 (#34), review |
| §10 testing | 1,2,4,7,8,9 |
| §11 browser | 10 |
| §12 non-goals | 11 (documented); no task implements any |
| §13 M60+ roadmap | 11 |

No gaps.

**2. Placeholder scan:** real code for both pure modules, the mock additions, `focus.ts`, the `focusOn`/`captureAnchor`/`handleReturnToMyLocation` bodies, and real test bodies for Tasks 1–8. Task 9's 37 cases are enumerated with concrete assertions; the IDE render harness points at the repo's established IDE-test convention (`MEMORY.md`) rather than inventing one. No "TBD"/"add error handling"/"similar to".

**3. Type consistency:** `FollowAnchor` identical in `followAnchor.ts` (Task 2) and IDE usage (Task 5). `EditorViewApi.save()` returns `{ filePath, viewState, cursor }` (Task 4) — IDE `captureAnchor` consumes exactly those (Task 5). `focusOn(userId: number, opts: { follow: boolean })` — same signature in Tasks 5, 7, 8. `FocusContext` fields (Task 1) match popover/banner consumption (Task 7). `FOLLOW_ABSENCE_GRACE_MS` / `FOLLOW_LEFT_NOTICE_MS` defined once in `focus.ts` (Task 1), used in Task 6. `ide-restore-view-state` / `ide-attention-activate` / `ide-attention-follow` event names consistent across Tasks 4, 5, 8.

Consistent.

---

## Adversarial plan review (per the brief's checklist)

- **Follow attach to an unauthorized user?** No — `followedUser` resolves only from the live `collaborators` array (server-authoritative M57 identity, room-scoped). A `userId` never in `collaborators` yields `null` and, after grace, Follow ends (Task 9 #35).
- **New `clientId` breaks same-user reconnect?** No — everything keys on `userId`. `followedUser` memo, the grace-timer re-check, and `focusOn` all use `userId`. Task 9 #29 proves resume across a `clientId` change.
- **Old absence timer fires after the user returns?** No — the follow-tracking effect clears `followAbsenceTimerRef` the moment `followedUser` becomes non-null again (Task 6). Task 9 #29.
- **Two timers for one target?** No — `if (followAbsenceTimerRef.current === null)` guard before creating; single ref. Task 9 (contract test).
- **Stale timer clears a freshly-established Follow?** No — the grace callback re-checks `!collaboratorsRef.current.some(c => c.userId === followedUserIdRef.current)` against **current** refs before clearing; if you re-followed someone present, `stillAbsent` is false. And any explicit re-follow (`focusOn`) runs `clearFollowAbsenceTimer()` on the switch path.
- **`restoreViewState` hits the wrong model?** No — `restore()` returns `false` unless the active model's normalized path === `filePath`; the guard effect only fires when `activeFile === filePath`; deferred otherwise; cursor fallback on `false`. Tasks 4, 9 #5.
- **Return restores a deleted file?** No — `anchorFilePresent` against `fileIndex ∪ openFiles`; missing → toast + return, no open. Task 9 #6.
- **Return clobbers a dirty buffer?** No — Return only does `handleOpenFile` (tab switch) + `restoreViewState` (cursor/scroll). No `setValue`. Task 9 #7.
- **A→B switch recaptures the anchor?** No — `captureAnchor` early-returns when `followAnchorRef.current` is set; the `focusOn` switch branch never calls it. Tasks 5, 9 #3, #20; the contract test asserts the switch branch has no `captureAnchor`.
- **`[Go there]` accidentally starts Follow?** No — tray `[Go there]` calls `focusOn(author, { follow: false })`. Task 9 #17, #26.
- **`[Follow Priya]` while following Rahul loses the original anchor?** No — anchor preserved (non-null → kept). Task 9 #19, #20.
- **Another collaborator's request corrupts the current Follow?** No — merely receiving an `attention_change` never calls `focusOn`; only a click does. Task 9 #25.
- **Project switch leaves stale FocusContext / Follow?** No — the collab-effect teardown clears `followedUserId`, anchor, both timers, `followLeftNotice`, and `setCollaborators([])` / `setAttention([])` already existed. `FocusContext` is derived, so it empties with its inputs. Task 9 #32, #37.
- **Stale attention resurrects Follow?** No — Follow tracks presence; attention TTL expiry is a no-op for Follow. Task 9 #24.
- **Navigation bypasses `openAndRevealLocation`?** No — Follow tracking uses `handleOpenFile` + the effect re-reveal (M48, unchanged); Jump / attention `[Go there]` / callout-point click all go through `openAndRevealLocation` or `handleAttentionNavigate` (which does). Return uses `handleOpenFile` + `ide-restore-view-state`. Task 9 #12, #13, #21–23.
- **M59 creates another collaborator store?** No — `focus.ts` is a pure function over the existing `collaborators` / `attention` / `followedUserId`. No new state array.
- **M59 modifies Yjs / awareness?** No — zero `Y.` / `awareness.setLocalStateField` in any new code. Review + `grep` gate.
- **UX understandable without docs?** FollowBanner: "Following Rahul · Lines 40–52 · [Stop following] [Return to my location]". Popover: file + range + `📣 "message"` + `[Jump] [Follow]`. Tray: `[Go there] [Follow] [Dismiss]`. "Rahul left — [Return to your location] [Stay here]". No hidden modes.

No revisions required.

---

## Verification plan (final)

**Backend (regression only — M59 is frontend-only):** `cd backend && npx vitest run test/m57-presence.test.ts test/collab-awareness-security.test.ts test/m58-attention.test.ts test/m4-collab.test.ts` then `npx vitest run` (full) + `npx tsc --noEmit` + `npx eslint src/`. Record the exact full-suite line; if `python-deps` fails, classify it as the known Docker+network flake (touches no collab code), distinct from the M59 gate.

**Frontend:** `cd frontend && npx vitest run test/collab.focus.test.ts test/Editor.viewstate.test.tsx test/collab.focus.follow.test.tsx` (M59) + `npx vitest run test/collab.follow.test.tsx test/collab.awareness.test.ts test/collab.attention*.ts* test/AttentionTray.test.tsx test/CollaboratorAvatarStack*.tsx test/TeamPanel.test.tsx test/Editor.*.test.tsx` (M48/M57/M58) + `npx vitest run` (full) + `npx tsc --noEmit` + `npx eslint src/` + `npm run build`.

**General:** `git diff --check`; inspect `git diff` (expect only the pre-M57 sandbox/README work) **and** `git diff --cached` (M57+M58+M59) — do not review only unstaged.

**Browser:** Task 10 — real two-session Chrome UI where achievable (17-step focused list + the 25-step walkthrough); otherwise strongest integration + live transport, `browser visual = NOT_PROVEN`, never mislabel a headless script.

---

## Final Plan Output (summary)

1. **Architecture** — frontend-only integration; two pure modules (`focus.ts`, `followAnchor.ts`); `editorViewApiRef` model-safe save/restore; a single `focusOn` controller + one `followAnchorRef` + one `userId`-keyed ~6 s absence timer; additive affordances on FollowBanner / popover / AttentionTray / callout+point. No transport / store / backend / Yjs / awareness change.
2. **State transitions** — spec §4.3 diagram + §7 matrix: capture-once-null-guarded anchor; `focusOn` ends a different follow (anchor preserved); Stop discards / Return restores; 6 s grace resume-on-same-`userId`; no auto-refollow after grace; every reset path clears both.
3. **Tasks** — 11 across 7 phases (above), each TDD, each with rollback + review checkpoint.
4. **Dependencies** — §Dependency graph. Phases 1 & 2 parallel; 3←{1,2}; {4,5}←3; 6←{3,4,5}; 7←all; 11←7.
5. **Tests** — pure (`collab.focus.test.ts`), Monaco model-safe restore (`Editor.viewstate.test.tsx`), component (`collab.follow.test.tsx` / `AttentionTray` / `CollaboratorAvatarStack.attention` / `Editor.attention` extensions), and the 37-case IDE behavioral suite (`collab.focus.follow.test.tsx`) with fake timers + a fake collab client + the Monaco mock. Full frontend + full backend regression.
6. **Browser** — Task 10: two authenticated Chrome sessions for the visual walkthrough where achievable; strongest integration + live transport otherwise, with visual explicitly NOT_PROVEN.
7. **Rollback/checkpoints** — every task ends with a rollback point + review checkpoint; Phases 1–2 leave new files unreferenced; Phases 3–5 are additive refs/props/handlers (revert = remove the additions).
8. **Risks** — spec §14: wrong-model restore (guarded + tested), grace-window impostor (`userId` + M55 identity), deleted anchor file (check + toast), timer leak after unmount (cleared everywhere + #34), popover scope creep (2 buttons + one context block), click vs button conflict (`stopPropagation`).
9. **Plan path** — `docs/superpowers/plans/2026-08-31-m59-collaborative-focus-handoff.md`.

**DO NOT COMMIT.** Every task stages with `git add` only.
