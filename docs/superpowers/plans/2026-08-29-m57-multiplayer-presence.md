# M57 — Multiplayer Presence, Live Workspace Awareness & Collaborative Editing Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the genuine gaps between CloudIDE's existing Yjs+Awareness collaboration stack and the M57 "feel someone is sitting beside you" experience — working-folder awareness, human-authored intent, a full Team roster, folder/same-file indicators, activity vocabulary, and a minimal presence-model consolidation — without touching the document-sync layer.

**Architecture:** All new presence signals ride the existing `y-protocols/awareness` transport through the M55 server-authoritative rebuild. A mechanical extraction (`backend/src/collab/presence.ts`, `frontend/src/collab/presence.ts`) gives the field allowlist and the parse/selectors one home each so G1/G2 extend one place. New UI (`TeamPanel`) is a pure render of the single `collaborators: CollaboratorPresence[]` array already in `IDE.tsx`. No new transport, no new `MESSAGE_CUSTOM` type, no persistence, no migration.

**Tech Stack:** TypeScript, Node ESM, `yjs`, `y-protocols`, `y-monaco`, `ws`, React 18, Vite, Monaco, Vitest (backend: `singleThread` pool, real Yjs in collab tests; frontend: jsdom, `FakeWebSocket` + fake timers).

**Spec:** `docs/superpowers/specs/2026-08-29-m57-multiplayer-presence-design.md` — read it alongside this plan.

## Global Constraints

- **No new collaboration transport.** New fields use `awareness.setLocalStateField` + the existing `MESSAGE_AWARENESS` path only. No new `MESSAGE_CUSTOM` types.
- **No persistence.** No DB table, no migration, no file writes for presence. Awareness is ephemeral.
- **Document sync is untouched.** No changes to `Y.Doc` handling, `syncProtocol`, `MonacoBinding`, coalescing windows, watermarks, or `backend/src/config.ts`.
- **M55 security invariants preserved exactly:** identity forced to the authenticated session; a connection may only write clientIDs it owns/claims (cap 8); peer clientIDs dropped; unknown top-level keys structurally dropped; `buildAuthoritativeAwarenessState` never throws.
- **`backend/test/collab-awareness-security.test.ts` (28 tests) must pass UNCHANGED** after Task 1. It is the regression guard for the extraction.
- **Working folder = `dirname(activeFile)` only.** Explorer expand/collapse/selection is never a presence signal.
- **Intent is human-authored, ephemeral, bounded** (≤120 chars, C0/DEL stripped, newlines→spaces), cleared on project switch / disposal reset. Never AI-generated.
- **Activity vocabulary:** wire enum = existing set (`viewing editing running terminal searching reviewing`) **plus `navigating`**. Availability enum = existing (`online idle dnd`) **plus `away`**. Do not rename `viewing`. Do not add a wire `idle` activity.
- **No IDE-wide per-second render.** The relative-time ticker lives inside `TeamPanel` and is cleared on unmount.
- **Commits require explicit user approval** (`CLAUDE.md`). Each task's final step stages the change and stops for review; only run `git commit` if the user has authorized commits for this work.
- **Verification environment:** Docker IS available here (29.7.2 + `cloudeeeide-runner:latest`). Backend baseline: 777 passed / 0 failed / 9 skipped. Frontend baseline: 313 passed. Do not report stale numbers.
- Run backend tests from `backend/` (`npx vitest run <file>`), frontend from `frontend/` (`npx vitest run <file>`).

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `backend/src/collab/presence.ts` | **Create** | The awareness field allowlist: enum `Set`s, coordinate/path/intent sanitizers, `buildAuthoritativeAwarenessState`. Pure, no `ws`/`Y.Doc`. |
| `backend/src/collab/manager.ts` | Modify | Import `buildAuthoritativeAwarenessState` + enums from `presence.ts`; keep `sanitizeIncomingAwarenessUpdate` (frame decode, clientID ownership/claim). ~140 lines move out. |
| `backend/test/m57-presence.test.ts` | **Create** | Behavioral: `workingFolder`, `intent`, `away`, `navigating`, malformed inputs, identity/ownership regression, disconnect/reconnect, room isolation, concurrent-edit convergence guard. |
| `frontend/src/collab/presence.ts` | **Create** | `CollaboratorPresence` type, `ActivityType`/`AvailabilityStatus` unions, `readPresenceState`, `deriveWorkingFolder`, `formatRelativeTime`, `collaboratorsInFile`/`collaboratorsInFolder`/`groupCollaboratorsByFolder`. Pure. |
| `frontend/src/collab/client.ts` | Modify | Import type + `readPresenceState` + `deriveWorkingFolder`; `getOnlineCollaborators` delegates; add `setIntent`, `recordNavigation`; derive `workingFolder` in `notifyFileOpen`; blur timer → `away`; clear new fields on reset. |
| `frontend/src/components/Collab/TeamPanel.tsx` | **Create** | Pure roster view of `CollaboratorPresence[]` + `RunStatusEntry[]`: self row w/ intent input + DND, collaborator rows, "WORKING IN" folder groups, relative-time ticker (panel-local). |
| `frontend/src/components/Collab/CollaboratorAvatarStack.tsx` | Modify | Add count chip; clicking chip/avatar calls `onOpenTeamPanel`; remove the per-avatar quick popover (Follow/Jump/DND move to TeamPanel). |
| `frontend/src/components/Toolbar/Toolbar.tsx` | Modify | Thread `onOpenTeamPanel` prop. |
| `frontend/src/components/IDE/IDE.tsx` | Modify | Own `teamPanelOpen` state; render `<TeamPanel>`; pass existing follow/jump handlers + `onSetIntent` to it. |
| `frontend/src/components/Sidebar/Sidebar.tsx` | Modify | Add `collaboratorsByFolder` to the existing `useMemo`; render the existing dot markup on directory rows. |
| `frontend/src/components/Editor/Editor.tsx` | Modify | Same-file collaborator strip under the tab bar via `collaboratorsInFile`; `recordNavigation()` on tab switch. |
| `frontend/test/collab.presence.test.ts` | **Create** | `presence.ts` unit tests. |
| `frontend/test/TeamPanel.test.tsx` | **Create** | TeamPanel render/interaction. |
| `frontend/test/collab.awareness.test.ts` | Modify | Extend: `workingFolder` derivation, `setIntent`, `recordNavigation`, `away`, reset clears new fields. |
| `frontend/test/Sidebar.collab.test.tsx` | **Create** (or extend an existing Sidebar test if present) | Folder-row indicator. |
| `frontend/test/Editor.sameFile.test.tsx` | **Create** | Same-file strip. |
| `STATUS.md` | Modify | New `## Milestone 57` section (Task 11). |

---

## Task 1: Extract the backend presence allowlist (mechanical, no new fields)

**Files:**
- Create: `backend/src/collab/presence.ts`
- Modify: `backend/src/collab/manager.ts` (remove `buildAuthoritativeAwarenessState`, `sanitizeAwarenessFilePath`, `isAwarenessCoord`, and the `AWARENESS_STATUS_VALUES`/`AWARENESS_ACTIVITY_VALUES`/`AWARENESS_MAX_*` constants; import them instead)
- Test: `backend/test/collab-awareness-security.test.ts` (existing — must pass unchanged)

**Interfaces:**
- Produces:
  - `export const AWARENESS_STATUS_VALUES: Set<string>`
  - `export const AWARENESS_ACTIVITY_VALUES: Set<string>`
  - `export const AWARENESS_MAX_PATH_LEN: number`, `AWARENESS_MAX_DETAIL_LEN: number`, `AWARENESS_MAX_COORD: number`
  - `export function buildAuthoritativeAwarenessState(incoming: Record<string, unknown>, clientState: { userId: number; username: string; role: "owner"|"editor"|"viewer" }): Record<string, unknown>`
  - `export function sanitizeAwarenessFilePath(value: unknown): string | null | undefined`
  - `export function isAwarenessCoord(n: unknown): n is number`
- Consumes: nothing (pure module).

- [ ] **Step 1: Baseline the guard suite**

Run: `cd backend && npx vitest run test/collab-awareness-security.test.ts`
Expected: PASS — 28 tests. Record the exact count.

- [ ] **Step 2: Create `backend/src/collab/presence.ts` by moving code verbatim**

Move these out of `manager.ts` with **zero logic changes** (copy the current bodies exactly):

