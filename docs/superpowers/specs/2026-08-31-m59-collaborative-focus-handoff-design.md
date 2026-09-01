# M59 — Collaborative Focus & Context Handoff

**Status:** design, approved. Not yet implemented. Not committed.
**Date:** 2026-08-31
**Milestone type:** integration. Wires M57 presence + M58 attention + M48 Follow
+ the canonical navigation primitive into one coherent "shared focus"
experience. **Frontend-only** — no new transport, no backend change, no new
store, no persistence, no Yjs/awareness writes.

---

## 1. Product intent

M57: *"Rahul is here."* M58: *"Rahul can get my attention around the exact code
he wants me to see."* M59:

> "I can step into Rahul's context, work alongside him, switch attention to
> Priya when necessary, and safely return to where I was — without losing my
> place or my work."

Concretely: from a collaborator's popover or an attention card I can Jump into
their context, optionally Follow them, receive another collaborator's attention
without corrupting the current Follow, and hit **Return to my location** to get
back to exactly where I was (file + cursor + selection + scroll) before I got
pulled in.

---

## 2. Existing architecture reused (verified against code, 2026-08-31)

### 2.1 M48 Follow (`frontend/src/components/IDE/IDE.tsx`, `FollowBanner.tsx`)

| Concern | Location | Behavior |
|---|---|---|
| Target | `followedUserId: number \| null` state | one target at a time |
| Derived | `followedUser = useMemo(() => collaborators.find(c => c.userId === followedUserId) ?? null, …)` | **keyed by `userId`, not `clientId`** — already correct |
| Track | `useEffect([followedUser, activeFile, openFiles, followedUserId])` | if `followedUser.activeFile !== activeFile`: `handleOpenFile(it)` unless the local active file is dirty → `setFollowPaused(true)`. If same file: `document.dispatchEvent("ide-reveal-location", {file, line, column})` to their cursor. |
| Clear-on-absent | same effect, `if (!followedUser) { setFollowedUserId(null); … }` | **immediate** — a transient `collaborators` blip drops Follow (M59 fixes this) |
| Enter | `handleFollowCollaborator(c)` | toggles; opens `c.activeFile` if not dirty |
| Stop | `handleStopFollowing()` | clears the three follow states |
| Auto-detach | `handleUserEdit()` (wired to `run`-events and passed to `Editor` as `onUserEdit`) | any local edit clears Follow |
| Banner | `FollowBanner.tsx` | Esc → `onStopFollowing`; shows followed user + file + line + pause reason + Stop |
| Jump | `handleJumpToCollaborator(c)` (M58-retrofitted) | `openAndRevealLocation(handleOpenFile, {filePath: c.activeFile, line: c.cursor?.line ?? 1, column: c.cursor?.column ?? 1})` |

Follow does **not** track the followed user's scroll (their awareness carries
none); it reveals-to-cursor. The M48 STATUS line "tracks … viewport scroll
locations" is aspirational — the code does not.

### 2.2 M58 attention (`frontend/src/collab/attention.ts`, `AttentionTray.tsx`, `Editor.tsx`)

- `AttentionStore` — point (6 s local TTL), callout (45 s, 90 s server ceiling),
  request (server-driven). `client.on("attention_change", …)` →
  `throttleLatest(setAttention, 200)` → `attention: AttentionEvent[]` in `IDE`.
- `AttentionTray` — incoming targeted-request cards `[Go there]` / `[Dismiss]`,
  "✓ Sent" author echo, "+N earlier" collapse, rate-limited banner.
- `handleAttentionNavigate(evt)` = `openAndRevealLocation(handleOpenFile,
  {filePath: evt.file, line: evt.range.startLine, column: evt.range.startColumn})`.
- **Gap M59 closes:** the incoming **callout bubble** (content widget) and
  **point decoration** in `Editor.tsx` have no click handler — only tray
  *requests* are actionable. M59 makes them click-to-navigate.
