# M58 — Live Attention, Callouts & Spatial Collaboration

**Status:** design, self-reviewed. Not yet implemented. Not committed.
**Date:** 2026-08-30
**Milestone type:** a third human-collaboration layer (ATTENTION) on top of M57's
PRESENCE layer. Rides the existing `MESSAGE_CUSTOM` transient event channel. No
new transport, no new presence system, no new document-sync mechanism, no
database persistence.

---

## 1. Product intent

M57 answers *"where is Rahul and what is he doing?"*. M58 answers *"what does
Rahul want me to look at, where, and how urgently?"* — so a remote collaborator
can naturally say **"Yo, come look at this."**

Three gestures, escalating in weight:

| Gesture | Meaning | Weight |
|---|---|---|
| **Point** | "👉 look here" — a location, no words | tiny, transient, broadcast |
| **Callout** | "📣 the race is here" — a range + a short message | visible near the code, short-lived, broadcast |
| **Come look here** | "📣 Rahul wants *your* attention" — a targeted request with [Go there] / [Dismiss] | actionable, dismissible, targeted, survives a reconnect while valid |

Plus one presence-derived awareness signal:

| Signal | Meaning |
|---|---|
| **Nearby / overlapping edit** | "⚠ Rahul is editing the same lines" — derived from M57 presence, never a lock, never a semantic-conflict claim |

The boundary M58 must cross:

> M57: *"Rahul is working over there."*
> M58: *"Rahul is working over there — and can point me to exactly what he wants me to see."*

---

## 2. Layer model (the invariant M58 must not blur)

```
DOCUMENT STATE   → Yjs CRDT                        (unchanged)
PRESENCE STATE   → y-protocols/awareness           (unchanged; M58 READS it)
ATTENTION STATE  → MESSAGE_CUSTOM transient events (M58 adds here)
PERSISTENCE      → filesystem / Git                (attention is NEVER written here)
```

| Concept | Owner | M58 stance |
|---|---|---|
| CRDT convergence (shared doc converges) | Yjs | untouched; regression-guarded |
| Spatial awareness (who works near whom) | M57 presence → M58 derives tiers | consumed read-only |
| Semantic conflict (incompatible intent) | — | **not built.** Overlap ≠ conflict. |

---

## 3. Existing architecture (verified against code, 2026-08-30)

### 3.1 Transport — `MESSAGE_CUSTOM` (type 3)

- `backend/src/collab/manager.ts` — one `case MESSAGE_CUSTOM` in `handleMessage`
  (currently only `file_open`). `broadcastRunStatus(obj)` (line ~643): JSON
  string → frame → loop over `this.clients` (`readyState === 1`). `addClient`
  step 3 (line ~846): per-connection snapshot of `runStatus` entries on join.
- `frontend/src/collab/client.ts` — `case MESSAGE_CUSTOM` in `handleMessage`
  (line ~633): `file_ready` / `run_status` / `external_mutation_notice`, all
  **receive-only** (`this.emit(...)`). The client authors only `file_open`.
- `RunStatusEntry` registry + linger timers + a sweep interval are the working
  pattern for "server holds a bounded, TTL'd, in-memory ephemeral map and
  snapshots it to a joining client".

### 3.2 Room, auth, identity

- `/ws/collab?projectId=` in `backend/src/ws/index.ts` (line ~333). Cookie
  session → `requireProjectAccess(db, row.id, projectId, "viewer")`.
  `room.addClient(ws, { userId: row.id, username: row.username, role })` — the
  server sets identity; the client never supplies it.
- `CollaborationRoom.clients: Map<WebSocket, CollaboratorClientState>` where
  `CollaboratorClientState = { userId, username, role, activeFile?,
  awarenessClientIds? }`. **Targeted delivery is a filter over this map** —
  `for (const [sock, s] of this.clients) if (s.userId === targetUserId) sock.send(frame)`.
- `disconnectUser(userId)` / `removeClient(ws)` / `updateUserRole` /
  `revokeUser` — existing live-authorization hooks. `removeClient` already
  guards `this.disposed`.

### 3.3 Presence (M57) — read-only inputs for M58

- `frontend/src/collab/presence.ts` — `CollaboratorPresence { clientId, userId,
  name, role, color, status, activity, activeFile?, workingFolder?, cursor?,
  selection?, intent?, lastActive, activeFileDirty? }`; `readPresenceState`,
  `collaboratorsInFile`, `getUserColor`.