```ts
// backend/src/collab/presence.ts
//
// M57: single home for the server-authoritative awareness field allowlist.
// The security-critical frame decode + clientID ownership/claim logic stays
// in manager.ts (sanitizeIncomingAwarenessUpdate); this module only decides
// which ephemeral fields survive and how they are bounded.
//
// Keep the two enum Sets below in sync with frontend/src/collab/presence.ts.

export const AWARENESS_STATUS_VALUES = new Set(["online", "idle", "dnd"]);
export const AWARENESS_ACTIVITY_VALUES = new Set([
  "viewing",
  "editing",
  "running",
  "terminal",
  "searching",
  "reviewing",
]);
export const AWARENESS_MAX_PATH_LEN = 512;
export const AWARENESS_MAX_DETAIL_LEN = 200;
export const AWARENESS_MAX_COORD = 5_000_000;

export interface AwarenessClientIdentity {
  userId: number;
  username: string;
  role: "owner" | "editor" | "viewer";
}

export function isAwarenessCoord(n: unknown): n is number {
  return (
    typeof n === "number" &&
    Number.isFinite(n) &&
    n >= 0 &&
    n <= AWARENESS_MAX_COORD
  );
}

export function sanitizeAwarenessFilePath(
  value: unknown,
): string | null | undefined {
  // ... EXACT current body from manager.ts ...
}

export function buildAuthoritativeAwarenessState(
  incoming: Record<string, unknown>,
  clientState: AwarenessClientIdentity,
): Record<string, unknown> {
  // ... EXACT current body from manager.ts, with the field-access changed
  // from `this.sanitizeAwarenessFilePath` / `this.isAwarenessCoord` to the
  // module-level function names ...
}
```

> Note: the current methods reference `this.sanitizeAwarenessFilePath(...)` and `this.isAwarenessCoord(...)`. In the module they become bare calls. `AWARENESS_*` constants were already module-level in `manager.ts` — move them here and re-export path is via this module.

- [ ] **Step 3: Update `manager.ts` to import**

At the top of `manager.ts`:

```ts
import {
  AWARENESS_STATUS_VALUES,
  AWARENESS_ACTIVITY_VALUES,
  AWARENESS_MAX_PATH_LEN,
  AWARENESS_MAX_DETAIL_LEN,
  AWARENESS_MAX_COORD,
  buildAuthoritativeAwarenessState,
  sanitizeAwarenessFilePath,
  isAwarenessCoord,
} from "./presence.js";
```

Delete the now-duplicated constant declarations and the three method/function definitions from `manager.ts`. In `sanitizeIncomingAwarenessUpdate`, the call `this.buildAuthoritativeAwarenessState(parsed as Record<string, unknown>, clientState)` becomes `buildAuthoritativeAwarenessState(parsed as Record<string, unknown>, { userId: clientState.userId, username: clientState.username, role: clientState.role })`. `AWARENESS_MAX_ENTRIES_PER_FRAME` / `AWARENESS_MAX_CLIENT_IDS_PER_CONNECTION` **stay in `manager.ts`** (they belong to the frame-decode layer).

- [ ] **Step 4: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Run the guard suite — must be unchanged**

Run: `cd backend && npx vitest run test/collab-awareness-security.test.ts`
Expected: PASS — same 28 tests, same assertions. If any test fails, the extraction changed behavior — revert and redo verbatim.

- [ ] **Step 6: Run the wider collab suites**

Run: `cd backend && npx vitest run test/m4-collab.test.ts test/m6-collab-coalesce-backpressure.test.ts test/m41-dispose-guards.test.ts test/m56-collaboration-safe-mutations.test.ts`
Expected: PASS — all.

- [ ] **Step 7: Stage for review (commit only if authorized)**

```bash
git add backend/src/collab/presence.ts backend/src/collab/manager.ts
# git commit -m "refactor(collab): extract awareness field allowlist to presence.ts (M57 Task 1)"
```

---

## Task 2: Backend — `workingFolder` + `away` + `navigating`

**Files:**
- Modify: `backend/src/collab/presence.ts`
- Create: `backend/test/m57-presence.test.ts`

**Interfaces:**
- Consumes: `buildAuthoritativeAwarenessState` (Task 1).
- Produces: `buildAuthoritativeAwarenessState` output may now contain `out.workingFolder` (string|null) and accept `status === "away"` / `activity.type === "navigating"`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/m57-presence.test.ts`. Use the harness pattern from `collab-awareness-security.test.ts` (real `CollaborationManager`, real room, drive `MESSAGE_AWARENESS` frames through a fake `ws`). Minimum helper: a `connect(room, identity)` that returns a fake ws + a `sendAwareness(state)` that encodes one entry with a chosen clientID and calls `room.handleMessage`.

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import { CollaborationManager } from "../src/collab/manager.js";
import { makeTestConfig } from "./helpers.js"; // if present; else inline resolveConfig
// ... standard room setup mirroring collab-awareness-security.test.ts ...

describe("M57 — working folder, intent, away, navigating", () => {
  // ... beforeEach/afterEach identical shape to the M55 security test ...

  it("keeps a valid workingFolder verbatim", async () => {
    const { room, send, peerStates } = await twoClients();
    send.a({ activeFile: "src/auth/service.ts", workingFolder: "src/auth" });
    await flush();
    expect(peerStates.b().workingFolder).toBe("src/auth");
  });

  it("drops an absolute / traversal workingFolder but keeps the rest of the state", async () => {
    const { send, peerStates } = await twoClients();
    send.a({ activeFile: "a.ts", workingFolder: "../../etc", cursor: { line: 3, column: 1 } });
    await flush();
    expect(peerStates.b().workingFolder).toBeUndefined();
    expect(peerStates.b().cursor).toEqual({ line: 3, column: 1 });
  });

  it("passes the enum gate for status 'away' and activity 'navigating'", async () => {
    const { send, peerStates } = await twoClients();
    send.a({ status: "away", activity: { type: "navigating", timestamp: 1 } });
    await flush();
    expect(peerStates.b().status).toBe("away");
    expect(peerStates.b().activity.type).toBe("navigating");
  });

  it("still drops an unknown status/activity value", async () => {
    const { send, peerStates } = await twoClients();
    send.a({ status: "zzz", activity: { type: "hacking", timestamp: 1 } });
    await flush();
    expect(peerStates.b().status).toBeUndefined();
    expect(peerStates.b().activity).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd backend && npx vitest run test/m57-presence.test.ts`
Expected: FAIL — `workingFolder` undefined, `status "away"` dropped.

- [ ] **Step 3: Implement in `presence.ts`**

```ts
// in the enum Sets:
export const AWARENESS_STATUS_VALUES = new Set(["online", "idle", "away", "dnd"]);
export const AWARENESS_ACTIVITY_VALUES = new Set([
  "viewing", "editing", "navigating", "running", "terminal", "searching", "reviewing",
]);
```

In `buildAuthoritativeAwarenessState`, after the existing `activeFile` branch:

```ts
const workingFolder = sanitizeAwarenessFilePath(incoming.workingFolder);
if (workingFolder !== undefined) out.workingFolder = workingFolder;
```

- [ ] **Step 4: Run — verify pass**

Run: `cd backend && npx vitest run test/m57-presence.test.ts`
Expected: PASS.

- [ ] **Step 5: Regression**

Run: `cd backend && npx vitest run test/collab-awareness-security.test.ts`
Expected: PASS — 28 unchanged.

- [ ] **Step 6: Stage for review**

```bash
git add backend/src/collab/presence.ts backend/test/m57-presence.test.ts
```

---

## Task 3: Backend — `intent` sanitization

**Files:**
- Modify: `backend/src/collab/presence.ts`
- Modify: `backend/test/m57-presence.test.ts`

**Interfaces:**
- Produces: `buildAuthoritativeAwarenessState` output may contain `out.intent` (`{ text: string; updatedAt: number }` or `null`).
- Adds `export const AWARENESS_MAX_INTENT_LEN = 120;`
- Adds `export function sanitizeIntentText(v: unknown): string` — trims, replaces `/\s+/g` with `" "`, strips C0/DEL, slices to 120. Returns `""` when nothing survives.

- [ ] **Step 1: Write the failing tests**

Append to `m57-presence.test.ts`:

```ts
it("keeps a valid intent", async () => {
  const { send, peerStates } = await twoClients();
  send.a({ intent: { text: "JWT refresh", updatedAt: 1000 } });
  await flush();
  expect(peerStates.b().intent).toEqual({ text: "JWT refresh", updatedAt: 1000 });
});

it("cleans control chars and collapses whitespace in intent", async () => {
  const { send, peerStates } = await twoClients();
  send.a({ intent: { text: "  JWT\n\trefresh\u0007  ", updatedAt: 5 } });
  await flush();
  expect(peerStates.b().intent.text).toBe("JWT refresh");
});

it("truncates an oversized intent to 120 chars", async () => {
  const { send, peerStates } = await twoClients();
  send.a({ intent: { text: "x".repeat(400), updatedAt: 5 } });
  await flush();
  expect(peerStates.b().intent.text).toHaveLength(120);
});

it("drops intent with a non-finite updatedAt but keeps the rest", async () => {
  const { send, peerStates } = await twoClients();
  send.a({ intent: { text: "hi", updatedAt: Infinity }, activeFile: "a.ts" });
  await flush();
  expect(peerStates.b().intent).toBeUndefined();
  expect(peerStates.b().activeFile).toBe("a.ts");
});

it("stores an explicit intent: null as a clear", async () => {
  const { send, peerStates } = await twoClients();
  send.a({ intent: { text: "hi", updatedAt: 1 } });
  await flush();
  send.a({ intent: null });
  await flush();
  expect(peerStates.b().intent).toBeNull();
});

it("identity is still forced when intent is present", async () => {
  const { send, peerStates } = await twoClients();
  send.a({ user: { id: 9999, name: "attacker", role: "owner" }, intent: { text: "x", updatedAt: 1 } });
  await flush();
  expect(peerStates.b().user.id).toBe(/* session id of client A */);
  expect(peerStates.b().intent.text).toBe("x");
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd backend && npx vitest run test/m57-presence.test.ts`
Expected: FAIL — `intent` undefined.

- [ ] **Step 3: Implement**

```ts
export const AWARENESS_MAX_INTENT_LEN = 120;

export function sanitizeIntentText(v: unknown): string {
  if (typeof v !== "string") return "";
  let s = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (s.length > AWARENESS_MAX_INTENT_LEN) s = s.slice(0, AWARENESS_MAX_INTENT_LEN);
  return s;
}
```

In `buildAuthoritativeAwarenessState`, after `workingFolder`:

```ts
const intent = incoming.intent;
if (intent === null) {
  out.intent = null;
} else if (intent && typeof intent === "object") {
  const rec = intent as Record<string, unknown>;
  const text = sanitizeIntentText(rec.text);
  if (text && typeof rec.updatedAt === "number" && Number.isFinite(rec.updatedAt)) {
    out.intent = { text, updatedAt: rec.updatedAt };
  }
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd backend && npx vitest run test/m57-presence.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the lifecycle + isolation + convergence guard tests**

Append (these exercise Task 1's preserved behavior with the new fields in play):

```ts
it("disconnect removes the connection's state including new fields", async () => { /* connect A+B, A sends intent+workingFolder, A ws closes -> room.removeClient -> B's awareness no longer has A */ });
it("reconnect with the same session yields exactly one entry", async () => { /* A connects, sends state, disconnects, reconnects with same identity + new clientID -> B sees one A (old clientID removed on disconnect) */ });
it("two tabs of one user each carry their own workingFolder", async () => { /* two connections, same identity, different clientIDs, different activeFile -> two attributed entries */ });
it("project B never sees project A's intent", async () => { /* two rooms, A in room1 sets intent, room2 client sees nothing */ });
it("concurrent Y.Doc edits still converge with presence traffic interleaved", async () => { /* real sync-protocol edits from two clients + awareness frames -> both docs equal */ });
it("a 64-entry frame with a huge intent never throws and stores nothing", async () => { /* mirror collab-awareness-security 'malformed frames' test */ });
```

Run: `cd backend && npx vitest run test/m57-presence.test.ts`
Expected: PASS — all.

- [ ] **Step 6: Full backend collab regression**

Run: `cd backend && npx vitest run test/m4-collab.test.ts test/collab-awareness-security.test.ts test/m6-collab-coalesce-backpressure.test.ts test/m41-dispose-guards.test.ts test/m56-collaboration-safe-mutations.test.ts`
Expected: PASS — all.

- [ ] **Step 7: Stage for review**

```bash
git add backend/src/collab/presence.ts backend/test/m57-presence.test.ts
```

---

## Task 4: Frontend presence module

**Files:**
- Create: `frontend/src/collab/presence.ts`
- Modify: `frontend/src/collab/client.ts` (move `CollaboratorPresence`/`ActivityType`/`AvailabilityStatus`/`SelectionRange`/`ActivityState` type exports to `presence.ts` and re-export; `getOnlineCollaborators` delegates to `readPresenceState`)
- Create: `frontend/test/collab.presence.test.ts`

**Interfaces:**
- Produces:
  - `export type ActivityType = "editing" | "viewing" | "navigating" | "running" | "terminal" | "searching" | "reviewing";`
  - `export type AvailabilityStatus = "online" | "idle" | "away" | "dnd";`
  - `export interface CollaboratorPresence { clientId; userId; name; role; color; availability: AvailabilityStatus; activity: ActivityState; activeFile?: string|null; workingFolder?: string|null; cursor?; selection?; intent?: { text: string; updatedAt: number } | null; lastActive: number; activeFileDirty?: boolean; }`
  - `export function readPresenceState(clientId: number, raw: unknown): CollaboratorPresence | null`
  - `export function deriveWorkingFolder(activeFile: string | null | undefined): string | null`
  - `export function formatRelativeTime(then: number, now: number): string`
  - `export function collaboratorsInFile(list: CollaboratorPresence[], path: string, excludeUserId?: number): CollaboratorPresence[]`
  - `export function collaboratorsInFolder(list: CollaboratorPresence[], folder: string, excludeUserId?: number): CollaboratorPresence[]`
  - `export function groupCollaboratorsByFolder(list: CollaboratorPresence[], excludeUserId?: number): Map<string, CollaboratorPresence[]>`
  - re-exports `getUserColor` from `client.ts` (or move `getUserColor` here and re-export from `client.ts` — pick the direction that keeps `client.ts` importing `presence.ts`, not the reverse cycle; **move `getUserColor` + `USER_COLORS` into `presence.ts`**).
- Consumes: nothing beyond `yjs` awareness-state shape (plain objects).

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/test/collab.presence.test.ts
import { describe, it, expect } from "vitest";
import {
  readPresenceState, deriveWorkingFolder, formatRelativeTime,
  collaboratorsInFile, collaboratorsInFolder, groupCollaboratorsByFolder,
  getUserColor, type CollaboratorPresence,
} from "../src/collab/presence";

describe("deriveWorkingFolder", () => {
  it("returns the parent dir", () => expect(deriveWorkingFolder("src/auth/service.ts")).toBe("src/auth"));
  it("returns null for a root file", () => expect(deriveWorkingFolder("main.py")).toBeNull());
  it("returns null for null", () => expect(deriveWorkingFolder(null)).toBeNull());
  it("normalizes backslashes", () => expect(deriveWorkingFolder("src\\a\\b.ts")).toBe("src/a"));
});

describe("formatRelativeTime", () => {
  const now = 1_000_000;
  it("Active now under 10s", () => expect(formatRelativeTime(now - 4000, now)).toBe("Active now"));
  it("seconds", () => expect(formatRelativeTime(now - 20_000, now)).toBe("20s ago"));
  it("minutes", () => expect(formatRelativeTime(now - 125_000, now)).toBe("2m ago"));
  it("hours", () => expect(formatRelativeTime(now - 7_200_000, now)).toBe("2h ago"));
});

describe("readPresenceState", () => {
  it("parses a full state and maps status->availability", () => {
    const p = readPresenceState(7, {
      user: { id: 3, name: "Rahul", role: "editor", color: "#89b4fa" },
      status: "away",
      activity: { type: "editing", detail: "src/a.ts", timestamp: 5 },
      activeFile: "src/auth/service.ts",
      workingFolder: "src/auth",
      cursor: { line: 42, column: 3 },
      intent: { text: "JWT refresh", updatedAt: 9 },
      lastActive: 100,
    })!;
    expect(p.userId).toBe(3);
    expect(p.availability).toBe("away");
    expect(p.workingFolder).toBe("src/auth");
    expect(p.intent?.text).toBe("JWT refresh");
  });
  it("returns null when user is missing", () => expect(readPresenceState(1, { status: "online" })).toBeNull());
  it("coerces an unknown availability to online", () => {
    expect(readPresenceState(1, { user: { id: 1, name: "x" }, status: "wat" })!.availability).toBe("online");
  });
  it("drops a malformed intent", () => {
    const p = readPresenceState(1, { user: { id: 1, name: "x" }, intent: { text: "hi" } })!;
    expect(p.intent).toBeUndefined();
  });
});

describe("who's-working-here selectors", () => {
  const list: CollaboratorPresence[] = [
    { clientId: 1, userId: 10, name: "Rahul", role: "editor", color: "#1", availability: "online", activity: { type: "editing", timestamp: 0 }, activeFile: "src/auth/service.ts", workingFolder: "src/auth", lastActive: 0 },
    { clientId: 2, userId: 11, name: "Priya", role: "editor", color: "#2", availability: "online", activity: { type: "viewing", timestamp: 0 }, activeFile: "src/components/Login.tsx", workingFolder: "src/components", lastActive: 0 },
    { clientId: 3, userId: 10, name: "Rahul", role: "editor", color: "#1", availability: "online", activity: { type: "editing", timestamp: 0 }, activeFile: "src/auth/session.ts", workingFolder: "src/auth", lastActive: 0 },
  ];
  it("collaboratorsInFile matches exact path", () => {
    expect(collaboratorsInFile(list, "src/auth/service.ts").map(c => c.userId)).toEqual([10]);
  });
  it("collaboratorsInFile can exclude a user", () => {
    expect(collaboratorsInFile(list, "src/auth/service.ts", 10)).toEqual([]);
  });
  it("collaboratorsInFolder matches by prefix", () => {
    expect(collaboratorsInFolder(list, "src/auth").map(c => c.clientId).sort()).toEqual([1, 3]);
  });
  it("groupCollaboratorsByFolder groups and de-dupes clientIds", () => {
    const g = groupCollaboratorsByFolder(list);
    expect([...g.keys()].sort()).toEqual(["src/auth", "src/components"]);
    expect(g.get("src/auth")!.length).toBe(2);
  });
});

describe("getUserColor", () => {
  it("is deterministic", () => expect(getUserColor(5)).toBe(getUserColor(5)));
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd frontend && npx vitest run test/collab.presence.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `frontend/src/collab/presence.ts`**

Move `USER_COLORS` + `getUserColor` + the `CollaboratorPresence`/`ActivityState`/`SelectionRange`/`ActivityType`/`AvailabilityStatus` declarations from `client.ts`. Add `navigating`/`away`. Write `readPresenceState` = the exact per-state parsing block currently inside `client.ts:getOnlineCollaborators` (lines ~889–962) as a standalone function taking `(clientId, state)`, **plus**:

```ts
// availability (wire key `status`)
const availability: AvailabilityStatus =
  raw.status === "idle" || raw.status === "away" || raw.status === "dnd" ? raw.status : "online";