- Spatial three tiers (`Editor.tsx` `spatialCollaborators`): same-file strip →
  `.spatial-nearby` → `.spatial-overlap` + `[View X]` (→ `onViewCollaborator` →
  `handleJumpToCollaborator`). Unchanged by M59.

### 2.3 M57 presence

`CollaboratorPresence { clientId, userId, name, role, color, status, activity,
activeFile?, workingFolder?, cursor?, selection?, intent?, lastActive,
activeFileDirty? }` — the single `collaborators` array in `IDE.tsx`, fed
throttled. `CollaboratorAvatarStack` per-avatar quick popover
(`selectedCollaborator` block, `.collab-popover`) with `[Follow]` / `[Jump]` /
DND. **M59 extends this popover; TeamPanel is untouched.**

### 2.4 Navigation & editor lifecycle

- `frontend/src/utils/revealLocation.ts` — `openAndRevealLocation(openFile,
  target)`: `await openFile(target.filePath)` **then** dispatch
  `ide-reveal-location`. The open MUST precede the reveal.
- `Editor.tsx` `ide-reveal-location` listener (line ~700): `setActiveFile` if
  needed, then a `setTimeout(…, 50)` that `revealPositionInCenter` +
  `setPosition` + optional `setSelection` + `focus()`.
- `Editor.tsx` model-management effect: when `activeFile` changes it
  `createModel`/`getModel`, `setModel`, and (with collab) `bindMonacoModel`.
  **`handleOpenFile` returning does NOT mean the Monaco model is attached** —
  the model attaches in a subsequent effect run after `openFiles`/`activeFile`
  state settles.
- `Editor.tsx` already exposes `liveApiRef: { get, apply }` to `IDE` via a ref
  populated on mount / detached on unmount — the pattern M59 mirrors for view
  state.
- `getLiveContent` / model registry keyed by normalized path.

### 2.5 Lifecycle hooks in `IDE.tsx`

- Collab effect (`[project?.id, user]`): creates the client, subscribes
  `awareness_change` / `run_status_change` / `connection_change` /
  `external_mutation_notice` / `attention_change` / `attention_rate_limited`;
  teardown disposes the client, cancels throttles, `setCollaborators([])`,
  `setRunStatuses([])`, `setAttention([])`.
- `connection_change` → `setCollabStatus` (`"forbidden"` on 4403/4003).
- Project switch = the collab effect re-runs (new `project.id`).

---

## 3. M59 architecture

### 3.1 New files (both pure)

| File | Responsibility |
|---|---|
| `frontend/src/collab/focus.ts` | `deriveFocusState(...)`, `buildFocusContext(...)` — pure. Combines a `CollaboratorPresence`, the `AttentionEvent[]` list, and `followedUserId` into a `FocusContext` view object. No store, no side effects. |
| `frontend/src/collab/followAnchor.ts` | `FollowAnchor` type; `anchorFileExists(anchor, tree)`; `planAnchorRestore(anchor, openFiles)` → a small descriptor `{ needsOpen: boolean; filePath; viewState; cursor }`. Pure — the actual open/restore is orchestrated in `IDE.tsx`. |

### 3.2 Modified files

