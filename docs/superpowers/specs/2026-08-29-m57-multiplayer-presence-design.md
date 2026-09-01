# M57 — Multiplayer Presence, Live Workspace Awareness & Collaborative Editing Foundation

**Status:** design, self-reviewed. Not yet implemented. Not committed.
**Date:** 2026-08-29
**Milestone type:** gap-closing on the existing Yjs + WebSocket + Awareness stack. No new transport, no new persistence, no new subsystem.

---

## 1. Product intent

Make remote collaborators feel physically present while coding. A collaborator should be able to see, without leaving the IDE:

- who is online, who is idle / away,
- what file each person is focused on,
- what code area (folder) each person is actually working in,
- their cursor / selection,
- a derived activity ("editing", "running", "searching", …),
- an optional one-line human-authored intent ("🎯 JWT refresh"),
- live document changes as they happen, with no reload.

Concretely, the IDE should support the sentence:

> "Rahul is here, editing `auth/service.ts`, currently around `refreshToken()`, and actively working on JWT refresh."

This is **not** an avatar-UI milestone. It is the awareness layer that later milestones (callouts, "come look here", activity feed, comments, conflict intelligence) build on top of — using extension points that **already exist** and are **not** built in M57.

---

## 2. Existing architecture (verified against code, 2026-08-29)

Three layers, already cleanly separated. M57 does not blur them.

### 2.1 Document state — Yjs CRDT

| Concern | Location | Verified behavior |
|---|---|---|
| Server doc | `backend/src/collab/manager.ts` — `CollaborationRoom.doc: Y.Doc` (one per project) | `doc.on("update")` schedules debounced persistence + queues a 25 ms-coalesced broadcast. `doc.on("afterTransaction")` maps each changed top-level `Y.Text` key back to a file path for per-file dirty tracking. |
| Client doc | `frontend/src/collab/client.ts` — `CollaborationClient.doc` + `y-monaco` `MonacoBinding` | `doc.on("update")` → `MESSAGE_SYNC` frame to server. Incoming `MESSAGE_SYNC` → `syncProtocol.readSyncMessage` mutates the local doc → y-monaco applies incremental edits to the Monaco model. |
| Editing flow | | typing → Monaco → y-monaco → `Y.Text` op → `MESSAGE_SYNC` → room `doc` → `Y.mergeUpdates` (lossless) → coalesced broadcast → peer `doc` → peer Monaco. **No page reload. Save is not the sync path.** |
| Persistence | `CollaborationRoom.flushToDisk()` | Debounced 2 s / 10 s-max write of dirty `Y.Text` contents to the workspace. `flushBeforeDestructiveDispose()` (M56) closes the pre-dispose data-loss window. Symlink/realpath boundary re-checked at write. |
| External-mutation conflict gate | `CollaborationRoom.handleExternalFileMutation()` (2f738a4) | A full-buffer replace is **refused** (`{applied:false, conflict:true}`) when the file has unpersisted collaborator edits (`dirtyFiles`); callers surface `409 collab_external_conflict` / `409 stale_patch` / per-file `"conflict"`. |

### 2.2 Awareness state — `y-protocols/awareness`, server-authoritative

| Concern | Location | Verified behavior |
|---|---|---|
| Server awareness | `CollaborationRoom.awareness` | Coalesced (`DEFAULT_AWARENESS_COALESCE_MS = 50`), re-encoded from live state on flush ("latest wins"). Backpressure: awareness is dropped for a client above `highWatermark/2` (ephemeral, safe to skip). |
| **M55 server-authoritative rebuild** | `sanitizeIncomingAwarenessUpdate()` + `buildAuthoritativeAwarenessState()` | Every inbound `MESSAGE_AWARENESS` frame is decoded entry-by-entry and **rebuilt**: identity forced to the authenticated WS session (`user.id/name/role` from `clientState`, only a `#hex` `user.color` carried through); a connection may only write clientIDs it owns or can newly claim (per-connection cap `AWARENESS_MAX_CLIENT_IDS_PER_CONNECTION = 8`); a peer's clientID is dropped; every ephemeral field is enum-/bounds-checked; unknown top-level keys are structurally dropped (the output object is rebuilt from scratch, never spreads `incoming`). Never throws. |
| Fields today | `buildAuthoritativeAwarenessState()` | `user{id,name,role,color}`, `status` ∈ {online,idle,dnd}, `activity{type ∈ (viewing,editing,running,terminal,searching,reviewing), detail(≤200), timestamp}`, `activeFile` (bounded workspace-relative path; C0/DEL rejected; abs/drive/`..` rejected), `cursor{line,column}` (finite, 0…5e6), `selection{startLine,startColumn,endLine,endColumn}` (same bounds), `lastActive` (finite), `activeFileDirty` (bool, M56). |
| Disconnect cleanup | `removeClient()` | Removes **exactly** the awareness clientIDs this connection published (`clientState.awarenessClientIds`), via `awarenessProtocol.removeAwarenessStates`. Repeat calls are no-ops. |
| Client awareness | `CollaborationClient.awareness` | Local state machine (below). Sends coalesced local updates as `MESSAGE_AWARENESS`. `awareness.on("change")` → `emit("awareness_change", getOnlineCollaborators())`. |
| Client presence parse | `getOnlineCollaborators()` | Reads `awareness.getStates()` → `CollaboratorPresence[]` with per-field type guards + `getUserColor` fallback. |

### 2.3 Real-time events — `MESSAGE_CUSTOM` (JSON), receive-only on the client