// workingFolder
workingFolder: typeof raw.workingFolder === "string" ? raw.workingFolder : null,

// intent
intent:
  raw.intent === null
    ? null
    : raw.intent && typeof raw.intent === "object" &&
      typeof (raw.intent as any).text === "string" &&
      typeof (raw.intent as any).updatedAt === "number"
      ? { text: (raw.intent as any).text, updatedAt: (raw.intent as any).updatedAt }
      : undefined,
```

```ts
export function deriveWorkingFolder(activeFile: string | null | undefined): string | null {
  if (!activeFile) return null;
  const norm = activeFile.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  if (i <= 0) return null;
  return norm.slice(0, i);
}

export function formatRelativeTime(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 10) return "Active now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function collaboratorsInFile(list: CollaboratorPresence[], path: string, excludeUserId?: number) {
  return list.filter(c => c.userId !== excludeUserId && c.activeFile === path);
}
export function collaboratorsInFolder(list: CollaboratorPresence[], folder: string, excludeUserId?: number) {
  const pre = folder.endsWith("/") ? folder : folder + "/";
  return list.filter(c =>
    c.userId !== excludeUserId &&
    ((c.activeFile && c.activeFile.startsWith(pre)) || c.workingFolder === folder));
}
export function groupCollaboratorsByFolder(list: CollaboratorPresence[], excludeUserId?: number) {
  const m = new Map<string, CollaboratorPresence[]>();
  for (const c of list) {
    if (c.userId === excludeUserId) continue;
    const f = c.workingFolder ?? deriveWorkingFolder(c.activeFile ?? null);
    if (!f) continue;
    const arr = m.get(f) ?? [];
    if (!arr.some(x => x.userId === c.userId)) arr.push(c);
    m.set(f, arr);
  }
  return m;
}
```

- [ ] **Step 4: Rewire `client.ts`**

- `import { CollaboratorPresence, ActivityType, AvailabilityStatus, SelectionRange, ActivityState, readPresenceState, deriveWorkingFolder, getUserColor } from "./presence";` and `export type { CollaboratorPresence, ActivityType, ... } from "./presence";` (keep the existing import sites in components working).
- `getOnlineCollaborators()` becomes:

```ts
public getOnlineCollaborators(): CollaboratorPresence[] {
  const out: CollaboratorPresence[] = [];
  for (const [clientId, state] of this.awareness.getStates().entries()) {
    const p = readPresenceState(clientId, state);
    if (p) out.push(p);
  }
  return out;
}
```

- Delete `USER_COLORS`/`getUserColor` from `client.ts` (now imported).

- [ ] **Step 5: Run all collab frontend tests**

Run: `cd frontend && npx vitest run test/collab.presence.test.ts test/collab.awareness.test.ts test/collab.follow.test.tsx test/collab-initialization.test.ts test/collab.runStatus.test.ts test/collab.runStatus.render.test.tsx test/collab.disposedClient.test.ts test/collab.explicitDisposalReset.test.ts`
Expected: PASS — all (existing tests import `CollaboratorPresence` / `getUserColor` from `client.ts`, still valid via re-export).

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Stage for review**

```bash
git add frontend/src/collab/presence.ts frontend/src/collab/client.ts frontend/test/collab.presence.test.ts
```

---

## Task 5: Frontend client — `workingFolder` derivation, `away` on blur, `recordNavigation`

**Files:**
- Modify: `frontend/src/collab/client.ts`
- Modify: `frontend/test/collab.awareness.test.ts`

**Interfaces:**
- Produces on `CollaborationClient`: `public recordNavigation(): void`. `notifyFileOpen` now also sets `workingFolder`. Blur timer sets `availability = "away"`.
- Consumes: `deriveWorkingFolder` (Task 4).

- [ ] **Step 1: Write failing tests** (append to `collab.awareness.test.ts`)

```ts
it("notifyFileOpen sets workingFolder to dirname(activeFile)", () => {
  const client = new CollaborationClient("p", { id: 1, username: "a" } as any);
  client.notifyFileOpen("src/auth/service.ts");
  expect((client.awareness.getLocalState() as any).workingFolder).toBe("src/auth");
  client.dispose();
});

it("window blur transitions availability to 'away' after the blur timeout", () => {
  const client = new CollaborationClient("p", { id: 1, username: "a" } as any);
  window.dispatchEvent(new Event("blur"));
  vi.advanceTimersByTime(60_000);
  expect((client.awareness.getLocalState() as any).status).toBe("away");
  client.dispose();
});

it("recordNavigation sets activity 'navigating' then reverts to 'viewing'", () => {
  const client = new CollaborationClient("p", { id: 1, username: "a" } as any);
  client.notifyFileOpen("a.ts");
  client.recordNavigation();
  expect((client.awareness.getLocalState() as any).activity.type).toBe("navigating");
  vi.advanceTimersByTime(2500);
  expect((client.awareness.getLocalState() as any).activity.type).toBe("viewing");
  client.dispose();
});