- `backend/src/collab/presence.ts` — `sanitizeAwarenessFilePath` (bounded
  workspace-relative path: no absolute, no drive, no `..`, no C0/DEL, ≤512),
  `sanitizeIntentText` (C0/DEL→space, collapse ws, trim, ≤120), `isAwarenessCoord`
  (finite, 0…5e6). **M58 reuses all three.**
- `IDE.tsx` — the single `collaborators: CollaboratorPresence[]` state, fed by
  `client.on("awareness_change", throttleLatest(setCollaborators, 200))`. M58
  adds `attention: AttentionEvent[]` fed the same throttled way. **No second
  collaborator store.**
- `Editor.tsx` — `nearbyEditingCollaborators` memo: same `activeFile`,
  `activity.type === "editing"`, `Math.abs(c.cursor.line - localCursorLine) <= 5`.
  M58 **extends** this memo into three tiers; does not add a parallel one.

### 3.4 Navigation — the open-then-reveal primitive

- `frontend/src/utils/revealLocation.ts` — `openAndRevealLocation(openFile,
  target)`: `await openFile(target.filePath)` **then** dispatch
  `ide-reveal-location`. The comment is explicit: the open MUST precede the
  reveal or the reveal is dropped (closed file) or misapplied (wrong active
  file).
- `Editor.tsx` (line ~534) — the `ide-reveal-location` listener:
  `setActiveFile(filePath)` if needed, then (50 ms later)
  `revealPositionInCenter` + `setPosition` + optional `setSelection` + `focus()`.
- **Known gap M58 fixes:** `IDE.tsx`'s `handleJumpToCollaborator` (line ~913)
  and the follow effect (line ~868) currently call `handleOpenFile` +
  `setTimeout(dispatch, 100)` directly — bypassing `openAndRevealLocation`.
  M58 routes **all** attention navigation through the primitive and retrofits
  Jump onto it (with a regression test that closed-file navigation cannot
  regress to dispatch-only).

---

## 4. M58 architecture

### 4.1 New modules

| File | Create/Modify | Responsibility |
|---|---|---|
| `backend/src/collab/attention.ts` | **Create** | Pure: `ATTENTION_*` constants, `AttentionType`, `normalizeRange`, `validateAttentionInput`, `buildAttentionEvent` (server-authoritative construction), `newAttentionId`. Plus `AttentionRequestRegistry` (bounded in-memory Map + TTL timers). No `ws` / `Y.Doc` imports. |
| `backend/src/collab/manager.ts` | Modify | One `handleAttentionMessage(ws, clientState, parsed)` branch inside the existing `case MESSAGE_CUSTOM`; `broadcastAttentionEvent()` / `sendAttentionEventTo(userId, ...)`; per-connection rate-limit bucket on `CollaboratorClientState`; registry wiring in `addClient` (recipient snapshot) and `removeClient` (author/target cleanup); registry cleared in `dispose()`. |
| `frontend/src/collab/attention.ts` | **Create** | Pure: wire types, `normalizeRange`, `rangesOverlap`, `RANGE_NEAR_LINES`, TTL constants. `AttentionStore` (Map + expiry timers + change emitter). |
| `frontend/src/collab/client.ts` | Modify | `sendAttentionPoint/Callout/Request` + `dismissAttentionRequest`; `MESSAGE_CUSTOM` receive branch for `attention_event` / `attention_cleared` → `attentionStore` → `emit("attention_change", ...)`; cleared in `resetLocalCollabState()` + `dispose()`. |
| `frontend/src/components/Collab/AttentionTray.tsx` | **Create** | Bottom-right non-modal stack of incoming targeted-request cards + the sender's "✓ Sent" confirmation. |
| `frontend/src/components/Editor/Editor.tsx` | Modify | Monaco editor actions (Call out / Point / Come look); point + callout decorations/widgets; three-tier nearby memo. |
| `frontend/src/components/IDE/IDE.tsx` | Modify | `attention` state (throttled); `handleAttentionNavigate` via `openAndRevealLocation`; retrofit `handleJumpToCollaborator`; thread props to Editor + AttentionTray. |
| `frontend/src/components/Collab/CollaboratorAvatarStack.tsx` | Modify | Small incoming-attention count badge on the existing collaborator chip. |
| `frontend/src/styles/collab.css` | Modify | Point / callout / tray / nearby-tier styles. Ambient, low-alpha, collaborator-colored, fade transitions. |

### 4.2 Server/client responsibility split

**Server (authoritative):** authentication; project scope; event-type
allowlist; author identity (from `clientState`); target validation (member of
*this* room, currently connected, not self); range/path/message validation;
per-connection rate limiting; the request registry; request expiry; lifecycle
cleanup on disconnect; `id`, `createdAt`, `expiresAt`, `color` construction.