`file_open` → server `ensureFileLoaded` → `file_ready` (M52 seed-authority handshake); `run_status` (M54 execution awareness, server-derived from the authenticated execution WS); `external_mutation_notice` (M56, metadata only). The client **never authors** `run_status` / `external_mutation_notice` / `file_ready`. **This is the extension point for future callouts — M57 adds nothing here.**

### 2.4 Transport, auth, lifecycle

- Single upgrade: `GET /ws/collab?projectId=` in `backend/src/ws/index.ts`. Cookie-session auth → `requireProjectAccess(db, userId, projectId, "viewer")`. `ws.on("error")` attached (malformed-frame crash hardening). Role captured into `CollaboratorClientState` at connect.
- Live authorization changes: `CollaborationManager.revokeUser()` → `room.disconnectUser()` (`ws.close(4403)`); `updateUserRole()` mutates the live `clientState.role` (viewer edits then blocked in `handleMessage`).
- Reconnect: `CollaborationClient` exponential backoff (`1.5^n`, cap 10 s). Close code `4403/4003` → `forbidden` (no reconnect). Close `1001` while `connected` → **explicit server disposal** → `resetLocalCollabState()` discards the stale Y.Doc/Awareness lineage (M40), clears `readyFiles`, `localActiveFileDirty`, `runStatuses`, rebinds Monaco to a fresh empty `Y.Text`.
- Room disposal: idle grace 10 s after last client leaves → `flushToDisk` → `dispose()` (with re-check for a client that reconnected during the flush); retry with capped backoff if a write failed.

### 2.5 Config

`backend/src/config.ts`: `collabYjsCoalesceMs`, `collabAwarenessCoalesceMs`, `collabHighWatermarkBytes`, `collabLowWatermarkBytes` (M6). No new config in M57.

### 2.6 Existing tests (authority for "already works")

- `backend/test/m4-collab.test.ts` (43) — real Yjs + real `y-protocols/sync`: sync handshake, disk fidelity, `file_ready`, concurrent edits converge, viewer write-block, path-escape key rejection.
- `backend/test/collab-awareness-security.test.ts` (28) — M55/M56: identity forcing, spoofed userId/username/role overwritten, spoofed clientID rejected, valid activity/activeFile/cursor/selection preserved, invalid dropped, oversized dropped, malformed frames never throw, per-connection clientID cap, reconnect keeps identity + disconnect removes only that connection, multi-tab independent attribution, room isolation, no stdout/secret/command/env leak, `activeFileDirty` bounded.
- `backend/test/m6-collab-coalesce-backpressure.test.ts` (8), `backend/test/m41-dispose-guards.test.ts` (8), `backend/test/m56-collaboration-safe-mutations.test.ts`.
- `frontend/test/collab.awareness.test.ts` (7) — activity state machine, idle/blur timers, privacy invariants (no `content`/`selectedText`/`secrets`/`terminalOutput`).
- `frontend/test/collab.follow.test.tsx` (7) — follow mode + dirty-state protection.
- `frontend/test/collab-initialization.test.ts` (10) — seed race, `file_ready`, dirty-at-bind, explicit-disposal reset.
- `frontend/test/collab.runStatus.test.ts` + `collab.runStatus.render.test.tsx`, `frontend/test/collab.disposedClient.test.ts`, `frontend/test/collab.explicitDisposalReset.test.ts`, `frontend/test/collabConflict.test.ts`.

---

## 3. Existing capabilities that satisfy M57 requirements (reuse, do not reimplement)

| Requirement | Already provided by | Status |
|---|---|---|
| Real-time collaborative editing, concurrent-edit convergence | Yjs (§2.1) | ✅ complete |
| Incremental Monaco sync, no reload | y-monaco `MonacoBinding` | ✅ complete |
| Remote cursor / selection rendering | y-monaco decorations + `frontend/src/styles/editor.css` (`.yRemoteSelectionHead::after` fading name tags) | ✅ complete |
| Deterministic collaborator color | `getUserColor(userId)` — 8-color Catppuccin palette | ✅ complete |
| Availability: online / idle / dnd | `CollaborationClient` state machine — 2 min idle timer, 1 min blur timer, interaction listeners, manual DND | ✅ (M57 adds `away`, see §5) |
| Activity: editing / running / terminal / searching (+ latent `reviewing`) | `setActivity` + `recordEdit` (5 s hysteresis) + IDE.tsx wiring | ✅ (M57 adds `navigating`, see §5) |
| Cursor throttle / selection debounce | `updateCursorPosition` (rAF), `updateSelection` (50 ms) | ✅ complete |
| Header avatar stack + per-avatar popover (activity, file, **Follow**, **Jump**) | `frontend/src/components/Collab/CollaboratorAvatarStack.tsx` (in `Toolbar`) | ✅ (M57 adds count + TeamPanel, see §10) |
| File-tree presence dots + "+N" overflow | `frontend/src/components/Sidebar/Sidebar.tsx` — `collaboratorsByPath` | ✅ (M57 adds folder rows, see §10) |
| Tab collaborator dots + proximity warning (within 5 lines) | `frontend/src/components/Editor/Editor.tsx` | ✅ (M57 adds same-file indicator, see §10) |
| Follow mode + Jump-to-file + dirty-state protection + `FollowBanner` | M48 | ✅ complete — **M57 does not touch follow mode** |
| Execution awareness without raw stdout/stderr | M54 `run_status` (`running`/`success`/`failed`/`stopped`) | ✅ complete |
| Authorization isolation, identity forcing, spoofed-clientID rejection | M55 (§2.2) | ✅ complete — M57 routes new fields through the same path |
| Malformed-frame hardening, coalescing, backpressure | M6 + M55 | ✅ complete |
| Reconnect / disconnect cleanup, explicit-disposal reset | M40 / M41 / M55 | ✅ complete |
| Collaborator-file query | `CollaborationRoom.getCollaboratorFileState(paths)` (M56, route-facing) | ✅ backend; M57 adds frontend selectors (§10) |
| External-file-mutation conflict handling | 2f738a4 / 91f6e08 | ✅ complete — M57 does not touch it |