it("resetLocalCollabState clears workingFolder", () => {
  const client = new CollaborationClient("p", { id: 1, username: "a" } as any);
  client.notifyFileOpen("src/x/y.ts");
  (client as any).resetLocalCollabState();
  expect((client.awareness.getLocalState() as any).workingFolder ?? null).toBeNull();
  client.dispose();
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd frontend && npx vitest run test/collab.awareness.test.ts`
Expected: FAIL on the four new tests.

- [ ] **Step 3: Implement in `client.ts`**

- In `notifyFileOpen(filePath)`, after `this.awareness.setLocalStateField("activeFile", filePath);` add:
  ```ts
  this.awareness.setLocalStateField("workingFolder", deriveWorkingFolder(filePath));
  ```
- In `handleWindowBlur()`, change the `setTimeout` body from `this.setAvailability("idle")` to `this.setAvailability("away")`.
- Add a `navHysteresisTimer` field and:
  ```ts
  public recordNavigation(): void {
    if (this.isDisposed) return;
    this.handleUserInteraction();
    if (this.currentActivity.type !== "editing") {
      this.setActivity("navigating", this.activeFilePath);
      if (this.navHysteresisTimer) clearTimeout(this.navHysteresisTimer);
      this.navHysteresisTimer = setTimeout(() => {
        if (!this.isDisposed && this.currentActivity.type === "navigating") {
          this.setActivity("viewing", this.activeFilePath);
        }
      }, 2500);
    }
  }
  ```
  Clear `navHysteresisTimer` in `dispose()` and `setActivity()` (mirror `editHysteresisTimer`).
- In `resetLocalCollabState()` after `this.initDocAndAwareness()` the fresh awareness has no `workingFolder` — nothing to clear explicitly, but if `activeFilePath` is re-bound the `attachBinding`→`notifyFileOpen` path re-derives it. Add an explicit `this.awareness.setLocalStateField("workingFolder", null)` in `initDocAndAwareness()` alongside the other initial fields for determinism.
- `AvailabilityStatus` type already updated in Task 4.

- [ ] **Step 4: Run — verify pass**

Run: `cd frontend && npx vitest run test/collab.awareness.test.ts`
Expected: PASS — all (existing 7 + 4 new). If an existing test asserts `status === "idle"` after blur, update it to `"away"` (that is the intended semantic change; note it in the commit message).

- [ ] **Step 5: Wire `recordNavigation` into the IDE**

In `Editor.tsx`, in the effect that handles active-file/tab change (near the existing `bindMonacoModel` call, NOT on every keystroke), call `collabClientRef.current?.recordNavigation()` when `activeFile` changes and no edit is in flight. In `Sidebar.tsx` `onOpenFile` handler path in `IDE.tsx`, the same file-open already triggers `notifyFileOpen`; `recordNavigation` on tree click is optional — keep it to the tab/active-file change to avoid noise.

- [ ] **Step 6: Regression**

Run: `cd frontend && npx vitest run test/collab.awareness.test.ts test/collab.follow.test.tsx test/collab-initialization.test.ts`
Expected: PASS.

- [ ] **Step 7: Stage for review**

```bash
git add frontend/src/collab/client.ts frontend/src/components/Editor/Editor.tsx frontend/test/collab.awareness.test.ts
```

---

## Task 6: Frontend client — `setIntent`

**Files:**
- Modify: `frontend/src/collab/client.ts`
- Modify: `frontend/test/collab.awareness.test.ts`

**Interfaces:**
- Produces: `public setIntent(text: string | null): void` on `CollaborationClient`. Local awareness field `intent` = `{ text, updatedAt } | null`.

- [ ] **Step 1: Write failing tests**

```ts
it("setIntent sets a cleaned, bounded intent", () => {
  const client = new CollaborationClient("p", { id: 1, username: "a" } as any);
  client.setIntent("  Implement\nJWT refresh  ");
  const st = client.awareness.getLocalState() as any;
  expect(st.intent.text).toBe("Implement JWT refresh");
  expect(typeof st.intent.updatedAt).toBe("number");
  client.dispose();
});

it("setIntent(null) and setIntent('') clear the field", () => {
  const client = new CollaborationClient("p", { id: 1, username: "a" } as any);
  client.setIntent("x");
  client.setIntent("");
  expect((client.awareness.getLocalState() as any).intent).toBeNull();
  client.dispose();
});

it("setIntent is a no-op when the cleaned text is unchanged", () => {
  const client = new CollaborationClient("p", { id: 1, username: "a" } as any);
  client.setIntent("hello");
  const first = (client.awareness.getLocalState() as any).intent.updatedAt;
  client.setIntent("hello");
  expect((client.awareness.getLocalState() as any).intent.updatedAt).toBe(first);
  client.dispose();
});

it("resetLocalCollabState clears intent tracker so next setIntent re-emits", () => {
  const client = new CollaborationClient("p", { id: 1, username: "a" } as any);
  client.setIntent("hello");
  (client as any).resetLocalCollabState();
  client.setIntent("hello");
  expect((client.awareness.getLocalState() as any).intent.text).toBe("hello");
  client.dispose();
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd frontend && npx vitest run test/collab.awareness.test.ts`
Expected: FAIL — `setIntent` not a function.

- [ ] **Step 3: Implement**

```ts
private localIntentText = "";

public setIntent(text: string | null): void {
  if (this.isDisposed) return;
  const cleaned = (text ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  if (cleaned === this.localIntentText) return;
  this.localIntentText = cleaned;
  this.awareness.setLocalStateField(
    "intent",
    cleaned ? { text: cleaned, updatedAt: Date.now() } : null,
  );
}
```

In `initDocAndAwareness()` add `this.awareness.setLocalStateField("intent", null);` with the other initial fields. In `resetLocalCollabState()` add `this.localIntentText = "";` next to `this.localActiveFileDirty = false;`.

- [ ] **Step 4: Run — verify pass**

Run: `cd frontend && npx vitest run test/collab.awareness.test.ts`
Expected: PASS.

- [ ] **Step 5: Stage for review**

```bash
git add frontend/src/collab/client.ts frontend/test/collab.awareness.test.ts
```

---

## Task 7: TeamPanel component

**Files:**
- Create: `frontend/src/components/Collab/TeamPanel.tsx`
- Create: `frontend/test/TeamPanel.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface TeamPanelProps {
    collaborators: CollaboratorPresence[];   // ALL, including self
    runStatuses: RunStatusEntry[];
    currentUserId: number;
    isDnd: boolean;
    followingUserId: number | null;
    onClose: () => void;
    onSetIntent: (text: string) => void;
    onToggleDnd: (dnd: boolean) => void;
    onFollow: (c: CollaboratorPresence) => void;
    onJump: (c: CollaboratorPresence) => void;
  }
  export default function TeamPanel(props: TeamPanelProps): JSX.Element
  ```
- Consumes: `CollaboratorPresence` + `formatRelativeTime` + `groupCollaboratorsByFolder` from `presence.ts`; `RunStatusEntry` from `types.ts`; `pickRunForUser`/`formatRunText` (extract from `CollaboratorAvatarStack.tsx` into a shared `frontend/src/components/Collab/runActivity.ts` in this task and import from both — mechanical).

- [ ] **Step 1: Write failing tests**

```tsx
// frontend/test/TeamPanel.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import TeamPanel from "../src/components/Collab/TeamPanel";
import type { CollaboratorPresence } from "../src/collab/presence";

const base = (over: Partial<CollaboratorPresence>): CollaboratorPresence => ({
  clientId: Math.random(), userId: 1, name: "X", role: "editor", color: "#89b4fa",
  availability: "online", activity: { type: "viewing", timestamp: 0 }, lastActive: Date.now(), ...over,
});

const noop = () => {};
const handlers = { onClose: noop, onSetIntent: noop, onToggleDnd: noop, onFollow: noop, onJump: noop };

it("lists every collaborator and shows the count", () => {
  render(<TeamPanel collaborators={[base({ userId: 1, name: "Me" }), base({ userId: 2, name: "Rahul" }), base({ userId: 3, name: "Priya" })]}
    runStatuses={[]} currentUserId={1} isDnd={false} followingUserId={null} {...handlers} />);
  expect(screen.getByText(/TEAM/)).toBeTruthy();
  expect(screen.getByText("Rahul")).toBeTruthy();
  expect(screen.getByText("Priya")).toBeTruthy();
});

it("shows the self row with an editable intent input", () => {
  const onSetIntent = vi.fn();
  render(<TeamPanel collaborators={[base({ userId: 1, name: "Me", intent: { text: "old", updatedAt: 0 } })]}
    runStatuses={[]} currentUserId={1} isDnd={false} followingUserId={null} {...handlers} onSetIntent={onSetIntent} />);
  const input = screen.getByPlaceholderText(/what are you working on/i) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "JWT refresh" } });
  fireEvent.blur(input);
  expect(onSetIntent).toHaveBeenCalledWith("JWT refresh");
});

it("shows run status text over the activity for a running collaborator", () => {
  render(<TeamPanel collaborators={[base({ userId: 2, name: "Aman" })]}
    runStatuses={[{ executionId: "e", userId: 2, username: "Aman", state: "running", file: "backend/x.py", language: "python", startedAt: Date.now(), endedAt: null, exitCode: null }]}
    currentUserId={1} isDnd={false} followingUserId={null} {...handlers} />);
  expect(screen.getByText(/Running/i)).toBeTruthy();
});

it("Follow and Jump call handlers with the collaborator", () => {
  const onFollow = vi.fn(); const onJump = vi.fn();
  const rahul = base({ userId: 2, name: "Rahul", activeFile: "src/a.ts" });
  render(<TeamPanel collaborators={[base({ userId: 1 }), rahul]} runStatuses={[]} currentUserId={1}
    isDnd={false} followingUserId={null} {...handlers} onFollow={onFollow} onJump={onJump} />);
  fireEvent.click(screen.getByRole("button", { name: /follow rahul/i }));
  expect(onFollow).toHaveBeenCalledWith(expect.objectContaining({ userId: 2 }));
});

it("groups collaborators under WORKING IN by folder", () => {
  render(<TeamPanel collaborators={[base({ userId: 1 }),
    base({ userId: 2, name: "Rahul", activeFile: "src/auth/service.ts", workingFolder: "src/auth" }),
    base({ userId: 3, name: "Priya", activeFile: "src/ui/Login.tsx", workingFolder: "src/ui" })]}
    runStatuses={[]} currentUserId={1} isDnd={false} followingUserId={null} {...handlers} />);
  expect(screen.getByText("src/auth")).toBeTruthy();
  expect(screen.getByText("src/ui")).toBeTruthy();
});

it("de-dupes the roster by userId (multi-tab)", () => {
  render(<TeamPanel collaborators={[base({ userId: 1 }),
    base({ clientId: 10, userId: 2, name: "Rahul", lastActive: 100 }),
    base({ clientId: 11, userId: 2, name: "Rahul", lastActive: 200 })]}
    runStatuses={[]} currentUserId={1} isDnd={false} followingUserId={null} {...handlers} />);
  expect(screen.getAllByText("Rahul").length).toBe(1);
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd frontend && npx vitest run test/TeamPanel.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Extract `runActivity.ts`**

Move `pickRunForUser`, `formatElapsed`, `formatRunText` verbatim from `CollaboratorAvatarStack.tsx` into `frontend/src/components/Collab/runActivity.ts`; export them; import back into `CollaboratorAvatarStack.tsx`. Run `cd frontend && npx vitest run test/collab.runStatus.render.test.tsx` — expect PASS (no behavior change).

- [ ] **Step 4: Implement `TeamPanel.tsx`**

Structure (real logic; presentational styling follows the existing `liquid-card`/`glass-btn` classes used in `CollaboratorAvatarStack.tsx`):

```tsx
import React, { useMemo, useState, useEffect } from "react";
import type { CollaboratorPresence } from "../../collab/presence";
import { formatRelativeTime, groupCollaboratorsByFolder } from "../../collab/presence";
import type { RunStatusEntry } from "../../types";
import { pickRunForUser, formatRunText } from "./runActivity";

const ACTIVITY_LABEL: Record<string, string> = {
  editing: "✏️ Editing", viewing: "👀 Viewing", reviewing: "👀 Reviewing",
  navigating: "🧭 Navigating", running: "🧪 Running", terminal: "💻 Terminal",
  searching: "🔎 Searching",
};

function rosterByUser(list: CollaboratorPresence[]): CollaboratorPresence[] {
  const byUser = new Map<number, CollaboratorPresence>();
  for (const c of list) {
    const prev = byUser.get(c.userId);
    if (!prev || c.lastActive > prev.lastActive) byUser.set(c.userId, c);
  }
  return [...byUser.values()];
}

export default function TeamPanel(props: TeamPanelProps) {
  const { collaborators, runStatuses, currentUserId } = props;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);                       // ticker is LOCAL to this mounted panel only

  const roster = useMemo(() => rosterByUser(collaborators), [collaborators]);
  const self = roster.find(c => c.userId === currentUserId) ?? null;
  const others = roster.filter(c => c.userId !== currentUserId);
  const folders = useMemo(
    () => groupCollaboratorsByFolder(collaborators, currentUserId),
    [collaborators, currentUserId],
  );

  const [intentDraft, setIntentDraft] = useState(self?.intent?.text ?? "");
  useEffect(() => { setIntentDraft(self?.intent?.text ?? ""); }, [self?.intent?.text]);

  const activityText = (c: CollaboratorPresence): string => {
    const run = pickRunForUser(runStatuses, c.userId);
    if (run) return formatRunText(run, now);
    if (c.availability !== "online") return c.availability === "away" ? "Away" : c.availability === "dnd" ? "Do not disturb" : "Idle";
    return ACTIVITY_LABEL[c.activity?.type ?? "viewing"] ?? "Active";
  };

  return (
    <div className="team-panel liquid-card" role="dialog" aria-label="Team">
      <div className="team-panel-header">TEAM <span>({roster.length})</span>
        <button aria-label="Close team panel" onClick={props.onClose}>×</button>
      </div>

      {self && (
        <div className="team-row team-row-self">
          <span className="team-name">You</span>
          <label>🎯 <input
            placeholder="What are you working on?"
            maxLength={120}
            value={intentDraft}
            onChange={e => setIntentDraft(e.target.value)}
            onBlur={() => props.onSetIntent(intentDraft.trim())}
            onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          /></label>
          <button aria-pressed={props.isDnd} onClick={() => props.onToggleDnd(!props.isDnd)}>
            {props.isDnd ? "DND" : "Online"}
          </button>
        </div>
      )}

      {others.map(c => (
        <div className="team-row" key={c.userId}>
          <span className="team-dot" style={{ background: c.color }} />
          <span className={`team-avail team-avail-${c.availability}`} />
          <span className="team-name">{c.name}</span>
          <span className="team-role">{c.role}</span>
          <div className="team-activity">{activityText(c)}</div>
          {c.activeFile && (
            <div className="team-file">
              {c.activeFile.split("/").pop()}{c.cursor ? ` · L${c.cursor.line}` : ""}
            </div>
          )}
          {c.workingFolder && <div className="team-folder">📁 {c.workingFolder}</div>}
          {c.intent?.text && <div className="team-intent">🎯 {c.intent.text}</div>}
          <div className="team-time">{formatRelativeTime(c.lastActive, now)}</div>
          <div className="team-actions">
            <button aria-label={`Follow ${c.name}`}
              onClick={() => props.onFollow(c)}>
              {props.followingUserId === c.userId ? "Unfollow" : "Follow"}
            </button>
            {c.activeFile && (
              <button aria-label={`Jump to ${c.name}`} onClick={() => props.onJump(c)}>Jump</button>
            )}
          </div>
        </div>
      ))}

      {folders.size > 0 && (
        <div className="team-folders">
          <div className="team-folders-title">WORKING IN</div>
          {[...folders.entries()].map(([folder, people]) => (
            <div className="team-folder-row" key={folder}>
              <span className="team-folder-name">{folder}</span>
              <span className="team-folder-people">{people.map(p => p.name).join(", ")}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

Add minimal CSS to `frontend/src/styles/` (a `collab.css` or the existing sidebar/toolbar css — follow where `CollaboratorAvatarStack` styles live; if inline-only there, keep TeamPanel styling inline/minimal for M57).

- [ ] **Step 5: Run — verify pass**

Run: `cd frontend && npx vitest run test/TeamPanel.test.tsx test/collab.runStatus.render.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck + stage**

Run: `cd frontend && npx tsc --noEmit` → 0 errors.

```bash
git add frontend/src/components/Collab/TeamPanel.tsx frontend/src/components/Collab/runActivity.ts frontend/src/components/Collab/CollaboratorAvatarStack.tsx frontend/test/TeamPanel.test.tsx frontend/src/styles/
```

---

## Task 8: Header wiring — count chip, open TeamPanel, retire per-avatar popover

**Files:**
- Modify: `frontend/src/components/Collab/CollaboratorAvatarStack.tsx`
- Modify: `frontend/src/components/Toolbar/Toolbar.tsx`
- Modify: `frontend/src/components/IDE/IDE.tsx`
- Modify: `frontend/test/` — add `CollaboratorAvatarStack.test.tsx` if none exists, else extend

**Interfaces:**
- `CollaboratorAvatarStackProps` gains `onOpenTeamPanel: () => void`; removes `onFollowCollaborator`/`onJumpToCollaborator`/`onToggleDnd` usage inside the popover (props may remain but unused, or remove and thread through TeamPanel — remove for cleanliness).
- `ToolbarProps` gains `onOpenTeamPanel: () => void`.
- `IDE.tsx` owns `const [teamPanelOpen, setTeamPanelOpen] = useState(false)` and renders `<TeamPanel>` when open, passing `collaborators` (the full array — do **not** filter self), `runStatuses`, `user.id`, `collabClient?.getDnd() ?? false`, `followedUserId`, `onSetIntent={(t) => collabClientRef.current?.setIntent(t)}`, `onToggleDnd={(d) => collabClientRef.current?.setDnd(d)}`, `onFollow`/`onJump` = the existing handlers, `onClose={() => setTeamPanelOpen(false)}`.

- [ ] **Step 1: Write failing test**

```tsx
// frontend/test/CollaboratorAvatarStack.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { it, expect, vi } from "vitest";
import CollaboratorAvatarStack from "../src/components/Collab/CollaboratorAvatarStack";

it("shows a collaborator count and opens the team panel on click", () => {
  const onOpenTeamPanel = vi.fn();
  render(<CollaboratorAvatarStack
    collaborators={[
      { clientId: 1, userId: 1, name: "Me", role: "editor", color: "#1", availability: "online", activity: { type: "viewing", timestamp: 0 }, lastActive: 0 } as any,
      { clientId: 2, userId: 2, name: "Rahul", role: "editor", color: "#2", availability: "online", activity: { type: "editing", timestamp: 0 }, lastActive: 0 } as any,
    ]}
    status="connected" currentUserId={1} onOpenTeamPanel={onOpenTeamPanel} />);
  fireEvent.click(screen.getByRole("button", { name: /2 collaborators/i }));
  expect(onOpenTeamPanel).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd frontend && npx vitest run test/CollaboratorAvatarStack.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- In `CollaboratorAvatarStack.tsx`: add a count button after the avatars:
  ```tsx
  <button className="collab-count" aria-label={`${collaborators.length} collaborators — open team panel`}
    onClick={onOpenTeamPanel}>
    {collaborators.length}
  </button>
  ```
  Change each avatar's `onClick` from `setSelectedCollaborator(...)` to `onOpenTeamPanel()`. Delete the `selectedCollaborator` popover block and its state. Keep `renderStatusDot`, the sync badge, the DND toggle (or move DND to TeamPanel and delete here — recommended: keep the DND toggle here too, harmless duplication removed later; simplest is delete here since TeamPanel has it). Keep the Share button.
  Update the presence field name: `c.status` → `c.availability` (the view type renamed in Task 4). `renderStatusDot(c.availability)`.
- `Toolbar.tsx`: add `onOpenTeamPanel` to props and pass through to `<CollaboratorAvatarStack onOpenTeamPanel={onOpenTeamPanel} />`.
- `IDE.tsx`: add `teamPanelOpen` state, pass `onOpenTeamPanel={() => setTeamPanelOpen(true)}` to `<Toolbar>`, render `{teamPanelOpen && <TeamPanel .../>}` near the Toolbar. Anchor with a positioned wrapper (absolute, top-right, below the toolbar).

- [ ] **Step 4: Run — verify pass + regression**

Run: `cd frontend && npx vitest run test/CollaboratorAvatarStack.test.tsx test/collab.follow.test.tsx`
Expected: PASS. Fix any `collab.follow` breakage from the popover removal (follow is now triggered via TeamPanel; if `collab.follow.test.tsx` drove the avatar popover, point it at TeamPanel or keep the follow handler path intact — the handler in `IDE.tsx` is unchanged).

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npx tsc --noEmit` → 0 errors.

- [ ] **Step 6: Stage for review**

```bash
git add frontend/src/components/Collab/CollaboratorAvatarStack.tsx frontend/src/components/Toolbar/Toolbar.tsx frontend/src/components/IDE/IDE.tsx frontend/test/CollaboratorAvatarStack.test.tsx
```

---

## Task 9: Sidebar folder-level indicators

**Files:**
- Modify: `frontend/src/components/Sidebar/Sidebar.tsx`
- Create: `frontend/test/Sidebar.collab.test.tsx`

**Interfaces:**
- Consumes: `collaboratorsInFolder` / `groupCollaboratorsByFolder` from `presence.ts`; the existing `collaborators` prop.
- No prop changes — `collaboratorsByFolder` is derived internally.

- [ ] **Step 1: Write failing test**

```tsx
// frontend/test/Sidebar.collab.test.tsx — render Sidebar with a small tree and a
// collaborator whose activeFile is "src/auth/service.ts"; assert the "src/auth"
// directory row carries a collaborator dot with title containing "Rahul".
// Follow the existing Sidebar test's render harness (props: projects, tree, activeFile,
// collaborators, currentUserId, callbacks). If no Sidebar test exists, mock the
// minimal props from Sidebar.tsx's SidebarProps.
```

Concretely assert: `screen.getByTitle(/Rahul/)` exists within the row labeled `auth`, and disappears when `collaborators={[]}`.

- [ ] **Step 2: Run — verify fail**

Run: `cd frontend && npx vitest run test/Sidebar.collab.test.tsx`
Expected: FAIL — no dot on the folder row.

- [ ] **Step 3: Implement**

In `Sidebar.tsx`, extend the existing `collaboratorsByPath` memo:

```ts
const { collaboratorsByPath, collaboratorsByFolder } = React.useMemo(() => {
  const byPath = new Map<string, CollaboratorPresence[]>();
  const byFolder = new Map<string, CollaboratorPresence[]>();
  if (!collaborators) return { collaboratorsByPath: byPath, collaboratorsByFolder: byFolder };
  for (const c of collaborators) {
    if (c.userId === currentUserId || !c.activeFile) continue;
    (byPath.get(c.activeFile) ?? byPath.set(c.activeFile, []).get(c.activeFile)!).push(c);
    // walk every ancestor folder of the active file
    const parts = c.activeFile.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      const arr = byFolder.get(folder) ?? [];
      if (!arr.some(x => x.userId === c.userId)) arr.push(c);
      byFolder.set(folder, arr);
    }
  }
  return { collaboratorsByPath: byPath, collaboratorsByFolder: byFolder };
}, [collaborators, currentUserId]);
```

Thread `collaboratorsByFolder` down the same prop chain as `collaboratorsByPath` (the `TreeNode`/row components). In the directory-row render branch (`isDir`), add — reusing the exact dot markup already used for files (lines ~1135–1160):

```tsx
{!isDir ? (/* existing file dots */) : (() => {
  const folderCollaborators = collaboratorsByFolder?.get(n.path) || [];
  return folderCollaborators.length > 0 ? (
    <span className="tree-collab-badge" title={folderCollaborators.map(c => c.name).join(", ")}
      aria-label={`${folderCollaborators.length} collaborator(s) working in this folder`}>
      {folderCollaborators.slice(0, 3).map(c => (
        <span key={c.clientId} className="tree-collab-dot" style={{ background: c.color }} />
      ))}
      {folderCollaborators.length > 3 && <span>+{folderCollaborators.length - 3}</span>}
    </span>
  ) : null;
})()}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd frontend && npx vitest run test/Sidebar.collab.test.tsx`
Expected: PASS.

- [ ] **Step 5: Regression + typecheck**

Run: `cd frontend && npx vitest run test/` (full suite) — expect the pre-existing Sidebar tests still green. `npx tsc --noEmit` → 0.

- [ ] **Step 6: Stage for review**

```bash
git add frontend/src/components/Sidebar/Sidebar.tsx frontend/test/Sidebar.collab.test.tsx
```

---

## Task 10: Editor same-file collaborator strip

**Files:**
- Modify: `frontend/src/components/Editor/Editor.tsx`
- Create: `frontend/test/Editor.sameFile.test.tsx`

**Interfaces:**
- Consumes: `collaboratorsInFile` from `presence.ts`; the existing `collaborators` + `activeFile` + `currentUserId` props.

- [ ] **Step 1: Write failing test**

```tsx
// Render Editor with activeFile "src/a.ts" and collaborators=[{ activeFile:"src/a.ts", name:"Rahul", activity:{type:"editing"} }, { activeFile:"src/b.ts", name:"Priya" }].
// Assert a strip shows "Rahul" + "Editing" and does NOT show "Priya".
// Assert the strip is absent when no collaborator shares the file.
```

- [ ] **Step 2: Run — verify fail**

Run: `cd frontend && npx vitest run test/Editor.sameFile.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `Editor.tsx`, near the existing `nearbyEditingCollaborators` memo, add:

```ts
const sameFileCollaborators = React.useMemo(
  () => (activeFile ? collaboratorsInFile(collaborators, activeFile, currentUserId) : []),
  [activeFile, collaborators, currentUserId],
);
```

Render below the tab bar, above the Monaco container, only when non-empty:

```tsx
{sameFileCollaborators.length > 0 && (
  <div className="editor-samefile-strip" role="status">
    {sameFileCollaborators.map(c => (
      <span key={c.clientId} className="samefile-chip">
        <span className="samefile-dot" style={{ background: c.color }} />
        {c.name} · {c.activity?.type === "editing" ? "✏️ Editing" : "👀 Viewing"}
      </span>
    ))}
  </div>
)}
```

Keep the existing `nearbyEditingCollaborators` proximity badge untouched (different purpose).

- [ ] **Step 4: Run — verify pass**

Run: `cd frontend && npx vitest run test/Editor.sameFile.test.tsx`
Expected: PASS.

- [ ] **Step 5: Regression + typecheck**

Run: `cd frontend && npx vitest run test/` — Editor tests green. `npx tsc --noEmit` → 0.

- [ ] **Step 6: Stage for review**

```bash
git add frontend/src/components/Editor/Editor.tsx frontend/test/Editor.sameFile.test.tsx
```

---

## Task 11: Full verification, browser acceptance, STATUS.md

**Files:**
- Modify: `STATUS.md`

- [ ] **Step 1: Full backend suite (Docker available)**

Run: `cd backend && npx vitest run`
Expected: **779 passed / 0 failed / 9 skipped** (777 baseline + `m57-presence.test.ts` ≈ 18–20 new; adjust the stated number to the actual). Zero regressions. No skipped test reported as a pass.

- [ ] **Step 2: Backend typecheck + lint**

Run: `cd backend && npx tsc --noEmit` → 0 errors.
Run: `cd backend && npm run lint` → 0 errors (pre-existing warnings only).

- [ ] **Step 3: Full frontend suite**

Run: `cd frontend && npx vitest run`
Expected: **~330 passed / 0 failed** (313 baseline + new: `collab.presence` ~15, `TeamPanel` ~6, `CollaboratorAvatarStack` ~1, `Sidebar.collab` ~2, `Editor.sameFile` ~2, awareness +8). Adjust to actual. Zero regressions.

- [ ] **Step 4: Frontend typecheck + lint + build**

Run: `cd frontend && npx tsc --noEmit` → 0 errors.
Run: `cd frontend && npm run lint` → 0 errors (pre-existing `exhaustive-deps` warnings in `IDE.tsx` only; the new code adds none).
Run: `cd frontend && npm run build` → exit 0 (pre-existing Monaco chunk-size warning acceptable).

- [ ] **Step 5: `git diff --check`**

Run: `cd D:/cloudide && git diff --check`
Expected: clean (CRLF notices only).

- [ ] **Step 6: Two-session browser acceptance**

Using `claude-in-chrome` (Docker + live `:3000` backend + `:5173` vite): create a throwaway project, add a second user as editor, open two Chrome tabs authenticated as each. Execute the 19-step script from the spec §12. Record each step PASS / PARTIAL / FAIL with the observed evidence. **Do not report a step as passing unless it was actually executed and observed.** Delete the throwaway project afterward. Screenshots/GIF optional.

- [ ] **Step 7: Write the STATUS.md M57 section**

Add `## Milestone 57 — Multiplayer Presence, Live Workspace Awareness & Collaborative Editing Foundation` after the M56/reconciliation sections: objective; "built on M48/M54/M55/M56, gap-closing only"; the ~9 gaps closed; the `presence.ts` extraction and why; state model (`workingFolder` derived-only, `intent` ephemeral, `away`, `navigating`); explicit non-goals; files added/changed; verification results **with actual numbers**; browser acceptance results with per-step status; note the `viewing`/`reviewing` decision and the retired per-avatar popover.

- [ ] **Step 8: Stage everything for review**

```bash
git add -A
git status
# Present the full diff for review. Commit only with explicit user authorization.
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task(s) |
|---|---|
| §4 G1 workingFolder | 2 (backend), 4 (derive), 5 (client wiring) |
| §4 G2 intent | 3 (backend), 6 (client), 7 (TeamPanel input), 8 (IDE `onSetIntent`) |
| §4 G3 TeamPanel | 7, 8 |
| §4 G4 header count | 8 |
| §4 G5 folder tree indicators | 9 |
| §4 G6 who's-here selectors | 4 |
| §4 G7 same-file indicator | 10 |
| §4 G8 relative time | 4 (`formatRelativeTime`), 7 (ticker) |
| §4 G9 activity vocab (`navigating`, `away`) | 2 (backend enums), 5 (client) |
| §4 G10 consolidation | 1 (backend), 4 (frontend) |
| §5 state model | 1–6 |
| §6 protocol/data model | 1–6 |
| §7 lifecycle/reconnect | 3 (tests), 5–6 (reset clears fields) |
| §8 security/trust | 1 (preserve M55), 2–3 (sanitize new fields), 3 (tests) |
| §9 performance | 7 (panel-local ticker), 9 (single memo) |
| §10 UX surfaces | 7, 8, 9, 10 |
| §11 testing | every task's Step 1 + Task 11 |
| §12 browser acceptance | Task 11 Step 6 |
| §13 non-goals | enforced by scope; no task adds persistence/chat/events |
| §16 self-review decisions | reflected in Global Constraints |

No spec requirement is left without a task.

**2. Placeholder scan** — Task 9's test step describes the assertion in prose rather than full code because the Sidebar test harness shape is not in this plan's context; the executor is told the exact `getByTitle` assertion and to mirror the existing Sidebar test. Task 11 Step 6/7 are inherently narrative (browser + docs). All code steps contain real code. No "TBD"/"handle edge cases"/"similar to Task N".

**3. Type consistency** — `CollaboratorPresence` field is `availability` (view type) everywhere in Tasks 4–10; wire key stays `status` (Tasks 1–3, 5–6). `readPresenceState(clientId, raw)` signature consistent Tasks 4/7. `deriveWorkingFolder(activeFile)` consistent Tasks 4/5. `sanitizeIntentText` (backend) vs the inline clean in `client.setIntent` (frontend) — deliberately duplicated per repo convention (§15), same regex both sides. `onOpenTeamPanel` consistent Tasks 7/8. `pickRunForUser`/`formatRunText` moved once (Task 7 Step 3) and imported by both `TeamPanel` and `CollaboratorAvatarStack`.

Fixed inline: Task 4 originally left `getUserColor` in `client.ts` creating a potential import cycle — resolved by moving `getUserColor`+`USER_COLORS` into `presence.ts` and re-exporting from `client.ts`.

---

## Risks / rollback points

| After task | State | Rollback |
|---|---|---|
| 1 | Pure refactor; if the M55 suite shifts, revert `presence.ts` + `manager.ts` — no other task started. | `git checkout backend/src/collab/` |
| 3 | Backend presence complete + fully tested independently of any UI. Safe stopping point. | revert Tasks 2–3 files |
| 4 | Frontend presence module + parse delegation. Existing UI unchanged in behavior. | revert `presence.ts`, restore `client.ts` `getOnlineCollaborators` |
| 6 | Client emits new fields; **no UI consumes them yet** — invisible to users, fully testable. Natural checkpoint. | revert client changes |
| 8 | Header + TeamPanel live. If the popover removal regresses follow-mode UX, re-add the popover (its handlers still exist). | revert Task 8 files |
| 10 | Feature-complete. | per-task revert |
| 11 | Verification + docs. | n/a |

**Highest-risk task: Task 1** (touches the security-critical sanitizer). Mitigated by: verbatim move, no rename, the 28-test M55 suite as an unchanged gate, and it being the first task (nothing else to unwind).

**Second-risk: Task 8** (removes existing UI). Mitigated by: the removed popover is a strict subset of TeamPanel; follow/jump handlers in `IDE.tsx` are untouched; `collab.follow.test.tsx` is re-run.