**Client:** rendering; local TTL/fade for point & callout (bounded by the
server's `expiresAt`); dismiss interaction; navigation via
`openAndRevealLocation`; the local `AttentionStore`. **The client never authors
`id`, `author`, `createdAt`, or `expiresAt`.**

---

## 5. Protocol / event model

### 5.1 Client → server (authored — 4 types, closed set)

```jsonc
{ "type": "attention_point",    "file": "...", "range": {...} }
{ "type": "attention_callout",  "file": "...", "range": {...}, "message": "..." }
{ "type": "attention_request",  "targetUserId": 12, "file": "...", "range": {...}, "message": "..." }
{ "type": "attention_dismiss",  "id": "a1b2c3d4e5f6" }
```

`range = { startLine, startColumn, endLine, endColumn }`.

### 5.2 Server → clients (rebuilt — the client never authors these)

```jsonc
{ "type": "attention_event",
  "id": "a1b2c3d4e5f6",                 // server-generated opaque, unguessable
  "kind": "point" | "callout" | "request",
  "author": { "userId": 7, "username": "rahul", "color": "#89b4fa" },
  "file": "auth/session.ts",
  "range": { "startLine": 40, "startColumn": 1, "endLine": 52, "endColumn": 1 },
  "message": "I think the race is here.",   // callout/request only
  "targetUserId": 12,                        // request only
  "createdAt": 1723900000000,
  "expiresAt": 1723900120000 }               // hard server ceiling for ALL kinds

{ "type": "attention_cleared",
  "id": "a1b2c3d4e5f6",
  "reason": "dismissed" | "expired" | "acted" | "author_gone" }
```

### 5.3 The attention ID

`newAttentionId()` = 12 bytes from `crypto.randomBytes` → hex (or
`crypto.randomUUID()`), **not derived from projectId/userId/counter**. Opaque,
unguessable, collision-negligible within a room. A client-supplied `id` is only
honored on `attention_dismiss` and only to look up a registry entry whose
`targetUserId` matches the dismisser (§6.4) — never to create or address a new
event.

### 5.4 Validation (`validateAttentionInput`, server-side, never throws)

| Field | Rule | On failure |
|---|---|---|
| `type` | ∈ the 4 authored types | drop silently |
| `file` | `sanitizeAwarenessFilePath` → non-null string | drop |
| `range` | `normalizeRange`: 4 coords via `isAwarenessCoord`; `(startLine,startColumn) ≤ (endLine,endColumn)`; reversed/NaN/Infinity/negative → `null` | drop |
| `message` (callout/request) | clean like `sanitizeIntentText` but cap `ATTENTION_MAX_MESSAGE_LEN = 280`; C0/DEL→space; `\s+`→` `; trim; **empty after clean → drop** | drop |
| `message` (point) | ignored entirely | — |
| `targetUserId` (request) | integer; matches another **currently-connected** client's `userId` in this room; **not** the sender | drop silently (no error frame) |
| frame | JSON parse in the existing `try/catch`; object depth/size bounded by the existing `DEFAULT_WS_MAX_PAYLOAD` (1 MiB) | drop |

### 5.5 Rate limiting (`ATTENTION_RATE_*`)

- **Per connection:** sliding window, `ATTENTION_MAX_EVENTS_PER_WINDOW = 10` per
  `ATTENTION_RATE_WINDOW_MS = 10_000`. 11th within the window → dropped (not
  queued). Stored as a small timestamp ring on `CollaboratorClientState`.
- **Per author, outstanding requests:** `ATTENTION_MAX_OUTSTANDING_REQUESTS = 3`
  registry entries. A 4th → **drop** (simplest; the sender's UI shows "you have
  too many pending requests"). (Alternative — evict oldest — is a one-line
  change if review prefers it; drop is the conservative default.)
- **Room-wide registry cap:** `ATTENTION_MAX_REGISTRY_ENTRIES = 200`. At the cap
  a new entry evicts the oldest (`createdAt`) with an `attention_cleared`
  `{expired}` to its recipient.
- Points and callouts are not registry-held, so only the per-connection window
  applies to them.

---

## 6. Lifecycle

### 6.1 Point

- Not held server-side. `broadcastAttentionEvent` to every room socket **except
  the author**.
- `expiresAt = createdAt + ATTENTION_POINT_TTL_MS` (6 s). No server timer — the
  ceiling is advisory; the client store enforces it and fades.

### 6.2 Callout

- Not held server-side. Broadcast except the author.
- `expiresAt = createdAt + ATTENTION_CALLOUT_MAX_TTL_MS` (**hard 90 s ceiling**).
- Client store: default visible `ATTENTION_CALLOUT_TTL_MS` (45 s), refreshable
  **only while the callout's range is within the visible editor viewport**, but
  **never past `expiresAt`**. "Visible ≠ indefinite" is enforced by the server
  ceiling, tested with fake timers.

### 6.3 Request — the bounded in-memory registry

`AttentionRequestRegistry` (one per room, or a `Map<projectId, ...>` on the
manager — room-owned is simpler and disposes naturally):

```
Map<id, {
  event: AttentionEvent,   // kind: "request"
  authorUserId: number,
  targetUserId: number,
  timer: NodeJS.Timeout,   // fires at expiresAt → clear({expired})
}>
```

- **Create:** after validation + rate check + outstanding-cap check.
  `expiresAt = createdAt + ATTENTION_REQUEST_TTL_MS` (120 s). `timer.unref()`.
  Deliver via `sendAttentionEventTo(targetUserId)` **and** echo the same event
  to the author (so the sender gets "✓ Sent").
- **Expiry:** the timer fires → `attention_cleared {expired}` to the target (and
  author echo) → delete. Never delivered again.
- **Dismiss** (`attention_dismiss {id}` from the target): look up; require
  `entry.targetUserId === dismisser.userId`; `attention_cleared {dismissed}` to
  the target; delete. A dismiss from anyone else is a no-op.
- **"Go there"** on the client also sends `attention_dismiss` → server clears
  with `{acted}` (client may treat `acted`/`dismissed` identically).
- **Author disconnect** (`removeClient`): delete every entry with
  `authorUserId === userId`; `attention_cleared {author_gone}` to each target.
- **Target disconnect** (`removeClient`): delete every entry with
  `targetUserId === userId`. **Nothing is sent, nothing is retained.** If that
  user reconnects after expiry-or-not, the entry is simply gone.
- **Room dispose:** clear all timers, drop the map.

### 6.4 Join / reconnect snapshot (`addClient`)

After the existing sync + awareness + runStatus snapshot steps, iterate the
registry: for each entry where `targetUserId === clientState.userId` **and**
`now < expiresAt`, send one `attention_event`. That is the **only** replay:

- a reconnecting **target** sees still-valid requests aimed at them,
- a reconnecting **bystander** sees nothing,
- an **expired** request is never in the map, so never replayed,
- a request **targeted at another user** is never sent here.

### 6.5 No persistence

The registry is in-memory only. No SQLite table, no migration, no workspace
file, no Git object, no `Y.Doc` key. `doc.share` is never touched by any
attention path (asserted in tests).

---

## 7. Range semantics (`normalizeRange`, `rangesOverlap`)

Monaco is 1-based line/column; end column is exclusive of the caret's right
edge. Ranges are `{ startLine, startColumn, endLine, endColumn }`.

`normalizeRange(r)`:
- every coord finite and `isAwarenessCoord` → else `null`;
- if `(startLine, startColumn)` is after `(endLine, endColumn)` → `null`
  (reversed input is **rejected, not swapped** — a reversed range from a client
  is malformed);
- a zero-width range (`start === end`) is valid (a bare cursor position).

`rangesOverlap(a, b)` (both already normalized):
- different line spans that don't touch → `false`;
- share ≥ 1 interior line → `true`;
- same single line: `true` iff the column intervals `[aStart, aEnd)` and
  `[bStart, bEnd)` intersect with positive width;
- **touching boundaries** (`aEnd === bStart`) → `false` (adjacent, not
  overlapping);
- a zero-width range at column `c` overlaps `[s, e)` iff `s ≤ c < e` (contained),
  and overlaps another zero-width range iff identical position.

Test matrix (both backend pure + frontend pure): different lines; same-line
overlapping columns; same-line adjacent (touching → no); same-line disjoint;
multi-line overlap; identical ranges; zero-width inside; zero-width outside;
zero-width == zero-width; reversed input → `null` (rejected before compare);
NaN / Infinity / negative → `null`.

---

## 8. Spatial awareness (feature 6) — three tiers from M57 presence

`Editor.tsx` `nearbyEditingCollaborators` memo becomes `spatialCollaborators`,
computed from the local selection (or cursor) vs each collaborator's
`selection ?? cursor` where `c.activeFile === activeFile` and
`c.userId !== currentUserId`:

| Tier | Condition | UI |
|---|---|---|
| **same file** | `c.activeFile === activeFile` (any activity) | the existing M57 same-file strip — **unchanged** |
| **nearby** | `c.activity === "editing"`, ranges within `RANGE_NEAR_LINES` (5) lines but **not** overlapping | subtle badge: "Rahul editing nearby (within 5 lines)" — current badge, reworded |
| **overlapping** | `c.activity === "editing"`, `rangesOverlap(local, theirs)` | stronger badge (warn color): "⚠ Rahul is editing the same lines" + `[View Rahul]` → `openAndRevealLocation` to their cursor |

- Still `role="status"`, `aria-live="polite"`. Never blocks, never locks, never
  claims semantic conflict.
- Pure presence read — no awareness write, no new field, no new store.

---

## 9. UX surfaces

### 9.1 Author actions (`Editor.tsx`, Monaco `editor.addAction`)

Registered once on editor mount, enabled only when
`collabClientRef.current?.status === "connected"` and not read-only:

| Action id | Label | Behavior |
|---|---|---|
| `cloudide.attention.point` | 👉 Point here | send `attention_point` with `activeFile` + `editor.getSelection()` immediately |
| `cloudide.attention.callout` | 📣 Call out selection | open a small inline message input (Monaco overlay widget anchored to the selection, **not a modal**, ≤280 chars, Enter=send, Esc=cancel) → `attention_callout` |
| `cloudide.attention.comeLook` | 📣 Come look here… | small collaborator picker (from `collaborators`, connected, minus self) → optional message input → `attention_request` |

File path and range are captured automatically from editor state — the user
never types a path or line number.

### 9.2 Incoming Point — Editor decoration

Glyph-margin dot + a one-line trailing `after` decoration at `range.startLine`
in `author.color` ("👉 Rahul"). No view zone (no layout shift). Removed by the
store's 6 s timer with a CSS opacity fade.

### 9.3 Incoming Callout — Editor decoration + content widget

- Range decoration: `author.color` background at low alpha over `range`.
- A content widget positioned just above `range.startLine`: color dot,
  "📣 {author.username}", then `message` set via **`textContent`** (never
  `innerHTML`; no Markdown→HTML). A "×" dismisses locally (store remove only —
  callouts aren't server-held).
- Fades at the client TTL; hard-gone at `expiresAt`.

### 9.4 Incoming Request — `AttentionTray.tsx` (bottom-right, non-modal)

Compact stacked cards:

```
📣 Rahul wants your attention
auth/session.ts · L40–52
"I think the race is here."
[Go there]   [Dismiss]
```

- `[Go there]` → `onAttentionNavigate(evt)` + `client.dismissAttentionRequest(id)`.
- `[Dismiss]` → `client.dismissAttentionRequest(id)`.
- At most 3 cards; older collapse to a "+N earlier" affordance.
- **Sender confirmation:** the server echoes the request event to the author;
  the tray renders a muted "✓ Sent to Rahul" line that self-clears in ~4 s.
- The tray also drops a card on `attention_cleared` if the reason is
  `author_gone` ("Rahul left — request withdrawn"), briefly.

### 9.5 Navigation (all three gestures)

`IDE.handleAttentionNavigate(evt)`:

```
openAndRevealLocation(handleOpenFile, {
  filePath: evt.file,
  line: evt.range.startLine,
  column: evt.range.startColumn,
})
  → (openFile opens the tab if closed)
  → ide-reveal-location → Editor centers + positions + focuses
  → then a collaborator-context hint (reuse the follow context display)
```

`handleJumpToCollaborator` is retrofitted onto the same primitive. A regression
test asserts that for a file **not** in `openFiles`, `openFile` is invoked
**before** `ide-reveal-location` fires (spy call-order) — closed-file attention
navigation cannot regress to dispatch-only.

### 9.6 Attention count (`CollaboratorAvatarStack.tsx`)

A tiny badge on the existing collaborator chip: count of active incoming
attention items (points + callouts + requests targeted at me). Click focuses /
toggles the tray. No new toolbar button.

---

## 10. Security / trust model

| Boundary | M58 stance |
|---|---|
| **Author identity** | Always `clientState` (authenticated WS session). Any `author` / `userId` in the payload is ignored. `buildAttentionEvent` never spreads the incoming object. |
| **Project scope** | Events are only ever delivered inside the room, and a room is only joined after `requireProjectAccess(…, "viewer")`. No cross-room fan-out. Registry is room-owned. |
| **Target authorization** | `targetUserId` must equal the `userId` of another **currently-connected** client in **this** room. No match → silent drop. Self-target dropped. A user revoked mid-session (`disconnectUser`) is gone from `this.clients`, so new requests to them fail and their outstanding entries are cleared by `removeClient`. |
| **Forged / guessed ID** | IDs are `crypto` random, not derived from identity. A client can only *dismiss* an id whose registry entry targets that same client; it cannot create or address an event by id. Duplicate-id creation is impossible (server generates). |
| **Replay / stale** | Only currently-valid, correctly-targeted requests are re-sent, and only to the target, only on their join. Expired = deleted = never replayed. Author/target disconnect deletes. |
| **XSS / injection** | `message` is cleaned (C0/DEL stripped, newlines normalized, trimmed, ≤280) and rendered as **text only** (`textContent` / React child) everywhere — tray, callout bubble, tooltips. No `innerHTML`, no Markdown→HTML, no `dangerouslySetInnerHTML`. Test: a `<img onerror>` payload renders literally. |
| **Path traversal** | `file` through `sanitizeAwarenessFilePath` — the same guard as `activeFile`/`workingFolder`. No filesystem access on the attention path at all (unlike `ensureFileLoaded`). |
| **Malformed frames** | The whole branch is inside the existing `try { JSON.parse(...) } catch {}`. Validators return `null`/drop, never throw. No registry entry, no broadcast, no presence mutation, no doc mutation, no unbounded allocation (payload capped at 1 MiB by `DEFAULT_WS_MAX_PAYLOAD`; per-window event count capped at 10). |
| **Event amplification / flooding** | Per-connection 10 / 10 s window; ≤3 outstanding requests per author; room registry cap 200 with oldest-eviction. Burst-tested. |
| **Memory growth** | Registry is the only server-held state: bounded entry count, every entry has a TTL timer, entries deleted on expiry / dismiss / disconnect / dispose. No event history, no per-user log. |
| **Cross-project leakage** | Tested: room B never receives room A's attention events; a third session in a different project sees nothing. |
| **Secret / terminal / output leakage** | M58 adds no channel that carries file contents, diffs, stdout/stderr, env, or secrets. `message` is user free text; `range`/`file` are coordinates + a bounded path. |
| **Document integrity** | No attention path opens a `Y.Doc` transaction or calls `doc.getText`. Concurrent-edit convergence is regression-tested with attention frames interleaved. |

---

## 11. Performance model

| Concern | Approach |
|---|---|
| IDE re-render on attention | `client.on("attention_change", throttleLatest(setAttention, 200))` — one throttled state, mirrors `setCollaborators`. No per-event global render. |
| Editor decorations | One `createDecorationsCollection().set(...)` per attention-list change, keyed by id. Point/callout only. |
| Client store timers | One `setTimeout` per point/callout; cleared on removal / unmount / dispose / project switch. Requests have no client timer. |
| Server timers | One `setTimeout` per registry request, `unref()`, cleared on every exit path. No sweep interval needed (unlike runStatus, which can have a stuck "running"). |
| Broadcast volume | Attention is human-frequency (seconds+), far below cursor awareness. No coalescing added — a point/callout is one frame; requests are targeted (1–2 sockets). |
| DB / disk | None. |
| Awareness updates | None — M58 never writes awareness. |

---

## 12. Testing strategy

Behavioral, deterministic (fake timers + explicit frame injection; no sleeps).
A reverted essential change must fail a test.

### 12.1 Backend — `backend/test/m58-attention.test.ts` (real `CollaborationRoom`, `makeWs()` harness from `m57-presence.test.ts`)

**Pure (`attention.ts`):**
1. `normalizeRange` — ordered pass-through; reversed → null; NaN/Infinity/negative → null; zero-width valid.
2. `rangesOverlap` — full matrix from §7 (different lines; same-line overlap; same-line adjacent/touching → false; same-line disjoint; multi-line overlap; identical; zero-width inside/outside/equal; reversed rejected).
3. `buildAttentionEvent` — author forced from session; payload `author`/`userId` ignored; `id` present, opaque, differs across two calls, not derivable from userId/projectId.
4. `newAttentionId` — uniqueness across N calls; hex/uuid shape.

**Room pipeline:**
5. valid `attention_point` → broadcast to peers, not to author; not registry-held.
6. valid `attention_callout` with message → broadcast; message preserved.
7. valid `attention_request` → delivered to target only; echoed to author; registry entry created.
8. author identity server-authoritative (spoofed `author.userId` in payload → event carries the session identity).
9. `attention_request` to a non-member userId → dropped, no registry entry, no frame.
10. `attention_request` to an offline (not-connected) member → dropped.
11. `attention_request` targeting self → dropped.
12. `file` absolute / `..` / drive / control char → dropped.
13. `range` reversed / non-finite / out-of-bounds → dropped.
14. `message` — control chars stripped, `\n`/`\t` → space, trimmed; `>280` capped; empty-after-clean callout/request → dropped.
15. malformed frame (non-JSON; unknown `type`; deeply nested object; 1 MiB string) → no throw, no registry entry, no broadcast, `doc.share` size unchanged.
16. rate limit — 11th event in 10 s dropped; burst of 50 → ≤10 delivered in the window.
17. outstanding-request cap — 4th concurrent request from one author dropped (assert cap = 3); a dismissed one frees a slot.
18. room registry hard cap (lowered in the test) → oldest evicted with `attention_cleared {expired}`.
19. **expiry** (fake timers) — request auto-`attention_cleared {expired}` at exactly `ATTENTION_REQUEST_TTL_MS`; never before; never re-delivered after.
20. **callout hard ceiling** — server `expiresAt` = `createdAt + 90s` regardless of client behavior.
21. **dismissal** — `attention_dismiss {id}` from the target → `attention_cleared {dismissed}` + entry gone; dismiss from a non-target → no-op.
22. **author disconnect** — `removeClient(author)` → every authored request cleared `{author_gone}` to its target.
23. **target disconnect** — `removeClient(target)` → their requests deleted; nothing sent; on their reconnect the snapshot is empty.
24. **reconnect snapshot** — target reconnects while a request is valid → receives exactly that event; a bystander reconnect receives none; an expired request is not replayed; a request for another user is not sent.
25. **project isolation** — two rooms; A's attention never reaches B.
26. **no persistence** — after a full point/callout/request cycle: no new SQLite rows, no workspace file, `doc.share` unchanged.
27. **concurrent Yjs edits converge** with attention frames interleaved (real `y-protocols/sync` edits from two simulated clients).
28. forged/duplicate `id` on create — impossible (server generates); a client `id` on `attention_point`/`callout`/`request` is ignored.

### 12.2 Frontend

- `frontend/test/collab.attention.test.ts` — `AttentionStore`: point removed at 6 s, callout at 45 s, request persists until `attention_cleared`/dismiss (fake timers); server `expiresAt` caps a longer local TTL; `attention_cleared` removes; dismiss removes locally. `rangesOverlap` / `normalizeRange` matrix (shared logic, mirrors backend).
- `frontend/test/AttentionTray.test.tsx` — request card renders author/file/`L40–52`/message; `[Go there]` calls navigate + `dismissAttentionRequest`; `[Dismiss]` calls `dismissAttentionRequest`; author echo → "✓ Sent to Rahul"; ≥4 cards collapse; message with HTML renders literally.
- `frontend/test/Editor.attention.test.tsx` — point decoration at the right line; callout bubble text is `textContent` (XSS payload literal); range highlight present; decorations cleared when the store empties; **closed-file navigation**: `onAttentionNavigate` for a file absent from `openFiles` invokes `openFile` before `ide-reveal-location` (spy order) — cannot regress to dispatch-only; no Monaco model edit from any attention render.
- `frontend/test/Editor.nearby.test.tsx` — same-file only → informational strip; `Δline ≤ 5` non-overlapping → nearby badge; overlapping selections → strong badge + `[View Rahul]`; far / non-editing → silent; never writes awareness or doc.
- `frontend/test/collab.follow.attention.test.tsx` — a callout/request arriving mid-Follow does not break follow; navigating to attention interacts with follow exactly like a manual open (pause/stop per existing dirty rules).
- Revert guards: remove the `openAndRevealLocation` call → closed-file test fails; remove author-forcing → spoof test fails; remove target-membership check → isolation test fails; remove the server `expiresAt` ceiling → callout-ceiling test fails.

### 12.3 Regression

Full backend (baseline **804 / 0 / 9**, Docker available) + full frontend
(**366 / 0**) stay green. `collab-awareness-security.test.ts`,
`m57-presence.test.ts`, and `m4-collab.test.ts` concurrent-convergence cases
pass **unchanged**.

---

## 13. Browser / multi-session acceptance (Docker available)

Two authenticated Chrome sessions, same project, via `claude-in-chrome` when the
extension is connected; otherwise a headless two-client WebSocket script against
the running dev server (real transport, real room, real registry) — reported
**PARTIAL** for visual, never called "visual verification".

Steps: 1 both present → 2 Rahul selects code → 3 Rahul points → 4 peer sees it
immediately at the right line → 5 peer jumps (opens/reveals) → 6 Rahul callouts
→ 7 peer sees the bubble at the exact range → 8 peer navigates to it →
9 Rahul "come look here" targeting the peer → 10 peer's tray shows the request →
11 `[Go there]` → 12/13 correct file opens + range revealed + editor focused →
14 `[Dismiss]` removes it → 15 Rahul sends another → 16 Rahul disconnects →
17 the peer's request is cleared (`author_gone`) → 18 Rahul reconnects →
19 no stale request resurrects → 20 Rahul + peer edit nearby → 21 nearby badge →
22 they edit non-overlapping regions → 23 no warning → 24 concurrent edits
converge, no clobber, no reload → 25 a third session in a different project sees
none of this.

---

## 14. Explicit non-goals (M58)

Change attribution (→ M60); activity history / feed / timeline; while-you-were-away;
persistent comments; comment threads; mentions; reactions; chat; semantic
conflict / merge resolution; raw terminal / stdout / stderr sharing;
AI-generated collaboration; collaboration analytics; **any** DB / Git / Yjs /
workspace-file persistence of attention; a new WebSocket endpoint; a new
presence store; a new document-sync mechanism.

---

## 15. Future roadmap (extension points left clean)

- **M59** — Follow + attention integration; shared focus; "come here" workflows
  (the `attention_request` + `AttentionStore` + `openAndRevealLocation` path is
  the seam).
- **M60** — change attribution (`doc.on("update", origin=ws)` already attributes
  a transaction to a connection); collaboration history; while-you-were-away;
  meaningful activity feed.
- **M61** — persistent comments; threads; mentions; reactions (a callout could
  gain a "keep" action that promotes it to a DB-backed comment — the wire event
  need not change).
- **M62** — deep conflict awareness for the same region (the three-tier spatial
  model is the base); overlap resolution UX.
- **M63+** — team intelligence; people ↔ code graph; analytics; AI-assisted
  collaboration.

---

## 16. Risks / tradeoffs

| Risk | Likelihood | Mitigation |
|---|---|---|
| Attention UI becomes notification spam | Medium | Point = 6 s fade; callout = 45 s (90 s hard cap); tray max 3 cards; count badge instead of stacked toasts; no sound; `role="status"` not `alert`. Non-goals (§14) guard the slide into chat/feed. |
| The request registry grows or leaks timers | Low | Bounded entry count + oldest-eviction; every entry has one `unref()` timer cleared on every exit path; cleared in `dispose()`; tested (§12.1 #18, #19, #22, #23). |
| Client fabricates / addresses an event by id | Low | IDs are `crypto` random; id is only accepted on `attention_dismiss` and only against an entry targeting the dismisser; create is always server-side. |
| Closed-file navigation regresses to dispatch-only (the M57-fixed bug class) | Medium | All attention nav + retrofitted Jump go through `openAndRevealLocation`; a spy-order regression test pins it. |
| Retrofitting `handleJumpToCollaborator` perturbs M57 follow behavior | Low | Follow's own effect already uses `handleOpenFile`; the retrofit only replaces the `setTimeout(dispatch)` tail with the primitive. `collab.follow.*` suites must pass unchanged. |
| Overlap tier read as a semantic-conflict claim | Medium | Copy is "editing the same lines", never "conflict"; no blocking; §2 + §14 explicit; test asserts no edit/lock side effect. |
| Rate-limit numbers wrong for real use | Low | Constants centralized in `attention.ts`; burst-tested; easy to tune. |
| Landing on the uncommitted M56/M57 tree | Certain | M58 changes stay in new files + additive branches; the diff is separable. Do not revert M57. |

---

## 17. Open decisions requiring reviewer approval

1. **Outstanding-request 4th-event policy** (§5.5): recommendation **drop the
   4th** (sender sees "too many pending"). Alternative: evict the sender's
   oldest. One-line difference.
2. **Callout viewport-refresh** (§6.2): recommendation ship the 45 s default +
   90 s hard ceiling, refresh-while-visible. If the reviewer wants it simpler,
   drop the refresh and just use a flat 45 s — the hard ceiling test is
   unaffected.
3. **Attention count badge location** (§9.6): recommendation on the existing
   collaborator chip. If the reviewer prefers it on the `AttentionTray` header
   only, the chip change drops out.

Everything else is settled engineering detail.