---

## 4. Genuine M57 gaps (final)

| Gap | Verdict | Notes |
|---|---|---|
| **G1 — working-folder awareness** | **SHIP** | No `workingFolder`/`activeFolder` field anywhere. Derived from `activeFile` only (see §6 folder semantics). |
| **G2 — user-declared intent** | **SHIP** | No `intent` field. M48's title said "Activity Intent" but only auto `activity.detail`=filename shipped. Ephemeral, bounded, human-authored. |
| **G3 — full Team roster panel** | **SHIP** | Today: one-at-a-time header popover only. New `TeamPanel` listing all collaborators (self included) with identity/availability/activity/file/folder/intent/relative-time + Follow/Jump. |
| **G4 — collaborator count in header** | **SHIP** | Trivial count chip on the avatar stack; opens `TeamPanel`. |
| **G5 — folder-level tree indicators** | **SHIP** | `Sidebar` renders dots on file rows only. Add the same treatment on directory rows via a folder selector. |
| **G6 — "who's working here?" selectors** | **SHIP** | `collaboratorsInFile(file)` / `collaboratorsInFolder(folder)` / `groupCollaboratorsByFolder()` in the frontend presence module, operating on the **single** `collaborators` array in `IDE.tsx` — no second store. |
| **G7 — same-file collaborator indicator** | **SHIP** | Distinct from the existing within-5-lines proximity badge: a persistent "🟣 Rahul · ✏️ Editing" strip for anyone whose `activeFile` equals the open file. |
| **G8 — relative-time activity display** | **SHIP** | `formatRelativeTime(lastActive, now)` + a 1 Hz ticker **local to `TeamPanel`, only while it is open** (mirrors `CollaboratorAvatarStack`'s existing `anyRunning`-gated interval). No IDE-wide per-second render. |
| **G9 — activity vocabulary alignment** | **SHIP (minimal)** | Add `navigating`. Keep `viewing` as the wire term for "focused, not editing" (existing convention; the spec's conceptual `reviewing` ≡ code's `viewing`). Do **not** add a wire `idle` activity value — it is derived from availability at presentation. Leave the latent `reviewing` wire value untouched. See §5 + §6.4. |
| **G10 — presence-model consolidation** | **SHIP (mechanical, minimal)** | Extract the awareness field allowlist + enums into `backend/src/collab/presence.ts` and the parse/selectors into `frontend/src/collab/presence.ts`. Justified **only** because G1/G2 add fields to that allowlist and the enums currently drift across `manager.ts` / `client.ts` / `CollaboratorAvatarStack.tsx`. Not a broad `manager.ts` refactor — see §5.6 and the self-review (§16). |

Nothing else from the original roadmap ships in M57 (see §13).

---

## 5. Final state model

### 5.1 Availability (independent of activity)

```
availability: "online" | "idle" | "away" | "dnd"
```

| Value | Trigger | Current code |
|---|---|---|
| `online` | any interaction (mousemove/keydown/click/scroll) or window focus | exists |
| `idle` | 2 min with no interaction **while the window is focused** | exists (`idleTimer`) |
| `away` | window blurred ≥ 1 min | **NEW** — currently the `blurTimer` also emits `idle`; M57 changes only that timer's target to `away` |
| `dnd` | manual toggle; suppresses idle/away transitions | exists (`isManualDnd`) |

Back-compat: `away` is added to the backend `AWARENESS_STATUS_VALUES` set and the frontend union. An old client that only sends `idle` still works. A peer that receives an unknown status is coerced to `online` (existing `getOnlineCollaborators` behavior — keep).

### 5.2 Activity (independent of availability)

```
activity.type: "editing" | "viewing" | "navigating" | "running" | "terminal" | "searching"
```

Wire enum after M57: the existing set **plus `navigating`**. The latent `reviewing` value stays in the allowlist (no emitter) for forward-compat.

| Value | Trigger | Current code |
|---|---|---|
| `editing` | Monaco content change; 5 s hysteresis → `viewing` | exists (`recordEdit`) |
| `viewing` | resting state: a file is focused, not being edited (the spec's conceptual **`reviewing`**) | exists |
| `navigating` | file-tree click / tab switch **without an edit**; short revert (~2.5 s) → `viewing` | **NEW** (`recordNavigation()`) |
| `running` | execution started (also see M54 `run_status`, which the UI prefers) | exists |
| `terminal` | terminal interaction | exists |
| `searching` | workspace search opened | exists |

**Conceptual `idle` activity** is not a wire value. When `availability !== "online"`, presentation surfaces show the availability ("Idle" / "Away") instead of the last activity. Documented, not encoded.

Rationale for keeping `viewing` (not renaming to `reviewing`): the user's brief grants "follow existing project conventions where they differ"; `viewing` is load-bearing across `client.ts`, `CollaboratorAvatarStack.tsx`, and 3+ tests; `reviewing` display text ("Reviewing changes") reads wrong for the common resting case. The conceptual separation the brief requires (availability ≠ activity) is fully preserved. **If the reviewer prefers the literal rename, it is a mechanical follow-up (§16).**

### 5.3 Activity detail

`activity.detail` (existing, ≤ 200 chars) continues to carry the active file path for `editing`/`viewing`. M57 does **not** attempt to derive a symbol name ("`refreshToken()`") — that requires a language server the codebase does not have. The "around `refreshToken()`" line in the target UX is satisfied by `cursor.line` + `activeFile`; a symbol name is a future gap, explicitly out of scope (§13).

### 5.4 Working folder (G1)

```
workingFolder: string | null    // e.g. "src/auth"  ("" or "." normalize to null → "project root")
```

- **Derived only** as `dirname(activeFile)`. Set together with `activeFile` in `notifyFileOpen()`; cleared with it on file close / project switch / disposal reset.
- Explorer expand/collapse and any Explorer selection are **local view state, never a presence signal** (the codebase has no folder-selection state today anyway — verified). This is stated so a future contributor does not wire it in.
- Server sanitization: **reuse** `sanitizeAwarenessFilePath` unchanged (it already accepts a bounded relative path with no `..`/abs/drive/control chars). A folder path clears the same bar as a file path.

### 5.5 Intent (G2)

```
intent: { text: string; updatedAt: number } | null
```

- **Human-authored only.** Set via a `TeamPanel` text input → `client.setIntent(text)`. Never auto-generated, never AI-derived.
- Bounds (enforced server-side in the sanitizer, mirrored client-side for UX): `text` trimmed, C0/DEL stripped, newlines → spaces, length ≤ 120 (chars beyond truncated), empty after cleaning → field dropped (`intent = null`). `updatedAt` must be a finite number or the field is dropped.
- Ephemeral: lives only in awareness. Cleared on project switch and on `resetLocalCollabState()` (fresh awareness lineage has no intent; the client tracker resets so the next `setIntent` re-emits).
- Not persisted, not a task list, not editable for other users.

### 5.6 `CollaboratorPresence` (frontend view type, after M57)

```ts
interface CollaboratorPresence {
  clientId: number;
  userId: number;
  name: string;
  role: "owner" | "editor" | "viewer";
  color: string;                                   // getUserColor
  availability: "online" | "idle" | "away" | "dnd"; // renamed from `status` in the view type; wire key stays `status`
  activity: { type: ActivityType; detail?: string | null; timestamp: number };
  activeFile?: string | null;
  workingFolder?: string | null;                   // NEW (derived)
  cursor?: { line: number; column: number } | null;
  selection?: { startLine; startColumn; endLine; endColumn } | null;
  intent?: { text: string; updatedAt: number } | null; // NEW
  lastActive: number;
  activeFileDirty?: boolean;                        // M56, unchanged
}
```

Wire format is unchanged except two added optional keys (`workingFolder`, `intent`) and one added `status` enum value (`away`). The awareness JSON key stays `status`; only the frontend view type field is named `availability` for clarity (mapping done once in the parse function).

---

## 6. Awareness protocol / data model changes

### 6.1 Backend — `backend/src/collab/presence.ts` (NEW, mechanical extraction)

Move **verbatim** from `manager.ts` (no behavior change):

- `AWARENESS_STATUS_VALUES`, `AWARENESS_ACTIVITY_VALUES`, `AWARENESS_MAX_*` constants
- `buildAuthoritativeAwarenessState(incoming, clientState)` → exported `buildAuthoritativeAwarenessState`
- `sanitizeAwarenessFilePath`, `isAwarenessCoord` helpers

Then **add** to `buildAuthoritativeAwarenessState`:

- `AWARENESS_STATUS_VALUES.add("away")`
- `AWARENESS_ACTIVITY_VALUES.add("navigating")`
- `workingFolder` branch: `const wf = sanitizeAwarenessFilePath(incoming.workingFolder); if (wf !== undefined) out.workingFolder = wf;`
- `intent` branch: accept `{text, updatedAt}` only; clean `text` (trim, strip C0/DEL, `\s+`→` `, slice 120); require `Number.isFinite(updatedAt)`; empty text ⇒ omit field; `intent === null` ⇒ `out.intent = null`.

`manager.ts` keeps `sanitizeIncomingAwarenessUpdate` (the frame decode / clientID-ownership / claim logic — the security-critical part) and imports `buildAuthoritativeAwarenessState` from `presence.ts`. `CollaboratorClientState` is unchanged. **Scope of extraction ≈ 140 lines moved + ~20 added.** No renaming of anything a test references.

### 6.2 Frontend — `frontend/src/collab/presence.ts` (NEW)

- `ActivityType`, `AvailabilityStatus` unions (add `navigating`, `away`)
- `CollaboratorPresence` interface (moved from `client.ts`)
- `readPresenceState(clientId, rawAwarenessState): CollaboratorPresence | null` — the per-state parse currently inline in `client.ts:getOnlineCollaborators` (type guards + `getUserColor` fallback), extended for `workingFolder`/`intent`, mapping wire `status` → view `availability`.
- `deriveWorkingFolder(activeFile: string | null): string | null` — `dirname`, normalize `""`/`"."` → `null`.
- `formatRelativeTime(then: number, now: number): string` — `"Active now"` (< 10 s), `"Ns ago"` (< 60 s), `"Nm ago"` (< 60 m), `"Nh ago"`.
- Selectors (pure, operate on `CollaboratorPresence[]`):
  - `collaboratorsInFile(list, path, excludeUserId?)`
  - `collaboratorsInFolder(list, folder, excludeUserId?)` — matches `activeFile` under `folder/` **or** `workingFolder === folder`
  - `groupCollaboratorsByFolder(list, excludeUserId?): Map<string, CollaboratorPresence[]>`
- `getUserColor` re-exported (stays defined where it is).

`client.ts` imports the type + `readPresenceState` + `deriveWorkingFolder`; `getOnlineCollaborators` delegates.

### 6.3 Frontend — `CollaborationClient` additions

- `setActiveFolder` is **not added**. Working folder is derived inside `notifyFileOpen`: `this.awareness.setLocalStateField("workingFolder", deriveWorkingFolder(filePath))`. Cleared (`null`) alongside `activeFile` on reset.
- `setIntent(text: string | null)`: clean client-side, no-op if unchanged (tracker field like `localActiveFileDirty`), `setLocalStateField("intent", cleaned ? {text, updatedAt: Date.now()} : null)`. Reset in `resetLocalCollabState`.
- `recordNavigation()`: `setActivity("navigating", this.activeFilePath)`; a ~2.5 s timer reverts to `viewing` if still `navigating` (mirror `recordEdit`'s hysteresis timer, separate field).
- Blur timer target: `setAvailability("away")` instead of `"idle"`.

### 6.4 What is deliberately unchanged

- The `MESSAGE_*` type numbers and framing.
- `sanitizeIncomingAwarenessUpdate` decode/claim/ownership logic.
- Coalescing windows, watermarks, config.
- The `file_open`/`file_ready`/`run_status`/`external_mutation_notice` custom-message set — **no new custom message in M57**.
- Follow mode, proximity badge, tab dots, external-mutation conflict handling.

---

## 7. Lifecycle / reconnect behavior

No new lifecycle. New fields ride the existing paths:

| Event | Behavior |
|---|---|
| Join | `addClient` sends sync step 1 + full awareness snapshot + run-status snapshot (unchanged). New fields arrive in that snapshot. |
| Local edit / cursor / nav / intent | local `setLocalStateField` → coalesced `MESSAGE_AWARENESS` → M55 rebuild → coalesced broadcast. |
| Idle / away | client timers set `status`; peers re-render from `awareness_change`. |
| Disconnect | `removeClient` removes exactly this connection's clientIDs → peers drop the collaborator on the next `awareness_change`. |
| Reconnect (network blip) | backoff reconnect; on open, re-send sync step 1 + local awareness (incl. `workingFolder`/`intent`) + `file_open`. Same identity ⇒ **same clientID entry updated, not duplicated** (y-protocols keyed by clientID; server attribution unchanged). |
| Explicit server disposal (`1001` while connected) | `resetLocalCollabState()` — new fields cleared with the lineage; re-emitted after reconnect. |
| Project switch | `IDE.tsx` disposes the client, `setCollaborators([])`; new client for the new project. `workingFolder`/`intent` do not cross projects (local to the disposed client). |
| Role revoked | `disconnectUser` `ws.close(4403)` → `forbidden`, no reconnect; peers drop the collaborator. |
| Multiple tabs | each tab = its own clientID entry (verified existing behavior); TeamPanel de-dupes by `userId` for the roster, keeps per-tab entries for file/folder indicators (matches current `Sidebar` behavior). |

---

## 8. Security / trust model

| Boundary | M57 stance |
|---|---|
| **Document trust** | Unchanged — Yjs sync, viewer write-block in `handleMessage`. |
| **Presence trust** | New fields go through the **same M55 rebuild**: `workingFolder` via `sanitizeAwarenessFilePath` (bounded relative path, no `..`/abs/control), `intent.text` cleaned + length-capped + control-char-stripped, `intent.updatedAt` finite-checked. Identity still forced; clientID ownership still enforced; unknown keys still structurally dropped. |
| **Authorization scope** | Presence is only ever delivered within a room, and a room is only joined after `requireProjectAccess(…, "viewer")`. No new endpoint, no cross-room fan-out. Selectors (§6.2) run purely on the in-memory `collaborators` array for the current project. |
| **Stale presence across project switch** | `IDE.tsx` already `setCollaborators([])` + disposes on switch. New fields carried on the disposed client cannot leak. Add a test. |
| **Revoked users** | `disconnectUser` unchanged; test that a revoked user leaves the roster. |
| **Malformed presence** | `buildAuthoritativeAwarenessState` never throws (rebuild-from-scratch); `sanitizeIncomingAwarenessUpdate` catches decode errors. New branches are pure guards. Test malformed `intent` (non-object, huge string, control chars, non-finite `updatedAt`, `workingFolder` with `..`/abs). |
| **Impersonation / forged clientID** | Unchanged M55 enforcement; existing tests still pass. |
| **Never exposed** | secrets, env, terminal contents, stdout/stderr, private execution data. M57 adds no channel that could carry them; `intent` is user free text (treated as untrusted display text — rendered as text, never HTML). |
| **Execution-output sharing** | Remains a separate decision. M57 keeps M54's status-only model. |

---

## 9. Performance model

| Concern | Approach |
|---|---|
| Cursor/selection frequency | Unchanged: rAF cursor, 50 ms selection debounce client-side; 50 ms awareness coalescing + `>highWatermark/2` drop server-side. |
| IDE-wide re-render on presence | Unchanged: `throttleLatest(setCollaborators, 200)` in `IDE.tsx`. New fields add a few bytes per awareness state; no new state subscription. |
| Relative-time ticker (G8) | 1 Hz `setInterval` **mounted only inside `TeamPanel`, only while open** (component unmount clears it). Mirrors the existing `CollaboratorAvatarStack` `anyRunning`-gated interval. **No IDE-wide per-second render.** |
| File tree rebuild on awareness (G5) | `Sidebar` already derives `collaboratorsByPath` via `useMemo([collaborators, currentUserId])`. Add `collaboratorsByFolder` to the **same** memo. The tree itself is not rebuilt — only the per-row indicator props change, and rows are keyed. |
| Selectors (G6) | Pure functions over the existing array; callers wrap in `useMemo`. No new store, no new fetch, no DB. |
| New broadcast protocol | None. |
| DB writes for presence | None — awareness only. |

---

## 10. UX surfaces

### 10.1 Header (`CollaboratorAvatarStack.tsx`, in `Toolbar`)

- Existing: sync badge + overlapping avatars (others) + per-avatar quick popover + DND toggle + Share.
- **Add:** a count chip — `👤👤👤  N` where `N = collaborators.length` (including self, matching the mockup's "3"). Clicking the chip **or any avatar** opens `TeamPanel`.
- **Move** Follow / Jump / DND actions into `TeamPanel`; the per-avatar quick popover is removed (its content is a strict subset of a TeamPanel row). Avatars remain as at-a-glance identity/availability.

### 10.2 TeamPanel (`frontend/src/components/Collab/TeamPanel.tsx`, NEW)

Anchored dropdown from the header chip (not a layout-shifting drawer — smaller change, matches the existing popover pattern). Contents:

```
TEAM  (N)

▸ You                         [DND ▢]
  🎯  [ intent input… ]

▸ ● Rahul            EDITOR
  ✏️ Editing · src/auth/service.ts · L42
  📁 src/auth
  🎯 JWT refresh
  Active now                  [Follow] [Jump]

▸ ● Priya            VIEWER
  👀 Viewing · src/components/Login.tsx
  📁 src/components
  🎯 Mobile layout
  20s ago                     [Follow] [Jump]

WORKING IN
  src/auth/       Rahul
  src/components/  Priya
```

- Roster rows: color dot + availability dot; name; role chip; activity line — **M54 `run_status` wins** over `activity.type` (reuse `pickRunForUser`/`formatRunText` from `CollaboratorAvatarStack`, extract to a shared helper if needed); `activeFile` basename + `cursor.line`; `workingFolder`; `intent` (rendered as text); `formatRelativeTime(lastActive, now)`.
- Self row first: editable intent `<input maxLength={120}>` (debounced → `client.setIntent`), DND toggle.
- "WORKING IN" section from `groupCollaboratorsByFolder(collaborators, currentUserId)`.
- De-dupe roster by `userId` (multi-tab → one row, most-recent `lastActive`).
- Follow/Jump call the existing `IDE.tsx` handlers (already passed to `Toolbar` → thread to `TeamPanel`).

### 10.3 File tree (`Sidebar.tsx`)

- Existing: dot + "+N" on **file** rows from `collaboratorsByPath`.
- **Add:** same dot + "+N" on **directory** rows from `collaboratorsByFolder` (a folder shows the union of collaborators working under it). Reuse the existing indicator markup.

### 10.4 Current file (`Editor.tsx`)

- Existing: tab dots + proximity badge (within 5 lines).
- **Add:** a persistent one-line strip under the tab bar for collaborators whose `activeFile === activeFile` (via `collaboratorsInFile`): `🟣 Rahul · ✏️ Editing`. Distinct purpose from proximity (which is "close enough to collide"); this is "who else is in this file at all". Hidden when empty.

### 10.5 Monaco

No change. Remote cursor/selection/label already rendered by y-monaco + `editor.css`. M57 must not add awareness-driven document mutation or interfere with typing — verified by keeping all doc handling in the existing binding.

---

## 11. Testing strategy

Behavioral, deterministic (fake timers + explicit event injection; no sleeps). A reverted essential change must fail a test.

### 11.1 Backend — `backend/test/m57-presence.test.ts` (real Yjs + real `y-protocols/awareness`, mirrors `collab-awareness-security.test.ts`)

1. `workingFolder` — a valid relative folder is preserved verbatim; `activeFile` change updates it.
2. `workingFolder` — absolute / drive / `..` / control-char rejected (field dropped, connection unaffected).
3. `intent` — `{text:"JWT refresh", updatedAt: <finite>}` preserved.
4. `intent` — text trimmed, `\n`/`\t` collapsed, C0/DEL stripped.
5. `intent` — text > 120 chars truncated to 120.
6. `intent` — non-object / missing `updatedAt` / non-finite `updatedAt` ⇒ field dropped, rest of state intact.
7. `intent: null` ⇒ stored as explicit clear.
8. `status: "away"` passes the enum gate; `activity: "navigating"` passes.
9. an unknown status/activity value is still dropped (regression: enum gate intact).
10. identity still forced when the new fields are present (spoofed `user.id` + valid `intent` ⇒ session identity wins, intent kept).
11. a peer's clientID carrying `intent` is still rejected (ownership intact).
12. disconnect removes the connection's state incl. new fields; peer sees the collaborator gone.
13. reconnect with the same session ⇒ exactly one entry (no duplicate) and new fields re-populated.
14. two tabs of one user ⇒ two attributed entries, each with its own `workingFolder`.
15. room isolation — project B never sees project A's `intent`/`workingFolder`.
16. malformed frame carrying a huge `intent` string in a 64-entry batch ⇒ never throws, nothing stored.
17. concurrent document edits from two simulated clients converge (regression guard that presence work didn't disturb sync).
18. no `intent`/`workingFolder` path can smuggle content that looks like a secret/command (rebuild-from-scratch check).

### 11.2 Frontend

- `frontend/test/collab.presence.test.ts` — `readPresenceState` (all fields incl. `workingFolder`/`intent`, wire `status`→`availability` map, bad values → guards); `deriveWorkingFolder` (nested, root, null); `formatRelativeTime` boundaries; `collaboratorsInFile` / `collaboratorsInFolder` (prefix match + `workingFolder` match, `excludeUserId`); `groupCollaboratorsByFolder`.
- `frontend/test/collab.awareness.test.ts` (extend) — `notifyFileOpen` sets `workingFolder = dirname`; `setIntent` sets/clears the field + no-ops when unchanged; `setIntent` cleans control chars/length locally; `recordNavigation` → `activity.type === "navigating"` then reverts to `viewing` after the hysteresis; blur timer → `availability "away"` (not `idle`); `resetLocalCollabState` clears `workingFolder` + `intent`.
- `frontend/test/TeamPanel.test.tsx` — renders a roster from a `CollaboratorPresence[]` prop (no live client); self row first with intent input; typing the intent input (debounced) calls the injected `onSetIntent`; `run_status` overrides `activity` text; relative-time text from injected `now`; Follow/Jump buttons call injected handlers; "WORKING IN" groups; de-dupe by `userId`; count matches.
- `frontend/test/Sidebar.*` (extend the existing sidebar test) — a directory row shows a collaborator dot when a collaborator's `activeFile` is under it; clears when they leave.
- `frontend/test/Editor.*` (extend or new small test) — same-file strip lists a collaborator with matching `activeFile`, hidden when none.
- Reverting: removing the `workingFolder` sanitizer branch fails 11.1 #1–2; removing `deriveWorkingFolder` call fails the awareness test; removing `intent` clean fails #4–6; removing the TeamPanel de-dupe fails its test.

### 11.3 Regression

Full `backend` + `frontend` suites must stay green (777/9 backend with Docker, 313 frontend as of 2026-08-29). The M55 security suite (`collab-awareness-security.test.ts`, 28) must pass **unchanged** — it is the guard that the extraction preserved behavior.

---

## 12. Browser acceptance (Docker available in this environment)

Two authenticated Chrome sessions, same project, via `claude-in-chrome`. Steps 1–19 from the brief:

1 A joins → 2 B sees A in avatar stack + TeamPanel → 3 A opens `src/auth/service.ts` → 4 B sees A's active file (tree dot, TeamPanel, same-file strip) → 5 A edits → 6 B sees the change with no reload → 7 A moves cursor + selects → 8 B sees remote cursor/selection → 9 A sets intent "JWT refresh" → 10 B sees `🎯 JWT refresh` in TeamPanel → 11 A idle (fake via devtools or wait) → 12 B sees `idle` → 13 A closes tab → 14 B sees A disappear within the grace window → 15 A reconnects → 16 B sees exactly one A → 17 A + B edit near the same line concurrently → 18 both converge, no full-file clobber, no reload → 19 a third session in a *different* project shows no presence from this project.

Screenshots/GIF optional evidence only, not an acceptance gate. If any step cannot be executed, it is reported `PARTIAL` with the reason — never reported as passing.

---

## 13. Explicit non-goals (M57)

- Callouts / "come look here" / "jump everyone here".
- Activity history / feed / timeline.
- Chat, comments, threads, notifications, mentions.
- Any persistent state — no DB rows, no tables, no migration.
- Semantic merge / conflict-resolution intelligence. CRDT convergence ≠ semantic-intent merge; M57 tests convergence only.
- Task management / assignments / statuses beyond the one free-text `intent` line.
- Raw terminal sharing, stdout/stderr sharing, secret sharing.
- Symbol-level location ("around `refreshToken()`") — needs a language server; not present.
- Follow-mode changes (shipped M48).
- Backend folder-presence REST route (frontend selectors cover the M57 need).
- New `MESSAGE_CUSTOM` event types.
- A cross-package shared presence module (two hand-synced modules per repo convention).
- Renaming `viewing` → `reviewing` on the wire (deferred mechanical follow-up unless the reviewer asks).

---

## 14. Future extension points (already present — not built here)

- **`MESSAGE_CUSTOM`**: callouts, "come look here", activity events, comments, notifications — all fit the existing receive-only custom-message channel with a server-authoritative builder (the `run_status` / `external_mutation_notice` pattern).
- **`intent`**: a later milestone can promote it to a persisted task with assignees without changing the wire field (add a DB-backed mirror; awareness stays the live view).
- **`getCollaboratorFileState`**: extend to folder prefixes for a server-side "who's here" if a route ever needs it.
- **Activity `detail`**: a language-server milestone can fill in a symbol name.
- **`reviewing`**: reserved wire value for a future source-control-review activity.

---

## 15. Risks / tradeoffs

| Risk | Likelihood | Mitigation |
|---|---|---|
| Extraction of `buildAuthoritativeAwarenessState` regresses M55 security semantics | Low | Move verbatim, no rename; `collab-awareness-security.test.ts` (28) must pass unchanged; do the extraction as its own first step and run that suite before adding fields. |
| `workingFolder` derivation disagrees with user expectation ("I'm reviewing a PR across folders") | Medium | Documented as `dirname(activeFile)` only; it tracks editor focus, which is the honest signal. Cross-folder "areas" are a future concept. |
| `intent` free text used for abuse / injection | Low | Rendered as text (never HTML); length-capped; control chars stripped; visible only to authorized project members; ephemeral. |
| TeamPanel becomes the seed of a chat/feed | Medium (scope creep) | Non-goals (§13) are explicit; TeamPanel is a pure view of `CollaboratorPresence[]`, no message input beyond the single `intent` field. |
| `navigating` flicker (rapid tab switches) | Low | 2.5 s hysteresis + revert-to-`viewing`, same pattern as `editing`. |
| Adding `away` splits existing `idle` semantics; a test asserting `idle` on blur breaks | Low | Update that one assertion; behavior is strictly more informative; old clients still interoperate. |
| Two hand-synced presence modules drift again | Medium | A frontend test and a backend test each pin their enum list; a comment in each file cross-references the other. Accepted per repo convention (same as `types.ts`). |
| Relative-time ticker causes render churn | Low | Ticker is local to `TeamPanel`, cleared on unmount; verified against the existing `anyRunning`-gated pattern. |
| Landing on an already-dirty tree (Post-M56 fixes + STATUS reconciliation uncommitted) | Certain | Flag to the reviewer; recommend those are committed or stashed before M57 so the M57 diff is reviewable in isolation. Not blocking. |

---

## 16. Self-review findings

Applied against the brief's challenge list:

| Challenge | Finding | Action |
|---|---|---|
| Duplicating Yjs? | No. Zero changes to `doc`, sync protocol, `MonacoBinding`, coalescing. | — |
| Duplicating awareness? | No. New fields use `setLocalStateField` + the existing M55 rebuild. No second awareness instance, no second transport. | — |
| Folder context semantically correct? | **Corrected during design.** Original design wired Explorer folder-clicks into `activeFolder`; the brief rejected that. Now `workingFolder = dirname(activeFile)`, derived only. Explorer state explicitly documented as *not* a presence signal. Field renamed `activeFolder`→`workingFolder` to kill the ambiguity. | Spec §5.4, §6.3 |
| Availability vs activity separated? | Yes — two independent fields, two independent state machines. Added `away` to availability so blur ≠ no-interaction. Did **not** add a wire `idle` *activity* (redundant with availability); documented the conceptual mapping instead. | Spec §5.1–5.2 |
| Can presence go stale? | Disconnect path removes exactly the connection's clientIDs (existing, tested). New fields die with the state. Project switch clears. Test #12, #15, plus a stale-across-switch test. | §11.1 |
| Project switching leak users? | `IDE.tsx` already resets. New fields are local to the disposed client. Test added. | §8, §11.1 #15 |
| Malformed presence crash server? | `buildAuthoritativeAwarenessState` rebuilds from scratch and never throws; `sanitizeIncomingAwarenessUpdate` catches decode errors. New branches are pure guards. Tests #6, #16. | §8, §11.1 |
| High-frequency updates controlled? | Unchanged rAF/debounce/coalesce/backpressure. Ticker is panel-local. `Sidebar` folder map added to the existing memo. | §9 |
| Introducing persistent state? | No. No DB, no table, no migration, no file. `intent` is awareness-only. | §13 |
| TeamPanel backed by canonical presence? | Yes — it is a pure render of the single `collaborators: CollaboratorPresence[]` in `IDE.tsx`. No second store, no separate fetch. Selectors are pure functions over that array. | §6.2, §10.2 |
| Confusing CRDT convergence with semantic merge? | No. Tests assert *convergence* (both docs equal, no clobber) and the spec explicitly disclaims semantic-intent merge. | §11.1 #17, §13 |
| Turning M57 into chat/tasks/comments? | Guarded by §13. Only surface with an input is the single `intent` line. | §13, §15 |
| Is the consolidation worth its regression risk? | **Re-evaluated and narrowed.** Only the field allowlist + enums move (backend) / the parse + selectors are created (frontend). `sanitizeIncomingAwarenessUpdate`, `CollaboratorClientState`, and every security invariant stay in `manager.ts`. Justified because G1/G2 both add allowlist branches and the enums demonstrably drift across 3 files today. Done as an isolated first step gated on the M55 suite passing unchanged. If the reviewer disagrees, the fields can be added inline in `manager.ts`/`client.ts` and the modules skipped — the rest of the plan is unaffected. | §6.1, §15 |

**Changes made to the design vs the prior chat proposal:**
1. `activeFolder` → `workingFolder`; removed the Explorer-click signal entirely (derived only).
2. Availability gains `away` (blur), distinct from `idle` (no-interaction-while-focused).
3. Activity: add `navigating` only; keep `viewing` (documented ≡ conceptual `reviewing`); do not add wire `idle`.
4. Consolidation explicitly narrowed to a mechanical extraction gated on the M55 suite, with an inline fallback.
5. TeamPanel is an anchored dropdown, not a layout drawer.

---

## 17. Open decisions requiring reviewer approval

1. **`viewing` vs `reviewing` on the wire** (§5.2). Recommendation: keep `viewing`. If you want the literal rename to match the brief's enum exactly, say so — it is a mechanical change to ~4 `client.ts` sites + 1 component + 3 tests.
2. **Retiring the per-avatar quick popover** in favor of TeamPanel (§10.1). Recommendation: retire it (strict subset). If you want both, TeamPanel still ships; the popover stays untouched.
3. **Dirty working tree** (§15). Recommendation: commit or stash the Post-M56 fixes + STATUS reconciliation before M57 implementation so the M57 diff is reviewable alone. Your call — you have said not to commit.

Everything else is settled engineering detail and does not need approval.