| File | Change |
|---|---|
| `frontend/src/components/IDE/IDE.tsx` | `followAnchorRef`; `followAbsenceTimerRef`; capture on Follow-enter (null-guarded); `handleReturnToMyLocation`; grace-window logic replacing the immediate clear; `[Follow]`/`[Go there]` orchestration for attention; `FocusContext` memo; `ide-restore-view-state` dispatch; anchor/timer cleanup in the collab-effect teardown and on `forbidden`. |
| `frontend/src/components/Editor/Editor.tsx` | `editorViewApiRef` (`{ save(): {activeFile, viewState, cursor} \| null; restore(filePath, viewState): boolean }`), populated on mount / detached on unmount (mirrors `liveApiRef`); an `ide-restore-view-state` listener that restores **only after the target model is the active model** (uses the existing model-management effect completion — a `restorePendingRef` consumed when `activeFile === filePath` and the model is attached); callout-bubble + point-decoration `onclick` → dispatch `ide-attention-activate {id}` (IDE maps id → event → `handleAttentionNavigate`); a small `[Follow]` on the callout bubble → `ide-attention-follow {id}`. |
| `frontend/src/components/Collab/FollowBanner.tsx` | `hasAnchor: boolean` + `onReturnToLocation: () => void` props; render `[Return to my location]` when `hasAnchor`; show the followed user's `range` when available (from a new `followedRange` prop derived in IDE). Esc still = Stop. |
| `frontend/src/components/Collab/AttentionTray.tsx` | request card gains `[Follow]` (→ `onFollow(e)`); prop `onFollow: (e: AttentionEvent) => void`. |
| `frontend/src/components/Collab/CollaboratorAvatarStack.tsx` | the `selectedCollaborator` popover renders the collaborator's `FocusContext` (file, range, latest callout message, `state` chip) + `[Jump]` + `[Follow]`/`[Unfollow]`; new props `focusContextFor?: (userId) => FocusContext \| null` (or the already-passed `collaborators`+`attention`+`followingUserId` are enough to compute inline via `focus.ts`). Popover otherwise unchanged. |
| `frontend/src/components/Toolbar/Toolbar.tsx` | thread `attention` (for the popover's focus context) + `onFollowCollaborator` already present. |
| `frontend/src/styles/collab.css` | `.follow-banner` return button, `.collab-popover` focus-context rows, `.focus-state-*` chips, callout `[Follow]` button. |
| `frontend/test/mocks/monaco.ts` | add `saveViewState()` / `restoreViewState(vs)` to `FakeEditorInstance` (return/accept an opaque token; record calls for assertions). |

### 3.3 What M59 does NOT add

No new `MESSAGE_CUSTOM` type, no awareness field, no second collaborator array,
no DB, no Yjs op, no polling, no per-second render, no multi-target follow. M58
`AttentionStore` TTLs and M57 availability/activity enums are untouched.

---

## 4. Focus / anchor state machine

### 4.1 `FocusContext` (pure, derived — `focus.ts`)

```ts
type FocusState = "idle" | "viewing" | "focused" | "following";

interface FocusContext {
  user: CollaboratorPresence;
  file: string | null;               // user.activeFile ?? latest attention.file by this user
  range: AttentionRange | null;      // latest callout/request range authored by this user (visible to me), else null
  activity: ActivityType;            // user.activity.type
  attention: AttentionEvent | null;  // most-recent live point/callout/request from this user (targeted at me OR broadcast)
  state: FocusState;
  isFollowing: boolean;
  timestamp: number;                 // max(user.lastActive, attention.createdAt ?? 0)
}

function deriveFocusState(
  user: CollaboratorPresence,
  attention: AttentionEvent | null,
  isFollowing: boolean,
): FocusState {
  if (isFollowing) return "following";
  if (attention) return "focused";
  if (
    (user.status === "online") &&
    (user.activity?.type === "viewing" ||
      user.activity?.type === "editing" ||
      user.activity?.type === "navigating")
  ) {
    return "viewing";
  }
  return "idle";
}
```

`buildFocusContext(user, allAttention, currentUserId, followedUserId)` picks the
newest `AttentionEvent` where `e.author.userId === user.userId` and
(`e.targetUserId === currentUserId` OR `e.targetUserId == null`). Pure; no
memoization inside — callers wrap in `useMemo`.

### 4.2 `FollowAnchor`

```ts
interface FollowAnchor {
  filePath: string;
  viewState: unknown;              // monaco.editor.ICodeEditorViewState — opaque, NEVER model content
  cursor: { line: number; column: number } | null;  // fallback if restoreViewState can't be applied
  capturedAt: number;
}
```

Held in `followAnchorRef: useRef<FollowAnchor | null>(null)` — a ref, not state
(read only on Stop/Return; no re-render on capture).

### 4.3 Transitions

```
                 ┌─────────── NOT FOLLOWING (anchor = null) ───────────┐
                 │                                                     │
   [Follow X] from popover / AttentionTray [Follow] / callout [Follow] │
                 │  capture anchor IFF followAnchorRef.current == null │
                 ▼                                                     │
        ┌──────────────── FOLLOWING X (anchor set) ───────────────┐    │
        │                                                         │    │
        │  X changes activeFile → openAndRevealLocation(...)       │    │
        │      (local file dirty → PAUSED, banner shows reason)    │    │
        │  X same file, cursor moves → ide-reveal-location         │    │
        │                                                         │    │
        │  [Follow Y] / [Go there Y] (Y != X)                      │    │
        │      → setFollowedUserId(null); navigate to Y;           │    │
        │        anchor PRESERVED (not recaptured);                │    │
        │        [Follow Y] → setFollowedUserId(Y) (anchor kept)   │    │
        │                                                         │    │
        │  local edit / manual nav / Esc / [Stop following]        │    │
        │      → setFollowedUserId(null); anchor DISCARDED         │    │
        │                                                         │    │
        │  [Return to my location]                                 │    │
        │      → setFollowedUserId(null); restore anchor; clear    │    │
        │                                                         │    │
        │  X absent from `collaborators`                           │    │
        │      → start followAbsenceTimer (~6s), stay FOLLOWING    │    │
        │        (banner may show "reconnecting…")                 │    │
        │      → X (same userId) returns < 6s → clear timer, resume│    │
        │      → 6s elapsed → setFollowedUserId(null);             │    │
        │        anchor PRESERVED; banner → "Rahul left —          │    │
        │        [Return to your location] [Stay here]";           │    │
        │        that mini-banner auto-dismisses after ~8s →       │    │
        │        anchor discarded (Stay)                           │    │
        │                                                         │    │
        │  project switch / disposal / forbidden / unmount         │    │
        │      → clear timer; setFollowedUserId(null);             │    │
        │        anchor DISCARDED                                  │    │
        └─────────────────────────────────────────────────────────┘
```

**Anchor is captured exactly once per collaboration session** — the null-guard
means Follow A → switch to Follow B keeps A's anchor. It is discarded on the
first Stop / Return / lifecycle reset, so the next Follow captures fresh.

### 4.4 Follow-absence grace (replaces the immediate clear)

`followAbsenceTimerRef: useRef<number | null>(null)`.

In the follow-tracking effect:
```ts
if (!followedUser) {
  if (followedUserId !== null && !followAbsenceTimerRef.current) {
    followAbsenceTimerRef.current = window.setTimeout(() => {
      followAbsenceTimerRef.current = null;
      // still absent?  (re-check via ref of the latest collaborators)
      if (!collaboratorsRef.current.some(c => c.userId === followedUserIdRef.current)) {
        setFollowedUserId(null);
        setFollowLeftNotice({ name: lastFollowedNameRef.current });  // "Rahul left" mini-banner
      }
    }, FOLLOW_ABSENCE_GRACE_MS); // 6000
  }
  return; // do NOT clear immediately
}
// followedUser present:
if (followAbsenceTimerRef.current) {
  clearTimeout(followAbsenceTimerRef.current);
  followAbsenceTimerRef.current = null;   // seamless resume
}
```
Cleared in: the effect's own cleanup, `handleStopFollowing`,
`handleReturnToMyLocation`, `handleFollowCollaborator` (when switching), the
collab-effect teardown, and on `forbidden`. **Keyed by `userId`** — a reconnect
with a new `clientId` but the same `userId` repopulates `collaborators` with a
matching `userId`, so `followedUser` resolves again and the timer is cleared.

### 4.5 `handleReturnToMyLocation` (exact sequence)

```ts
const handleReturnToMyLocation = useCallback(async () => {
  const anchor = followAnchorRef.current;
  clearFollowAbsenceTimer();
  setFollowedUserId(null);
  setFollowPaused(false);
  setFollowPauseReason("");
  setFollowLeftNotice(null);
  followAnchorRef.current = null;
  if (!anchor) return;

  // file gone?
  const exists = fileIndexRef.current?.some(f => f.path === anchor.filePath)
    ?? openFilesRef.current.some(f => f.path === anchor.filePath);
  if (!exists) {
    // try a lightweight existence check via the tree; else toast + bail
    if (!treeHasPath(treeRef.current, anchor.filePath)) {
      setReplaceReconcileNotice(
        `Your previous file "${anchor.filePath.split("/").pop()}" is no longer available.`,
      );
      return;   // stay where you are — never open an arbitrary file
    }
  }

  await handleOpenFile(anchor.filePath);   // opens the tab if closed; tab switch never clobbers a dirty buffer
  // Defer restore until Editor confirms the model for this file is active.
  document.dispatchEvent(new CustomEvent("ide-restore-view-state", {
    detail: { filePath: anchor.filePath, viewState: anchor.viewState, cursor: anchor.cursor },
  }));
}, [handleOpenFile]);
```

### 4.6 `Editor.tsx` view-state restore (model-safe)

- `editorViewApiRef.current = { save, restore }` set on mount:
  - `save()` → `{ activeFile: activeFileRef.current, viewState: monacoRef.current?.saveViewState() ?? null, cursor: <from getPosition> }` or `null` if no editor.
  - `restore(filePath, viewState)` → returns `true` only if `monacoRef.current` exists, the active model's normalized path === `filePath`, and `restoreViewState` succeeded; else `false`.
- `ide-restore-view-state` listener: stash `{ filePath, viewState, cursor }` in `restorePendingRef`. A `useEffect` keyed on `[activeFile, openFiles]` (the same signal the model-management effect uses) checks: if `restorePendingRef.current` and `activeFileRef.current === pending.filePath` and the model is attached (`monacoRef.current?.getModel()` normalized path matches) → call `restore(...)`; on failure or model mismatch → `revealPositionInCenter` to `pending.cursor` (fallback); then `monacoRef.current?.focus()`; clear `restorePendingRef`.
- **Never** call `restoreViewState` when the active model is a different file — the path guard prevents restoring into the wrong model.

---

## 5. Attention → focus integration (all explicit, never auto-follow)

| Entry point | `[Jump]` / `[Go there]` | `[Follow]` |
|---|---|---|
| Collaborator popover | `handleJumpToCollaborator(c)` (open-then-reveal) | `handleFollowCollaborator(c)` — captures anchor if none |
| AttentionTray request card | `handleAttentionNavigate(e)` + `handleAttentionDismiss(e.id, true)` | `handleAttentionNavigate(e)` + `handleFollowCollaborator(authorAsCollaborator(e))` + dismiss(acted) |
| Callout bubble (Editor) | `ide-attention-activate {id}` → IDE `handleAttentionNavigate(byId)` | `ide-attention-follow {id}` → navigate + `handleFollowCollaborator(author)` |
| Point decoration (Editor) | `ide-attention-activate {id}` → navigate | — (points are 6 s pings, no Follow) |

`authorAsCollaborator(e)` resolves `e.author.userId` against the live
`collaborators` array; if the author is no longer connected, `[Follow]` is a
no-op with a toast ("Rahul is no longer here"). Navigation still works (the
range is known).

**Rule enforcement (multi-collaborator):** every `[Follow X]` and every
`[Go there]`/`activate` for user X calls a single helper
`focusOn(userId, { follow: boolean })`:
```ts
function focusOn(userId, { follow }) {
  if (followedUserId !== null && followedUserId !== userId) {
    // acting on a DIFFERENT collaborator ends the current follow — anchor PRESERVED
    setFollowedUserId(null);
    setFollowPaused(false); setFollowPauseReason("");
    clearFollowAbsenceTimer();
  }
  // navigate (done by the caller via openAndRevealLocation)
  if (follow) {
    // capture anchor iff none, then set target
    if (followAnchorRef.current == null) captureAnchor();
    setFollowedUserId(userId);
  }
}
```
A second collaborator's attention merely *arriving* does not call `focusOn` —
only a user click does.

---

## 6. UX surfaces

### 6.1 Collaborator popover (extended)

```
● Rahul                    EDITOR
✏️ Editing · auth/session.ts · L47
📁 src/auth
📣 "I think the race is here."          ← latest callout, rendered as text
────────────────────────────
[Jump]   [Follow]                        ← [Unfollow] when isFollowing
```
`state` chip colour: `following` = accent, `focused` = warning-subtle,
`viewing` = muted, `idle` = faint. Popover open/close and outside-click
unchanged.

### 6.2 FollowBanner (extended)

```
👀 Following Rahul
auth/session.ts · Lines 40–52
Esc to stop        [Stop following]   [Return to my location]
```
- `[Return to my location]` rendered only when `hasAnchor`.
- Paused state unchanged ("Follow paused — you have unsaved changes").
- "Rahul left" mini-state (post-grace): `⚠ Rahul left — [Return to your location] [Stay here]`, auto-dismiss ~8 s → Stay (anchor discarded).

### 6.3 AttentionTray request card (extended)

```
📣 Rahul wants your attention
auth/session.ts · L40–52
"I think the race is here."
[Go there]   [Follow]   [Dismiss]
```

### 6.4 Editor

- Callout bubble: adds a `[Follow]` mini-button next to the `×`; the whole
  bubble (except buttons) is click-to-navigate.
- Point label: click-to-navigate.
- Spatial tiers unchanged.
- No Yjs mutation from any of this.

---

## 7. Lifecycle matrix

| Event | Follow | Anchor | Absence timer |
|---|---|---|---|
| Enter Follow (first of session) | set | **captured** | — |
| Switch Follow A→B (explicit) | B | **preserved** | cleared |
| Target changes file | tracks via `openAndRevealLocation` | unchanged | — |
| Local file dirty + target navigates | **paused** (not cleared) | unchanged | — |
| Local edit / manual nav / Esc / Stop | cleared | **discarded** | cleared |
| Return to my location | cleared | restored then **discarded** | cleared |
| Target absent (blip) | **kept** | kept | **started (~6 s)** |
| Same `userId` returns < 6 s | kept (resumes) | kept | **cleared** |
| Absent > 6 s | cleared + "left" banner | **preserved** (until Stay/timeout) | cleared |
| Reconnect after grace | **no auto-refollow** | n/a | n/a |
| Project switch | cleared | discarded | cleared |
| `forbidden` (4403/4003) | cleared | discarded | cleared |
| Explicit-disposal reset (1001 while connected) | cleared | discarded | cleared |
| Component unmount / collab-effect teardown | cleared | discarded | cleared |
| Attention event expires while following | **unchanged** (Follow tracks presence) | unchanged | — |

---

## 8. Security / trust

M59 adds no channel and no new data. It only *reads* `collaborators`
(server-authoritative M57 identity, delivered only inside an authorized room),
`attention` (M58, already server-validated + targeted), and `followedUserId`
(local). Therefore:

- **Follow target** is always a `CollaboratorPresence` from the live
  `collaborators` array → only ever a collaborator authorized in the current
  project's room. A crafted `userId` that is not in `collaborators` yields
  `followedUser === null` → no follow.
- **Attention navigation** goes through `openAndRevealLocation` →
  `handleOpenFile` → the existing `/api/projects/:id/file` route, which enforces
  project ownership/collaborator access and path traversal. M59 opens no path
  the user could not already open.
- **Cross-project isolation** — the collab effect resets `collaborators`,
  `attention`, `followedUserId`, `followAnchorRef`, and the absence timer on
  every `project.id` change. A test asserts none survive a switch.
- **`clientId` is never the reconnect identity** — Follow, the absence timer,
  and `focusOn` all key on `userId`. A reconnect with a new `clientId` + same
  `userId` resumes; a different `userId` never auto-follows.
- **Anchor** holds a file path + an opaque Monaco view-state token + a cursor —
  no document content, no secrets. Restore re-fetches the file through the same
  authorized route. If the path is gone, we toast and stay — never open an
  arbitrary file.

---

## 9. Performance

- No new transport, no DB, no Yjs write, no awareness write, no polling.
- **One** `followedUserId`, **one** `followAnchorRef`, **one**
  `followAbsenceTimerRef`. Every timer cleared on every exit path.
- `FocusContext` is a pure function wrapped in `useMemo` by each consumer
  (popover, banner, tray card) — recomputed only when `collaborators` /
  `attention` / `followedUserId` change, which are already throttled (200 ms).
- No global per-second render. The "Rahul left" mini-banner uses a single
  `setTimeout`, not an interval.
- Attention rendering stays M58-bounded (decoration diff by id, per-event
  timers ≤ 90 s).

---

## 10. Testing strategy

Behavioral, deterministic. Fake timers for the 6 s grace and the 8 s "left"
auto-dismiss. Deterministic Monaco mock for `saveViewState`/`restoreViewState`
and model-active signalling — no sleeps.

### 10.1 Pure (`frontend/test/collab.focus.test.ts`)

`deriveFocusState` (following > focused > viewing > idle, each branch);
`buildFocusContext` (newest attention by that author, targeted-or-broadcast
filter, file/range/timestamp assembly); `followAnchor` helpers
(`treeHasPath`-style existence, `planAnchorRestore` needsOpen logic).

### 10.2 Monaco mock additions + a focused restore test

`test/mocks/monaco.ts`: `saveViewState()` returns a tagged token
`{ __vs: true, id }`; `restoreViewState(vs)` records the last restored token and
the model it was applied to; `_setActiveModelPath(p)` test helper.
Test: save on file A → `setActiveFile(B)` → restore dispatched for A →
**assert `restoreViewState` is NOT called while B is active** → `setActiveFile(A)`
+ model attached → assert `restoreViewState` called once with A's token.

### 10.3 IDE-level behavioral (`frontend/test/collab.focus.follow.test.tsx`)

The 37 numbered cases from the brief, grouped:

**Anchor (1–10):** capture once on Follow-enter; correct file + view-state
token; not recaptured on A→B switch; Stop discards; Return restores; Return with
deleted file → toast + no throw + no arbitrary file; Return never triggers a
`setValue`/content write; Return clears Follow; project switch clears anchor;
disposal/teardown clears anchor.

**Follow (11–16):** follow a collaborator; target file change → open-then-reveal;
closed-file follow → `openFile` strictly before `ide-reveal-location`; local
dirty file → pause not clear; Stop; Esc.

**Attention (17–24):** `[Go there]` while not following (no anchor);
`[Go there]` while following Rahul → Rahul follow ends, anchor preserved;
`[Follow Priya]` while following Rahul → Rahul ends, Priya followed, anchor
preserved (== original); callout click navigates; point click navigates;
closed-file attention nav opens before reveal; attention expiry while following
→ Follow unchanged.

**Multi-collaborator (25–27):** Priya's request arriving while following Rahul →
`followedUserId` unchanged until a click; acting on Priya deterministically
switches; only one `followedUserId` ever non-null.

**Lifecycle (28–34):** brief absence → Follow not immediately cleared (fake
timer < 6 s); same `userId` new `clientId` within grace → resumes (timer
cleared); absent > 6 s → Follow ends + "left" banner + anchor preserved;
reconnect after grace → no auto-refollow; project switch clears Follow; 4403 →
clears Follow; **no timer fires after unmount** (spy on the timeout callback,
unmount, advance timers, assert not called).

**Security (35–37):** a `followedUserId` not in `collaborators` → no follow;
attention nav uses `handleOpenFile` (authorized route) — source/spy check;
project switch clears `collaborators`+`attention`+`followedUserId`+anchor
(no leak).

### 10.4 Regression

Existing `collab.follow.test.tsx` (7), `collab.awareness.test.ts`, all M58
suites, all M57 suites — **green, unchanged** (except any assertion that
literally depended on the immediate-clear-on-absent behavior, which becomes the
grace behavior — noted in the commit description). Full frontend + full backend
suites.

---

## 11. Browser acceptance (Docker available; visual matters this time)

Two authenticated Chrome sessions via `claude-in-chrome` when the extension is
connected — attempt the real UI walkthrough (25 steps from the brief: appear →
click → Jump → Follow → banner → target file switch → editor follows → point/
callout → navigate → Priya request while following → `[Go there]` ends Rahul →
`[Follow Priya]` → anchor survives → Return works → deleted anchor degrades →
dirty never clobbered → brief disconnect survives grace → stays away → Follow
ends → Return still offered → reconnect → no stale follow → concurrent Yjs OK).

If the extension is not usable for two authenticated sessions, fall back to the
strongest integration verification (the IDE-level behavioral suite + a live
two-client transport script proving presence/attention still flow), and report
**browser visual = NOT_PROVEN** — never label a headless script as visual.

---

## 12. Non-goals (M59)

Change attribution (→ M60), collaboration history, while-you-were-away, activity
feed, persistent comments / threads / chat / reactions / mentions, semantic
conflict resolution, multi-target follow, team analytics, raw terminal / stdout
/ stderr sharing, AI collaboration. No new `MESSAGE_CUSTOM` type, no awareness
field, no second collaborator store, no DB, no Yjs op.

---

## 13. M60+ roadmap (unchanged, restated)

- **M60** — change attribution (`doc.on("update", origin=ws)` already attributes
  a transaction to a connection), collaboration history, while-you-were-away,
  meaningful activity feed.
- **M61** — persistent comments / threads / mentions / reactions (a callout
  could gain a "keep" action promoting it to a DB-backed comment).
- **M62** — deep same-region conflict-awareness UX on the M58 three-tier
  spatial model.
- **M63+** — team intelligence, people ↔ code graph, analytics, AI-assisted
  collaboration.

---

## 14. Risks / tradeoffs

| Risk | Likelihood | Mitigation |
|---|---|---|
| `restoreViewState` applied to the wrong model | Low | strict active-model path guard in `Editor.restore`; deferred until `activeFile === filePath` + model attached; cursor fallback; dedicated mock test |
| Grace window lets Follow "resume" onto an impostor | Very low | keyed by `userId`; identity is server-authoritative (M55); a different `userId` never matches |
| Anchor points at a since-deleted file | Medium | existence check before open; toast + stay; never open an arbitrary file |
| A→B switch loses the true origin | — (by design) | null-guarded single capture per session; documented; test 20 pins it |
| Timer leak after unmount | Low | cleared in effect cleanup + every handler + teardown; test 34 asserts no fire after unmount |
| Popover becomes a mini-TeamPanel | Low (scope) | popover shows one collaborator's `FocusContext` + 2 buttons; TeamPanel untouched; non-goals explicit |
| Callout/point click conflicts with the `×` / `[Follow]` buttons | Low | buttons `stopPropagation`; bubble click handler ignores events from `button` descendants |
| Existing `collab.follow.test.tsx` assertion on immediate clear | Certain | one assertion updated to the grace behavior; behavior is strictly more robust; noted |
| Landing on the mixed M57+M58 staged index | Certain | M59 adds new files + additive props; the M59 diff is separable by filename/prefix; do not revert M57/M58 |

---

## 15. Open decisions requiring reviewer approval

None. All 14 final decisions from the approval message are incorporated:
one target; act-to-end-follow; anchor preserved on A→B; capture-once-on-enter;
one-shot `[Go there]` = no anchor; Stop discards; Return restores; ~6 s grace
keyed by `userId`; same-userId/new-clientId within grace resumes; no
auto-refollow after grace; project/session/disposal/unsafe clears both; dirty
protection preserved; M58 attention lifecycle preserved; M57 presence semantics
preserved.
