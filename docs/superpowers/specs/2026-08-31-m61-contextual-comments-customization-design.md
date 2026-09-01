# M61 — Contextual Collaboration + Deep User Customization

**Status:** design, self-reviewed. Not yet implemented. Not committed.
**Date:** 2026-08-31
**Milestone type:** three connected product systems on top of the M57–M60
collaboration stack — (A) persistent code-anchored discussion, (B) a real
user-preference/customization platform, (C) a server-authoritative user
profile / identity layer. Rides existing transport (`MESSAGE_CUSTOM` +
`/api/…` REST + SQLite migrations). No new WebSocket endpoint, no new
document-sync mechanism, no second collaborator store, no second design
system.

Predecessors: `2026-08-29-m57-multiplayer-presence-design.md`,
`2026-08-30-m58-live-attention-callouts-design.md`,
`2026-08-31-m59-collaborative-focus-handoff-design.md`,
`2026-08-31-m60-change-attribution-history-design.md`.

---

## 1. Product intent

| Milestone | Question it answers |
|---|---|
| M57 | Who is here? |
| M58 | Get someone's attention. |
| M59 | Enter / follow someone's context. |
| M60 | Understand what happened. |
| **M61** | **Discuss the code in context, make the IDE personally mine, and be a real person in the room.** |

North star: CloudIDE should feel like a group of engineers sitting beside
each other at highly personalized laptops — talking about exact code,
seeing each other's activity, shaping the environment to their own
preferences, and showing up with a real identity.

Three tracks, each first-class:

```
M61
├── TRACK A — Contextual Collaboration
│   comments · threads · replies · mentions · reactions · resolve/reopen
│   · resilient Yjs-aware anchors · comment navigation · M60 history integration
│
├── TRACK B — IDE Customization
│   setting registry · theme/token layer · layout · editor · collaboration
│   presentation · notifications · keyboard · accessibility · search
│   · reset/export/import · versioned preference schema
│
└── TRACK C — User Profile / Identity
    identity fields · avatar · banner · profile accent · custom status
    (+ expiry) · badges (user + server) · featured projects · developer links
    · privacy flags · live profile preview · ONE identity model everywhere
```

Delivered as **four independently-gated workstreams** (see §14): **M61-A**
Contextual Comments → gate → **M61-B** IDE Customization → gate → **M61-C**
Profile Identity → gate → **M61-D** cross-system integration + regression +
browser verification. B depends only on A's migration; C depends on A's
migration + the `profile_event` transport method; D depends on all three
gates. A ships with a local initials-fallback for comment-author avatars so
it never blocks on C; D swaps in the shared `<CollaboratorAvatar>`. Each
workstream is stoppable at its gate with a green, shippable subsystem.

Non-negotiable philosophy (applies to all three tracks):

1. Everything has a sensible default.
2. Every setting / customization actually changes something real.
3. Every customization is reversible; every category can be reset.
4. Search finds real registered settings, never DOM text.
5. Live preview is immediate — no edit→save→reload→discover.
6. No arbitrary code / CSS / HTML / SVG injection anywhere.
7. Preferences and profile data are **versioned**.
8. The *profile* model (what others see) and the *preference* model (how I
   experience the IDE) are **separate**.
9. Customization never weakens security or authorization.
10. Customization never breaks default usability; accessibility overrides
    decorative customization.

---

## 2. The coherent layer model (the invariant M61 must not blur)

M57–M60 established four layers. M61 adds to three of them and never
crosses the boundaries:

```
SERVER-AUTHORITATIVE  → SQLite + REST        (identity, authz, comments,
   (persistent)                                mentions, reactions, resolution,
                                               persistent anchors, badges,
                                               server-backed preferences,
                                               profile fields)
CLIENT-DERIVED        → React + CSS tokens   (theme, accent, density, motion,
   (presentation)        + localStorage        layout sizes, local editor prefs,
                                               collaboration presentation
                                               toggles, anchor RESOLUTION,
                                               profile-card rendering, live
                                               preview)
EPHEMERAL REALTIME    → MESSAGE_CUSTOM       (M57 presence, M58 attention,
   (transient)                                 M59 focus — unchanged;
                                               + receive-only comment_event /
                                               comment_mention / profile_event
                                               pings)
HISTORICAL            → M60 timeline.ts      (comment lifecycle events as a
   (derived, append)                           5th union source)
```

| Concept | Owner | M61 stance |
|---|---|---|
| Document CRDT convergence | Yjs | untouched; regression-guarded |
| Identity / role / authorization | server (`requireProjectAccess`, session) | untouched; the profile layer *reads* it, never overrides it |
| Spatial / attention / focus | M57–M59 ephemeral | consumed read-only by profile activity surfaces |
| Change history | M60 `collaboration_changes` + `timeline.ts` | comments add a source; nothing else changes |
| Persistent discussion | **M61 Track A** | new tables + REST |
| How I experience the IDE | **M61 Track B** | registry + tokens + versioned prefs |
| How others see me | **M61 Track C** | profile tables + REST + a single awareness-fed identity primitive |

**Explicit separations that must remain coherent:**

- A **preference** (Track B) is never persisted anywhere a preference could
  change authorization, and never carries a secret.
- A **profile privacy flag** (Track C) hides *presentation* fields only —
  location, links, recent history, current-file activity. It can **never**
  hide identity, role, or authorization from an authorized collaborator,
  and the collaboration system keeps enforcing project access regardless.
- A **comment** (Track A) is a persistent DB object. An **M58 callout** is
  ephemeral. "Keep as comment" *creates a new* comment; the callout keeps
  its ephemeral lifecycle and is never mutated into a DB row.
- **Custom status** (Track C, human-authored, persistent, expiring) is
  distinct from **observed activity** (M57 presence, derived). Both are
  shown; they are never merged.

---

## 3. Existing architecture (verified against code, 2026-08-31)

### 3.1 Transport & rooms

- `backend/src/collab/manager.ts` — `MESSAGE_CUSTOM` (type 3). Server →
  clients broadcast helpers `broadcastRunStatus` (M54) and
  `broadcastCollabChange` (M60) are the working "server holds authoritative
  state, fans out a receive-only JSON frame, client never authors it"
  pattern. `CollaborationManager.broadcastCollabChange(projectId, ev)`
  delegates to the room. Client (`frontend/src/collab/client.ts`
  `case MESSAGE_CUSTOM`, ~line 728) shape-guards each frame type and
  `emit()`s; it authors only `file_open` + the M58 attention frames.
- `/ws/collab?projectId=` (`backend/src/ws/index.ts` ~line 334): cookie
  session → `requireProjectAccess(db, row.id, projectId, "viewer")` →
  `room.addClient(ws, { userId, username, role })`. Server sets identity;
  client never supplies it.
- REST: all project routes under `/api/projects/:id/…`, every handler
  opens with `requireProjectAccess(db, userOf(req).id, req.params.id,
  minRole)` (`"viewer" | "editor" | "owner"`; owner + platform admin
  resolve to `"owner"`). Error middleware → JSON `{error:{code,message}}`.
  Body limit 1 MiB; `api()` client wrapper carries `credentials:"include"`.

### 3.2 Yjs document model — the anchoring substrate

- One `Y.Text` **per workspace-relative file path**:
  `room.doc.getText(filePath)` server-side; `client.doc.getText(filePath)`
  client-side (exposed — `IDE.tsx:1469` reads
  `collabClientRef.current.doc.getText(path).toString()`), bound to the
  Monaco model via `y-monaco` `MonacoBinding` (`client.ts` ~line 1001).
- The server never runs Monaco or resolves positions; it seeds the
  `Y.Text` from disk on `file_open` (`ensureFileLoaded`, `manager.ts`
  ~1174) and sends `file_ready`. The client owns all position math.
- `transaction.origin` attributes an edit to a `WebSocket` (M60). String
  origins (`"initial_disk_load"`, `"external_mutation"`) are non-user.
- **Consequence for anchoring:** `Y.RelativePosition` (encode server-side
  as an opaque blob, resolve client-side against the live doc) is the only
  mechanism that survives edits, is lineage-independent across reconnects,
  and needs zero server-side Yjs. Confirmed available: `yjs` is a direct
  dependency of both packages; `Y.createRelativePositionFromTypeIndex`,
  `Y.encodeRelativePosition`, `Y.decodeRelativePosition`,
  `Y.createAbsolutePositionFromRelativePosition` are the API.

### 3.3 Presence / identity (M55–M57)

- `backend/src/collab/presence.ts` `buildAuthoritativeAwarenessState`:
  identity is **forced** to `{ id, name, role }` from the authenticated
  session; only a syntactically-valid `user.color` passes through from the
  client. Bounded ephemeral allowlist: `status` (enum
  `online|idle|away|dnd`), `activity` (enum + bounded `detail`),
  `activeFile`/`workingFolder` (`sanitizeAwarenessFilePath`: ≤512, no
  absolute/drive/`..`/C0), `cursor`/`selection` (`isAwarenessCoord`:
  finite 0…5e6), `intent` (`sanitizeIntentText`: ≤120), `lastActive`,
  `activeFileDirty`. Unknown top-level fields dropped.
- `frontend/src/collab/presence.ts` — `CollaboratorPresence` shape,
  `readPresenceState`, `getUserColor(userId)` (8-color Catppuccin palette,
  `USER_COLORS[|userId| % 8]`), selectors. **The single collaborator
  store.** `IDE.tsx` holds one `collaborators: CollaboratorPresence[]` fed
  by `client.on("awareness_change", throttleLatest(setCollaborators,
  200))`.
- Avatars today: **initials + `c.color`**, hand-rolled inline in
  `CollaboratorAvatarStack.tsx` (24 px button, 32 px popover ×1), the M58
  attention decorations, TeamPanel dots. **No `<Avatar>` primitive.**
- `listProjectCollaborators(db, projectId)` → `{userId, username, role,
  createdAt}[]`; `GET /api/projects/:id/collaborators` (viewer).
  `ProjectSharingModal.tsx` is the membership UI.

### 3.4 M58 attention (reused patterns)

- `backend/src/collab/attention.ts` — pure: `sanitizeAttentionMessage`
  (C0/DEL→space, collapse ws, trim, cap), `RateLimiter` (sliding window),
  `AttentionRequestRegistry` (bounded Map + per-entry TTL), opaque
  `crypto` IDs, `normalizeRange`/`rangesOverlap`.
- `AttentionTray.tsx` — bottom-right non-modal stacked cards; the only
  notification surface in the app (no toast system). `role="status"`.
- `frontend/src/utils/revealLocation.ts` `openAndRevealLocation(openFile,
  target)` — **await open, then dispatch `ide-reveal-location`.** The
  canonical open-then-reveal primitive. `Editor.tsx` listens (~line 874).
- `Editor.tsx` decoration patterns: `editor.createDecorationsCollection()`
  keyed by id, `glyphMarginClassName`, `editor.addContentWidget()` (bubble
  positioned above a line, text via `textContent` — never `innerHTML`),
  `editor.addAction()`, `onDidChangeCursorSelection`. M58's
  point/callout code is the template for comment gutter markers + hover
  widgets + thread popover.

### 3.5 M60 history

- `backend/src/collab/timeline.ts` `queryTimeline` — unions
  `collaboration_changes` + `runs` + `audit_logs` (`GIT_COMMIT`,
  `SNAPSHOT_*`) with **explicit safe column lists**, `(at,id)` total-order
  cursor pushed into every source query, page clamp `[1,100]`.
  `queryWhileAway` filters to `MEANINGFUL_KINDS` and excludes the caller.
- `backend/src/collab/historian.ts` `CollaborationHistorian` — singleton,
  bounded in-memory queue → one batched `BEGIN…COMMIT` on interval / at
  ≥100 rows / on `stop()`; `setBroadcaster` wired in `app.ts`;
  `disposeProject` at project-delete + workspace-restore.
- `TimelineEvent` / `CollabChangeWire` hand-synced across packages
  (`frontend/src/types.ts` §M60).

### 3.6 Preferences & customization (current state — the Track B baseline)

- `backend/src/auth/preferences.ts` — **the only** preference store:
  `user_preferences` table (`user_id` PK, 7 editor keys: `font_size`,
  `tab_size`, `word_wrap`, `minimap`, `line_numbers`, `cursor_blinking`,
  `render_whitespace`, `updated_at`). Strict per-key validation
  (`ALLOWED_KEYS`, enum sets, `fontSize` 8–32), `ON CONFLICT DO UPDATE`
  merge. `GET/PUT /api/auth/preferences` (`requireAuth`).
  `USER_PREFERENCES_UPDATED` audit event.
- `frontend/src/components/Settings/SettingsModal.tsx` — a single 520 px
  form, 7 controls, hand-styled inline, `onSave(Partial<UserPreferences>)`
  → `PUT /api/auth/preferences`. `DEFAULT_PREFERENCES` duplicated
  frontend + backend. `IDE.tsx` loads once, threads `preferences` into
  `Editor.tsx` which calls `monaco.updateOptions` on change (no remount).
  Opened from Toolbar; **no `Ctrl+,`**, not in the command palette.
- `frontend/src/styles/tokens.css` — **already a semantic token layer**:
  `--bg-{deep,base,surface,surface-elevated,surface-hover}`, glass
  materials, `--accent{,-hover,-subtle,-glow,-gradient}`,
  `--secondary/--success/--warning/--error`, `--fg-{primary,secondary,
  muted,subtle,inverse}`, `--shadow-{xs..lg,glass,glow}`,
  `--radius-{xs..xl,pill}`, `--space-{1..8}`, `--font-{sans,mono}`,
  `--text-{xs..2xl}`, `--spring-*`, `--duration-{fast,normal,slow}`. Has
  `@media (prefers-reduced-motion: reduce)` and
  `@media (prefers-reduced-transparency: reduce)` blocks already.
  **Single `:root`, no theme switching, no `data-theme`.**
- `frontend/src/styles/glass.css` — primitive layer: `glass-btn`
  (`-primary`/`-danger`/`-ghost`/`-icon`), `glass-input`, `glass-panel`,
  `glass-floating`, `glass-modal-backdrop`, `liquid-card`.
- `frontend/src/components/common/Modal.tsx` — `PromptModal` / `ConfirmModal`,
  `createPortal(…, document.body)` (escapes `backdrop-filter` containing
  blocks), Esc-to-close.
- `frontend/src/utils/commands.ts` `CommandRegistry` — singleton,
  `register`/`registerMany` → unsubscribe, `search(query)` via
  `fuzzyFilter`, `Command { id, title, description, category, shortcut?,
  macShortcut?, available?, handler }`. **Shortcut strings are display-only.**
- `frontend/src/hooks/useKeyboardShortcuts.ts` — **hard-coded** chords:
  `Cmd/Ctrl+Shift+P`, `Cmd/Ctrl+P`, `Cmd/Ctrl+S`, `Cmd/Ctrl+B`,
  `Cmd/Ctrl+J`. A `ShortcutHandlers` callback bag. No registry, no
  rebinding, no conflict detection.
- `localStorage` keys in use: `cloudeee_format_on_save`,
  `cloudeee_demo_tour_seen`, `cloudeee_recent_files_<pid>`,
  `cloudeee_recent_projects`, `cloudeee_session_<pid>` +
  `cloudeee_last_project` (`utils/sessionStore.ts`, `utils/recentStore.ts`).
  Scattered, untyped, no namespace discipline.

### 3.7 Identity / profile infrastructure (Track C baseline)

- **None.** `users` = `id INTEGER PK, username TEXT UNIQUE, password_hash,
  role TEXT DEFAULT 'user', created_at`. No display name, avatar, bio,
  pronouns, status, links, badges.
- **No avatar/image upload.** The only image-adjacent code:
  `backend/src/files/upload.ts` `parseMultipartFormData(bodyBuffer,
  contentType)` — a zero-dependency multipart parser (returns
  `{fields, files:[{path,buffer}]}`), used by `rawZipParser` /
  `uploadParser`. Storage convention: `cfg.dataDir` with typed subdirs
  (`workspaces/`, `snapshots/`, `backups/`, `workspace-backups/`,
  `tmp_*_<uuid>` staging). No `express.static` except `cfg.frontendDist`.
- `GET /api/auth/me` → `{ user: { id, username, role, isDemo } }`.
- `AuditEventType` union in `backend/src/audit.ts` (extendable);
  `recordAuditLog(db, {userId, projectId?, eventType, details, ipAddress})`
  with `sanitizeDetails` (redacts password/token/secret keys).
- `role` badges available server-side: project `owner` / `editor` /
  `viewer` (`project_collaborators`), platform `admin` (`users.role`).
- Migrations: `backend/src/db.ts` — ordered `MIGRATIONS[]`, `schema_migrations`
  table, one transaction per migration, **currently v11**.
  `backend/test/migrations.test.ts` hard-asserts `.toBe(11)` and the
  `[1..11]` version list in **3 places**.

### 3.8 Reusable UI primitives inventory (do not re-invent)

`glass-btn*`, `glass-input`, `glass-panel`, `glass-floating`,
`liquid-card`, `Modal.tsx` portal modals, `common/Icons.tsx` icon set,
`common/Tour.tsx`, `CommandPaletteModal.tsx`, `fuzzySearch.ts`,
`throttleLatest.ts`, `revealLocation.ts`, `CommandRegistry`,
`AttentionTray` card stack, the token layer. **No segmented control, no
switch, no slider, no color picker, no tabs, no toast — Track B adds these
as shared primitives once (`components/common/controls/`), consumed by
Settings, the profile editor, and retrofitted opportunistically.**

---

## 4. TRACK A — Contextual Collaboration (persistent comments)

### 4.1 Core interaction

```
select code  →  Comment  →  persistent anchored discussion
```

A comment is attached to code context (file + Yjs anchor), server-persisted,
threaded one level, resolvable, mentionable, reactable. **Not chat.**

### 4.2 Anchoring — the architectural decision

**`Y.RelativePosition` pair (start + end), server-persisted as opaque
blobs, client-resolved, with a validated line-range fallback and a content
fingerprint for stale-detection and recovery.**

| Phase | Where | What |
|---|---|---|
| **Create** | client | From the current selection: `Y.createRelativePositionFromTypeIndex(yText, startOffset)` and `…(yText, endOffset)` → `Y.encodeRelativePosition` → `base64`. Also capture `startLine`, `endLine` (1-based, current) and `prefixHash` = SHA-256 (first 16 hex) of the anchored slice, whitespace-collapsed, ≤256 chars. POST all five to the server. |
| **Store** | server | `anchor_rel_start`/`anchor_rel_end` (BLOB, opaque — server never decodes), `anchor_start_line`/`anchor_end_line` (INT, advisory fallback), `anchor_prefix_hash` (TEXT, drift detection) + `anchor_prefix` (TEXT, the ≤256-char slice text for fuzzy recovery). |
| **Resolve** | client, on render | `Y.decodeRelativePosition(blob)` → `Y.createAbsolutePositionFromRelativePosition(rel, doc)` for both ends. |
| **Classify** | client | see table below |

| Both ends resolve? | Fingerprint of resolved slice | Anchor state | UI |
|---|---|---|---|
| yes | matches | **exact** | gutter marker at the resolved range, precise |
| yes | drifted | **anchored (drifted)** | marker at resolved range, no warning (normal editing churn) |
| either → `null` | — | **stale** | thread panel only: `⚠ Original code location changed` + `[Find nearby context]` + `[Open file]`. **Never rendered on unrelated code.** |

- `[Find nearby context]` — fuzzy-match the stored ≤256-char slice against
  the current doc text (token-similarity ≥ 0.8) → if a hit, offer a jump to
  that line; the anchor is **not** silently rewritten.
- Survives (verified by the test matrix in §9): insertion above, deletion
  around, nearby edit, concurrent collaborator edit, save/reload, reconnect
  (RelativePosition carries its own item ID, lineage-independent). File
  replaced wholesale (Git checkout, snapshot restore, Replace-All) →
  typically `null` → stale → fingerprint recovery offered.
- The client reports the observed state back via
  `POST …/comments/:threadId/anchor-status {status}` (advisory; the server
  stores it only so a *different* client / the timeline can show "stale"
  without re-resolving. Never load-bearing for authorization or delivery).
- **Rejected alternatives:** raw line numbers alone (don't survive edits —
  the explicit anti-pattern in the prompt); server-side Yjs resolution
  (server has no doc, would need to load every file into a `Y.Doc`);
  Monaco `deltaDecorations` sticky ranges (per-session only, lost on
  reload/close).

### 4.3 Persistent data model — migration v12

Normalized. Three core tables + mentions + reactions. All `TEXT` primary
keys are `randomUUID()`. All FKs `ON DELETE CASCADE`.

```sql
CREATE TABLE comment_threads (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_path         TEXT NOT NULL,                    -- workspace-relative, sanitized
  anchor_rel_start  BLOB,                             -- encoded Y.RelativePosition (opaque)
  anchor_rel_end    BLOB,
  anchor_start_line INTEGER NOT NULL,                 -- advisory fallback (1-based)
  anchor_end_line   INTEGER NOT NULL,
  anchor_prefix_hash TEXT NOT NULL,                   -- SHA-256[:16] of anchored slice (drift detection)
  anchor_prefix     TEXT NOT NULL,                    -- the <=256-char slice text itself (fuzzy recovery)
  anchor_status     TEXT NOT NULL DEFAULT 'ok',       -- 'ok' | 'stale' (last client report)
  created_by        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),  -- bumped on any thread activity
  resolved_at       TEXT,
  resolved_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  root_comment_id   TEXT NOT NULL                     -- denormalized for list rendering
);
CREATE INDEX idx_comment_threads_project_file
  ON comment_threads(project_id, file_path, resolved_at);
CREATE INDEX idx_comment_threads_project_updated
  ON comment_threads(project_id, updated_at DESC, id DESC);

CREATE TABLE comments (
  id                TEXT PRIMARY KEY,
  thread_id         TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,  -- denorm, scoping
  parent_comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,           -- NULL = root
  author_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body              TEXT NOT NULL,                    -- sanitized, <= COMMENT_MAX_LEN
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at         TEXT,
  deleted_at        TEXT                              -- tombstone; body blanked to '' on delete
);
CREATE INDEX idx_comments_thread ON comments(thread_id, created_at, id);

CREATE TABLE comment_mentions (
  comment_id        TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  mentioned_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (comment_id, mentioned_user_id)
);

CREATE TABLE comment_reactions (
  comment_id        TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji             TEXT NOT NULL,                    -- one of the fixed set (§4.7)
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (comment_id, user_id, emoji)
);
```

Design notes:

- **Thread = root comment + anchor + resolution state.** The root comment
  is a `comments` row with `parent_comment_id IS NULL`; its `id` is
  `comment_threads.root_comment_id`.
- **Replies** are `comments` rows with `parent_comment_id = root_comment_id`.
  **Exactly one level:** a "reply to a reply" attaches to the root
  (`parent_comment_id` is forced to the root on the server). Rendered as a
  flat ordered list under the root.
- **Delete = tombstone** (approved). `deleted_at` set, `body` → `''`,
  mentions/reactions rows for that comment deleted, replies **survive**
  (rendered under a "comment deleted" placeholder). A thread whose root is
  tombstoned still renders its replies; resolving/reopening still works.
- `updated_at` on the thread is the M60 timeline sort key and the
  "unresolved, recently active" ordering key.
- Project delete / workspace restore: `comment_threads.project_id` cascade
  handles it; add `disposeProjectComments(projectId)` no-op hook at the two
  existing `disposeProject` call sites for symmetry / future in-memory
  state (there is none in v1, but the seam matches M60).

### 4.4 REST API

Base `/api/projects/:id/comments`. Every handler: `requireProjectAccess(db,
userOf(req).id, req.params.id, minRole)`. Author/actor identity is
**always** `userOf(req)` — never a body field. All timestamps server-set.

| Method + path | Min role | Body / notes |
|---|---|---|
| `GET  /comments?file=<path>&status=active\|resolved\|all&limit=&before=` | viewer | threads for a file (or `file` omitted → project-wide unresolved roll-up, capped). Returns `{threads:[{thread, root, replies, reactions, mentions:[{userId,username}]}], nextBefore}`. |
| `POST /comments` | **editor** | `{ filePath, anchor:{ relStart, relEnd, startLine, endLine, prefixHash }, body, mentions:[userId] }` → creates thread + root comment. |
| `POST /comments/:threadId/replies` | editor | `{ body, mentions:[userId] }`. `parent_comment_id` forced to root. |
| `PATCH /comments/:commentId` | **author only** | `{ body, mentions? }` → sets `edited_at`, re-derives mentions. |
| `DELETE /comments/:commentId` | **author OR project owner** | tombstone. |
| `POST /comments/:threadId/resolve` | editor | sets `resolved_at`/`resolved_by`. Idempotent. |
| `POST /comments/:threadId/reopen` | editor | clears `resolved_at`/`resolved_by`. |
| `PUT  /comments/:commentId/reactions/:emoji` | editor | emoji ∈ fixed set → upsert `(comment,user,emoji)`; PK makes it idempotent. |
| `DELETE /comments/:commentId/reactions/:emoji` | editor | remove own reaction. |
| `POST /comments/:threadId/anchor-status` | editor | `{ status: 'ok'\|'stale' }` — advisory, updates `comment_threads.anchor_status`. |

Validation (server, never throws to the client beyond `ApiError`):

- `body`: string, strip C0/DEL except `\n\t`, collapse >2 consecutive
  blank lines, trim, `1 ≤ length ≤ COMMENT_MAX_LEN` (4000) → else 400.
- `filePath`: `sanitizeAwarenessFilePath` (reuse from `collab/presence.ts`)
  → non-null; the file need not currently exist (comment on a since-moved
  path is allowed and renders stale).
- `anchor.startLine`/`endLine`: `isAwarenessCoord`; `relStart`/`relEnd`:
  base64, decoded length bounded (≤ 4 KiB each), **not** interpreted.
  `prefixHash`: `/^[0-9a-f]{16}$/`.
- `mentions`: array of integers, deduped, each must satisfy
  `requireProjectAccess(db, mentionedId, projectId, "viewer")` **without
  throwing** — invalid / cross-project / non-member IDs are **dropped
  silently** (not an error). Cap 20 mentions per comment.
- `emoji`: exact string match against the fixed set → else 400.
- Rate limit: a per-`(userId, projectId)` `RateLimiter`
  (reuse `collab/attention.ts`) — `COMMENT_WRITE_MAX` (30) writes per
  `COMMENT_WRITE_WINDOW_MS` (60 000). Create/reply/edit count; resolve /
  reopen / reaction do not. 31st → 429.
- Edit / delete / resolve authorization re-checked per row against
  `userOf(req)` and (for delete) project ownership — never trust that the
  client only shows the button when allowed.

### 4.5 Live updates

On **every** successful mutation the route calls
`collaborationManager.broadcastCommentEvent(projectId, ev)` →
`room.broadcastCommentEvent(ev)` → receive-only `MESSAGE_CUSTOM`:

```jsonc
{ "type": "comment_event",
  "threadId": "…",
  "filePath": "auth/session.ts",
  "kind": "created" | "replied" | "edited" | "deleted"
        | "resolved" | "reopened" | "reacted",
  "at": 1723900000000 }
```

- **Receive-only** — the client has no code path that authors it (mirrors
  `collab_change`). A modified peer cannot forge comment state.
- Carries **no bodies** — it is a cache-invalidation ping. On receipt the
  client refetches `GET /comments?file=<filePath>` for the affected file
  (throttled/deduped ~250 ms) and merges. The full authoritative data
  always comes over REST.
- Mirrors `broadcastCollabChange` exactly: `if (this.disposed) return`,
  loop `this.clients`, `readyState === 1`, `encodeCustom`.

### 4.6 Mentions → notification (reuse M58 semantics, no new delivery system)

- **Autocomplete:** `@` in the composer opens a dropdown sourced from the
  project's members (`GET /collaborators`) + currently-connected
  collaborators (`collaborators` presence array), matched by username
  prefix. Selecting inserts `@username` as a styled token; on submit the
  client maps tokens → `userId` and sends the `mentions` array. Unknown
  `@handles` are left as literal text (never a mention).
- **Delivery:** on comment create/edit, for each valid mention target that
  is **currently connected to the room**, the server sends a **targeted**
  `MESSAGE_CUSTOM` `comment_mention` frame (targeted delivery = the M58
  `sendAttentionTo(userId, …)` filter over `this.clients`):

  ```jsonc
  { "type": "comment_mention",
    "threadId": "…", "commentId": "…",
    "filePath": "auth/session.ts", "line": 42,
    "author": { "userId": 7, "username": "rahul" },
    "preview": "should this happen before the session write?",  // <= 120, textContent
    "at": 1723900000000 }
  ```

- **Surface:** the `AttentionTray` becomes **"Attention & Mentions"** — a
  mention renders a card: `💬 Rahul mentioned you — auth/session.ts L42` +
  `"…preview…"` + `[Go to comment]` / `[Dismiss]`. `[Go to comment]` →
  `openAndRevealLocation(handleOpenFile, {filePath, line})` **then** open
  the thread popover for `threadId`.
- **Offline target:** the mention is still persisted (`comment_mentions`
  row). It re-surfaces via the M60 "while you were away" path — `comment`
  lifecycle events join `queryWhileAway`'s `MEANINGFUL_KINDS`, and a
  dedicated "N mentions while you were away" line groups them.
- **Preferences gate:** the Track B `notification.mentions` /
  `notification.comments` settings gate whether the tray card + count
  badge appear. They **never** gate persistence, the `comment_mentions`
  row, or the M60/audit records.
- No sound, no browser Notification API (no infra). The notification model
  (§5.9) leaves the enum room for a future channel.

### 4.7 Reactions

Fixed set, no custom emoji: `👍 👎 🎉 👀 ❤️ 🚀`. Rendered as a compact chip
row under each comment: `👍 3` `👀 1` `+`. `+` opens the fixed picker.
`comment_reactions` PK `(comment_id, user_id, emoji)` prevents duplicates
and unbounded spam; a user toggles their own reaction only; server checks
`emoji` against the set and `user_id` against the session.

### 4.8 UI surfaces (`frontend/src/components/Comments/`)

| Surface | Component | Behavior |
|---|---|---|
| **Gutter marker** | Editor decoration (M58 collection pattern) | `💬` on `anchor_start_line` for **active, non-stale** threads; `💬 N` when replies > 0; quiet neutral color (not collaborator-tinted); click → open thread popover. |
| **Range tint** | Editor decoration | faint `--accent-subtle` background over the anchored range while the marker is hovered/focused. |
| **Hover preview** | Monaco content widget | root author avatar + first line of `body` (textContent) + "N replies" + `[Open thread]`. No layout shift. |
| **Thread popover** | `CommentThread.tsx` | content widget anchored above the range **or** docked in the Comments panel. Root + ordered replies; each row: `<CollaboratorAvatar>` + name + relative time + `edited`/`deleted` state + reaction chips + (author) edit/delete. Reply composer with `@` autocomplete. `[Resolve]` / `[Reopen]`. Focus-trapped, Esc closes, arrow-key navigation between comments. All text via React children. |
| **Comments panel** | `CommentsPanel.tsx` | a **section in the right rail, sibling to TeamPanel** — not a new floating panel. Current file's threads (active + a "Resolved (N)" collapsible), a project-wide "Unresolved (N)" roll-up, click a row → `openAndRevealLocation` + open popover. |
| **File-level indicator** | Explorer row + editor tab | unresolved-count badge (reuse the dirty-dot slot); Explorer only when the project has any comments. |
| **Navigation commands** | `CommandRegistry` | "Comments: Next in file", "Comments: Previous in file", "Comments: Go to unresolved" (opens the panel roll-up). Bindable via Track B keyboard settings. |
| **Callout → comment** | M58 callout card gains `[Keep as comment]` | client POSTs `/comments` with the callout's `file`, a fresh anchor computed from the callout `range`, `body = callout.message`, `mentions = []`. The callout keeps its ephemeral TTL and is untouched. A test asserts no M58 event mutation and a new row. |

Reduced motion (Track B `accessibility.motion`): marker fade / popover
open transitions collapse to instant.

### 4.9 M60 history integration

`timeline.ts` gains a **5th union source** reading `comment_threads` +
`comments` directly (safe columns, `(at,id)` cursor pushed in), emitting
`kind: "comment"` `TimelineEvent`s:

| Trigger | `title` | navigable |
|---|---|---|
| root comment created | `commented on <file> L<line>` | yes (file + anchor line) |
| reply added | `replied on <file>` | yes |
| thread resolved | `resolved a comment thread` | yes |
| thread reopened | `reopened a comment thread` | yes |

- **Only these lifecycle events.** Not composer keystrokes, not edits, not
  reactions, not anchor-status pings.
- `subtitle` = the ≤120-char preview of the relevant comment body (same
  allowlist discipline as M60 callout `messagePreview`).
- `at` = the comment's `created_at` (or thread `resolved_at`).
- `queryWhileAway` adds `"comment"` to `MEANINGFUL_KINDS`.
- **Live:** the `comment_event` broadcast is *also* the timeline
  live-merge trigger — `IDE.tsx` already refetches the timeline tail on
  `collab_change`; it does the same on `comment_event`.
- New `AuditEventType` values `COMMENT_ADDED`, `COMMENT_RESOLVED` for admin
  visibility parity (written via `recordAuditLog`, `sanitizeDetails`
  applies). The timeline reads the `comments` tables directly, **not**
  audit — audit is supplementary, not the source (avoids double-count).

### 4.10 Track A security model (mirrors M58 §10)

| Boundary | Stance |
|---|---|
| **Author identity** | Always `userOf(req)`. No body field is ever read for identity. Insert statements never spread the request body. |
| **Project scope** | Every route opens with `requireProjectAccess`; every query is `WHERE project_id = ?` first; FKs cascade-scope. `comment_event` fan-out is room-only. |
| **Mention authorization** | Each mention target validated with `requireProjectAccess(…, "viewer")`; cross-project / arbitrary / non-member IDs dropped silently. No global user lookup. Mention delivery is room-targeted. |
| **Edit / delete / resolve authz** | Re-checked per row server-side: edit → `author_id === session`; delete → `author_id === session OR project.owner_id === session`; resolve/reopen → editor role. |
| **XSS / injection** | `body` sanitized (C0/DEL stripped, length-capped) and rendered **text-only** everywhere (React children; mentions tokenized client-side by matching known usernames, rendered as `<span>`, never `innerHTML`, never Markdown→HTML). Test: `<img src=x onerror=…>` and `[x](javascript:…)` render literally. |
| **Anchor blobs** | Stored opaque; server never `eval`s / decodes / executes them. Decode length-bounded on the client. A malformed blob → resolve returns `null` → stale (safe). |
| **Rate / size** | Per-user-per-project `RateLimiter`; `body` ≤ 4000; mentions ≤ 20; reactions bounded by the fixed set + PK. `comment_event` is a tiny fixed-shape frame. |
| **Cross-project isolation** | Tested: project B's room never receives project A's `comment_event`; `GET /comments` for a non-member → 404. |
| **Secret / output leakage** | Comments carry only user free text + coordinates + a bounded path. No file content, diff, stdout/stderr, env, or secret is ever in a comment payload, the wire frame, or the timeline row. |
| **Document integrity** | No comment path opens a `Y.Doc` transaction or calls `doc.getText` server-side. The client computes anchors from the already-bound `Y.Text`; comment rendering never edits the model. Concurrent-edit convergence regression-tested with comment traffic interleaved. |

---

## 5. TRACK B — IDE Customization

### 5.1 The setting registry (canonical, typed)

`frontend/src/settings/registry.ts` — one source of truth. Nothing is a
"setting" unless it is registered here **and** its `apply` does something
real.

```ts
type SettingScope = 'global' | 'workspace' | 'session';
type SettingCategory =
  | 'appearance' | 'layout' | 'editor' | 'collaboration'
  | 'notifications' | 'keyboard' | 'accessibility' | 'advanced';
type ControlKind =
  | 'toggle' | 'select' | 'segmented' | 'slider' | 'color' | 'shortcut';

interface SettingDef<T> {
  id: string;                       // dotted, stable: "editor.fontSize"
  category: SettingCategory;
  section: string;                  // sub-group label ("Font", "Remote cursors")
  label: string;
  description: string;              // shown for non-obvious settings
  keywords?: string[];              // extra search terms ("caret" for cursor)
  control: ControlKind;
  options?: Array<{ value: T; label: string }>;   // select/segmented
  min?: number; max?: number; step?: number;      // slider
  default: T;
  scope: SettingScope;
  validate: (v: unknown) => v is T; // EVERY read + import goes through this
  apply: (v: T, ctx: ApplyContext) => void;       // set CSS var / Monaco opt / context flag
}
```

`ApplyContext` gives `apply` narrow capabilities: `setCssVar(name, value)`,
`setRootAttr(name, value)`, `updateMonacoOptions(partial)`,
`setContextFlag(key, value)` (a React context consumed by presentation
components). `apply` **may not** reach into arbitrary component state — it
touches exactly one surface, so changing one setting never re-renders the
whole IDE.

### 5.2 `SettingsStore`

`frontend/src/settings/store.ts` — a `useSyncExternalStore`-compatible
singleton:

- `get<T>(id): T` — resolve by **scope precedence: `session` > `workspace`
  > `global` > `default`** (documented; the common case is a single scope
  so precedence rarely bites). Value is `validate`d on read; invalid →
  `default` (and the bad value is dropped).
- `set(id, v)` — `validate` → persist to the setting's own scope → `apply`
  → notify. Rejected values throw a typed error surfaced inline in the UI.
- `resetOne(id)` / `resetCategory(cat)` / `resetAll()` — delete from the
  scope store(s), re-`apply` defaults.
- `export(): SettingsExport` / `import(json): ImportResult` — §5.10.
- `search(query): SettingDef[]` — `fuzzyFilter` over
  `{category, section, label, description, keywords}` of the **registry
  array**, never the DOM.
- `subscribe(id?|cat?, cb)` — fine-grained; a component subscribes to the
  ids it renders.

On app boot: load `global` from server + `workspace` from `localStorage`,
run the migration chain (§5.11), then `apply` every registered setting once
(idempotent). A settings-not-yet-loaded flash is avoided by applying
`default`s synchronously from the registry first.

### 5.3 Scoping & persistence

| Scope | Store | Examples |
|---|---|---|
| **global** | **server**: new `user_settings` table (`user_id` PK, `version` INT, `data` TEXT JSON ≤ 32 KiB, `updated_at`) via `GET/PUT /api/auth/settings` | theme, accent, density, motion, all editor prefs, keybindings, notification prefs, collaboration presentation |
| **workspace** | `localStorage` key `cloudeee.ws.<projectId>.settings` (namespaced) | panel widths, terminal height, explorer width, which side-rail panels are open, activity-timeline visibility, "show resolved comments" |
| **session** | React state / `sessionStorage` | transient toggles that should not persist across tabs |

- `user_settings.data` is **validated key-by-key against the registry on
  read and on write** server-side is *not* possible (the registry is
  frontend) — so the server stores the blob opaquely with a **hard 32 KiB
  cap, JSON-parse check, and key-count cap (200)**; the **client**
  validates every key against the registry on load and on import and drops
  unknowns. Security rests on: (a) the blob can only ever be read back by
  its own authenticated user, (b) it is never `eval`d, (c) every value is
  re-validated + clamped before `apply`, (d) no `apply` can change
  authorization or inject markup (§5.7). Secrets are never written to it.
- The 7 legacy `user_preferences` keys are **migrated into `user_settings`
  at v12** (`editor.fontSize` etc.). `GET /api/auth/preferences` keeps
  returning a **projection** of those 7 keys from `user_settings` for one
  milestone (compat for any missed caller); `PUT` proxies into
  `user_settings`. The `user_preferences` table is left in place, unused,
  and dropped in M62.

### 5.4 Theme / token architecture

- **`styles/tokens.css` stays the token layer.** The ~24 palette-defining
  tokens (`--bg-*`, `--fg-*`, `--accent`, `--secondary`, semantic status,
  border, shadow tints) move under `:root[data-theme="<name>"]` selectors;
  structural tokens (`--radius-*`, `--space-*`, `--text-*`, `--font-*`,
  `--duration-*`, `--spring-*`) stay theme-independent on bare `:root`.
- **4 built-in themes**, each a closed set of the palette tokens:
  `cloud-dark` (current values, default), `cloud-midnight` (higher
  contrast, deeper bg), `cloud-dim` (lower contrast, softer), `cloud-light`.
  `appearance.theme` `apply` → `document.documentElement.dataset.theme = v`.
- **Accent:** `appearance.accent` — the 8-color Catppuccin palette (same as
  `getUserColor`) + `custom`. `custom` reveals one hex input, validated
  `/^#[0-9a-f]{6}$/i` **and** contrast-checked (WCAG AA vs
  `--bg-surface`); a failing hex is rejected inline. `apply` sets
  `--accent` and derives `--accent-hover/-subtle/-glow` via `color-mix()`
  (with static fallbacks for older engines).
- **Density:** `appearance.density` — `compact` / `comfortable` (default) /
  `spacious`. `apply` → `data-density` on `:root`; `tokens.css` remaps
  `--space-1..8` and a new `--control-h` per density. Because spacing
  already flows through `--space-*`, most of the UI responds for free; a
  bounded list of components with hard-coded px (enumerated in the plan)
  are migrated to tokens as part of this task.
- **Editor theme:** `appearance.editorTheme` — pairs with the app theme by
  default; independently overridable. Monaco `defineTheme` for the 3
  non-default variants (`cloud-midnight`, `cloud-dim`, `cloud-light`);
  `apply` → `monaco.editor.setTheme`.
- **Collaborator colors stay server-derived + deterministic** (`getUserColor`
  / awareness `user.color`). A user may set `collaboration.myLabelStyle`
  (`name` / `initials` / `off`) and `collaboration.showRemoteCursors` /
  `showRemoteSelections` / `showRemoteLabels` — these affect **only their
  own view**. No setting lets one user redefine how another appears to
  everyone. Profile accent (Track C) affects the *chooser's own* identity
  surfaces (their card border, their cursor label tint) — see §6.5 for the
  precise blast radius.
- **Import can set theme/accent/density by validated enum or single
  contrast-checked hex only** — never a token map, never a CSS string. The
  "advanced token overrides" option was **declined** for M61.

### 5.5 Settings UI

`frontend/src/components/Settings/` replaces `SettingsModal.tsx` with a
full-surface two-pane experience (portal, `glass-floating`, ~880×620,
responsive down to ~720 wide):

```
┌────────────────────────────────────────────────────────────┐
│  Settings                                            [×]    │
│ ┌──────────────┐ ┌───────────────────────────────────────┐ │
│ │ 🔎 Search…   │ │  APPEARANCE › Theme                    │ │
│ │              │ │  [ Cloud Dark ▼ ]      ⟲               │ │
│ │ Appearance   │ │  APPEARANCE › Accent                   │ │
│ │ Layout       │ │  ● ● ● ● ● ● ● ●  ○ custom  ⟲          │ │
│ │ Editor       │ │  APPEARANCE › Density                  │ │
│ │ Collaboration│ │  [Compact|Comfortable|Spacious]  ⟲     │ │
│ │ Notifications│ │  …                                     │ │
│ │ Keyboard     │ │                                       │ │
│ │ Accessibility│ │  ── Reset section ──                   │ │
│ │ Advanced     │ │                                       │ │
│ └──────────────┘ └───────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

- Left: keyboard-navigable category list (`role="tablist"`, arrow keys).
- Right: content **rendered from the registry**, grouped by `section`,
  each row = `<control> + label + description + current value + ⟲ reset`.
- **Search**: filters the right pane to matching settings **across all
  categories** ("cursor" → Editor·Cursor style, Collaboration·Remote
  cursors, Appearance·Accent-adjacent) with the category shown per hit.
- **Instant preview**: every `set` `apply`s live behind the still-open
  panel — no Save button; changes are committed on change (debounced for
  sliders/hex).
- Per-category "Reset section"; Advanced has "Reset all settings",
  "Export settings", "Import settings", "Reset layout", plus
  `advanced.experimental.*` flags.
- Opens via `Ctrl/Cmd+,` (added to `useKeyboardShortcuts` → registry
  binding) + a `CommandRegistry` command + the Toolbar gear.

### 5.6 Keyboard shortcuts

- `settings/keys.ts` — pure: `parseChord("Ctrl+Shift+P")` →
  `{mod, shift, alt, key}`, `matchChord(event, chord)`, `formatChord` (with
  `IS_MAC` ⌘ rendering), `chordConflict(a, b)`. Fully unit-tested.
- `useKeyboardShortcuts` is refactored to build its `key → commandId` map
  from the registry's `keyboard.*` shortcut settings (defaults defined in
  the registry, matching today's hard-coded chords exactly), then dispatch
  via `CommandRegistry.execute(commandId)` / the existing callback bag.
  **Command dispatch is unchanged** — only the *source* of the map moves.
- The Keyboard category lists every `CommandRegistry` command + its current
  binding, a "record chord" control to rebind, **conflict detection**
  (two settings → same chord → inline warning, the second save is
  blocked), per-binding reset + "Reset all shortcuts".
- Only commands that already exist are exposed. No new dispatch system.

### 5.7 Accessibility (functional, not decorative)

- `prefers-reduced-motion` honored by default (already is in `tokens.css`)
  **plus** `accessibility.motion` (`system` / `full` / `reduced`) — when
  `reduced`, `apply` sets `data-motion="reduced"` on `:root`, which
  `tokens.css` maps to zero durations, **and** a context flag that M58
  attention pulses, M59 follow transitions, and Track C profile effects
  read to disable themselves. Reduced-motion becomes a real functional
  gate, tested at each consumer.
- `accessibility.contrast` (`system` / `standard` / `high`) — `high` forces
  the `cloud-midnight` palette regardless of `appearance.theme` (documented
  precedence: accessibility wins).
- `accessibility.textScale` (`0.9`–`1.4`, step `0.05`) — `apply` sets
  `--text-scale`; `tokens.css` multiplies `--text-*` by it.
- `accessibility.focusRing` (`default` / `bold`) — thicker, higher-contrast
  `:focus-visible` outline via a token.
- `accessibility.keyboardNav` docs + every new surface (Settings, profile
  editor, comment thread popover, mention dropdown) is focus-trapped,
  `aria`-labeled, Esc-closable, and reachable without a mouse. An a11y
  regression checklist is in the plan.
- **No customization may reduce contrast below AA for text on surfaces** —
  the theme palettes are pre-checked; a custom accent that fails AA is
  rejected at input time.

### 5.8 Layout customization

- `layout.explorerWidth`, `layout.sideRailWidth`, `layout.terminalHeight`,
  `layout.bottomPanelHeight` — sliders with **enforced min/max** (e.g.
  explorer 180–480). `apply` sets CSS vars consumed by the existing fl<ex
  layout. Stored **workspace-scoped**.
- `layout.panels.*` toggles — Explorer / Team panel / Activity timeline /
  Preview / Terminal visibility.
- "Reset layout" (Advanced) restores every `layout.*` to default and is the
  recovery path — there is **no** way to produce an unrecoverable layout
  (min/max clamps + reset).

### 5.9 Notifications — unified model

One setting per channel, value `enabled` | `muted`:
`notification.mentions`, `notification.comments`,
`notification.attentionRequests`, `notification.collaboratorJoins`,
`notification.teamActivity`, `notification.executionActivity`. Consumed
only at the tray/badge render sites (`AttentionTray`,
`CollaboratorAvatarStack` badge, `WhileYouWereAway`). `muted` suppresses
the visible surface; it never suppresses persistence, the M60 row, or the
audit log. Sound / browser Notification are **out** (no infra); the enum
value space allows adding `browser` / `sound` later without a model
change.

### 5.10 Reset / export / import

- `resetOne` / `resetCategory` / `resetAll` — every registered setting is
  resettable by construction (the registry has a `default`; a test asserts
  every id round-trips through reset).
- **Export**: `export()` → `{ version: <N>, exportedAt, data: {<id>: value} }`
  → offered as a `cloudide-settings-v<N>.json` download.
- **Import** (approved, validated):
  1. Parse (reject if not JSON, or > 64 KiB, or > 300 keys).
  2. Run the `data` through the migration chain (§5.11) to the current
     version.
  3. For **every** key: look up the registry def; drop if unknown; run
     `validate`; clamp numerics to `min`/`max`; reject non-enum
     theme/accent/density; reject any string that is not an allowed enum
     value or a contrast-checked hex. There is **no key whose value is
     interpreted as code, CSS, HTML, or a token map.**
  4. Show a diff preview (`N settings will change`) → apply on confirm.
- Import can never touch `keyboard.*` in a way that produces an
  unrecoverable state (conflict detection still runs; a conflicting import
  entry is dropped with a notice).

### 5.11 Versioned preference schema

`frontend/src/settings/migrations.ts` — a single ordered array:

```ts
const SETTINGS_MIGRATIONS: Array<{
  to: number;
  migrate: (data: Record<string, unknown>) => Record<string, unknown>;
}> = [
  { to: 2, migrate: (d) => /* rename / re-shape */ d },
];
export const CURRENT_SETTINGS_VERSION = 1;  // bumped as migrations are added
```

- Runs on: server load, `localStorage` load, import.
- `user_settings.version` stamps the stored blob. A blob from a **newer**
  version than the client knows → the client refuses to apply unknown keys
  (drops them), keeps the blob, warns once. Downgrade-safe.
- **All** settings migration logic lives here — never in a component.
  Mirrors the `db.ts` migration discipline.

### 5.12 Track B security model

| Boundary | Stance |
|---|---|
| **Arbitrary code / CSS / HTML** | Impossible by construction: `apply` functions are a closed, reviewed set; no value is ever a CSS string, token map, markup, or script. Theme/accent/density are enums + one contrast-checked hex. |
| **Import abuse** | Size / key-count capped; every value re-validated + clamped against the registry; unknown keys dropped; migration-versioned; diff-previewed. |
| **Scope enforcement** | `user_settings.data` is per-user, only readable by its owner; `localStorage` is origin-scoped; no scope can hold or reference a secret. |
| **Privilege escalation** | No setting maps to a role, permission, project membership, or server authorization decision. The registry is audited for this; a test asserts no setting id matches an authz-adjacent allowlist. |
| **Secret persistence** | Nothing secret is ever a setting value; the server blob store rejects nothing by content but the client never writes a secret there. |
| **DoS** | Blob 32 KiB / 200-key cap server-side; import 64 KiB / 300-key cap client-side; slider/hex writes debounced. |

---

## 6. TRACK C — User Profile / Identity

### 6.1 Intent & the one-identity rule

A collaborator is a person, not a label. The same **profile identity
model** flows into every identity surface:

```
Profile (server-authoritative)
   └─► identityStore (client cache, keyed by userId)
         ├─ merged with M57 presence (ephemeral: activity, cursor, status-dot)
         └─► <CollaboratorAvatar> · <CollaboratorCard> · <CollaboratorName>
               ├─ CollaboratorAvatarStack
               ├─ TeamPanel
               ├─ collaborator popover
               ├─ remote cursor label (name only — never a card)
               ├─ AttentionTray / callouts
               ├─ comment author rows / mention chips
               ├─ ActivityTimeline actor
               └─ profile page
```

**One user = one identity model. No feature builds its own
avatar/name/color source.** `getUserColor` / awareness `user.color` remain
the color authority; the profile adds display name, avatar, custom status,
badges, etc. on top.

### 6.2 Separation of models (must stay coherent)

| PROFILE CUSTOMIZATION (Track C) — *what others see* | USER PREFERENCES (Track B) — *how I experience the IDE* |
|---|---|
| display name, avatar, banner, bio, pronouns, location | theme, density, layout |
| profile accent, profile effect | editor prefs |
| custom status (+ expiry), availability default | collaboration *presentation* toggles |
| badges (order + selection), featured projects, links | notifications, shortcuts, accessibility |
| privacy flags | — |
| **server-authoritative, versioned, per-user** | **server blob + local, versioned, per-user** |

These are **separate tables, separate endpoints, separate editors.** A
profile field is never a "setting"; a setting is never a profile field.

### 6.3 Persistence model — migration v12 (same migration as Track A)

**Persistence decision (evidence-based, not the spec's first draft of seven
tables).** Access patterns: `buildPublicProfile` (§6.4) reads **identity +
appearance + privacy flags + custom status + badges + links + featured** on
*every* profile render and *every* `/projects/:id/profiles` bundle build.
Privacy flags are read on every one of those reads to filter the response —
they are a fixed set of scalars, always fetched with the profile, never
queried independently. → **Privacy folds into `user_profiles`** (one row,
always co-fetched); a separate `user_profile_privacy` micro-table would add
a join to every read for zero benefit. Custom status stays **separate**
(different write cadence, an expiry sweep that must not churn
`user_profiles.updated_at`, frequently NULL). Badges / links / featured are
genuine 1:N relations → their own tables. Media is 1:N with lifecycle
(replace/GC) → its own table. Net: **six tables**, no JSON blob for
structured fields, no micro-table per scalar.

```sql
CREATE TABLE user_profiles (
  user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name       TEXT,                         -- <= 64; NULL → fall back to username
  pronouns           TEXT,                         -- <= 32, from a suggested set or free (bounded)
  location           TEXT,                         -- <= 64, free text
  bio                TEXT,                         -- <= 400, sanitized, text-only
  avatar_media_id    TEXT REFERENCES profile_media(id) ON DELETE SET NULL,
  banner_kind        TEXT NOT NULL DEFAULT 'none', -- 'none' | 'preset' | 'solid' | 'gradient' | 'image'
  banner_value       TEXT,                         -- preset id | hex | 'hex1,hex2,angle' | NULL (image → banner_media_id)
  banner_media_id    TEXT REFERENCES profile_media(id) ON DELETE SET NULL,
  profile_accent     TEXT NOT NULL DEFAULT 'inherit', -- palette name | contrast-checked hex | 'inherit'
  profile_effect     TEXT NOT NULL DEFAULT 'none',    -- 'none' | 'glow' | 'gradient' | 'pulse'
  availability_default TEXT NOT NULL DEFAULT 'online', -- seeds M57 status on connect
  -- privacy flags (folded in — always co-fetched, never queried alone):
  profile_visibility   TEXT NOT NULL DEFAULT 'collaborators', -- 'collaborators' | 'private'
  show_location        INTEGER NOT NULL DEFAULT 1,
  show_links           INTEGER NOT NULL DEFAULT 1,
  show_activity        INTEGER NOT NULL DEFAULT 1,   -- current activity/file on the card
  show_current_file    INTEGER NOT NULL DEFAULT 1,
  show_recent_history  INTEGER NOT NULL DEFAULT 1,   -- M60 rows on the profile page
  show_featured        INTEGER NOT NULL DEFAULT 1,
  version            INTEGER NOT NULL DEFAULT 1,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE user_custom_status (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  emoji       TEXT,                                 -- one small grapheme, validated
  text        TEXT,                                 -- <= 128, sanitized, text-only
  expires_at  TEXT,                                 -- NULL = until cleared
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE profile_media (
  id           TEXT PRIMARY KEY,                    -- randomUUID
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                       -- 'avatar' | 'banner'
  mime         TEXT NOT NULL,                       -- 'image/png' | 'image/jpeg' | 'image/webp'
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  bytes        INTEGER NOT NULL,
  storage_path TEXT NOT NULL,                       -- <dataDir>/profile-media/<userId>/<id>.<ext>
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_profile_media_user ON profile_media(user_id, kind);

CREATE TABLE user_badges (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_id    TEXT NOT NULL,                        -- from the server catalog (§6.6)
  position    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, badge_id)
);

CREATE TABLE user_links (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                        -- 'github' | 'website' | 'other'
  label       TEXT,                                 -- <= 40
  url         TEXT NOT NULL,                        -- https only, <= 200, host-validated
  position    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE user_featured_projects (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, project_id)
);
```

(Privacy flags live on `user_profiles` — see the persistence decision above.
`PUT /api/users/me/privacy` writes those columns.)

- **Bounded**: text lengths capped, ≤ 8 featured projects, ≤ 6 displayed
  user badges, ≤ 5 links, ≤ 1 avatar + ≤ 1 banner media row live per user
  (old rows GC'd on replace).
- `users` table is **not** widened — identity stays in `user_profiles`
  keyed by `user_id`; `username` / `role` stay authoritative in `users`.
- Fallbacks: no `display_name` → `username`; no avatar → initials + color
  (the current `<CollaboratorAvatar>` behavior); `profile_accent =
  'inherit'` → the deterministic `getUserColor`.

### 6.4 REST API

| Method + path | Auth | Notes |
|---|---|---|
| `GET  /api/users/me/profile` | session | full own profile (all fields incl. privacy) for the editor |
| `PUT  /api/users/me/profile` | session | identity + appearance sub-fields; per-field validation |
| `PUT  /api/users/me/status` | session | `{ emoji?, text?, expiresAt? }` — custom status; server clamps `expiresAt` to ≤ 24 h; server sweep clears expired |
| `DELETE /api/users/me/status` | session | clear |
| `PUT  /api/users/me/badges` | session | `{ badges: [{badgeId, position}] }` — each must be **grantable to this user** (§6.6); ungrantable dropped |
| `PUT  /api/users/me/links` | session | `{ links: [{kind,label,url,position}] }` — `url` `https://`, host allowlist for `github` (`github.com`), length caps |
| `PUT  /api/users/me/featured` | session | `{ projectIds: [...] }` — each must be a project the user **owns or collaborates on** (`requireProjectAccess viewer`); others dropped |
| `PUT  /api/users/me/privacy` | session | privacy flags |
| `POST /api/users/me/avatar` \| `/banner` | session | `multipart/form-data`, one file — §6.7 |
| `DELETE /api/users/me/avatar` \| `/banner` | session | revert to fallback |
| `GET  /api/users/:id/avatar` \| `/banner` | session | streams the media file with a forced safe `Content-Type` (§6.7) — 404 if none or privacy hides it |
| `GET  /api/projects/:id/profiles` | `requireProjectAccess viewer` | **the collaboration bundle**: for every member + currently-connected user, a **privacy-filtered** `PublicProfile` (display name, avatar id/version, accent, effect, badges, custom status, pronouns; location/links/history only if the viewer is allowed). This is what `identityStore` hydrates from. |
| `GET  /api/users/:id/profile` | session | full profile *page* view, privacy-filtered relative to the requester; 404 if `profile_visibility = 'private'` and not self |
| `GET  /api/users/me/profile/export` | session | versioned JSON of the customization (no media bytes — media by reference) |
| `POST /api/users/me/profile/import` | session | validated re-import (§6.9) |

- **Identity/authorization is never in the profile response as
  authoritative** — `userId`, `username`, `role` in a `PublicProfile` are
  copied from `users` / `project_collaborators` server-side, not from
  `user_profiles`. A privacy flag can hide `location`/`links`/`history`;
  it can **never** hide `userId`/`username`/`role`/membership from an
  authorized collaborator (§6.8).

### 6.5 Profile appearance & the accent blast radius

- **Avatar** — upload (§6.7) or initials fallback. Rendered by the single
  `<CollaboratorAvatar userId size>` primitive everywhere.
- **Banner** — `none` | `preset` (a fixed catalog of ~8 gradient/texture
  presets shipped as CSS, referenced by id) | `solid` (one hex) |
  `gradient` (`hex1,hex2,angle`, all validated) | `image` (uploaded,
  §6.7). Shown on the profile page and the top of the full collaborator
  card. Never on cursor labels or the avatar stack.
- **Profile accent** — `inherit` (→ `getUserColor`) | a palette name | a
  contrast-checked hex. **Blast radius (explicit):** it tints **only the
  chooser's own** identity surfaces as seen by everyone — their avatar
  ring, their name color in TeamPanel / comment rows, their remote-cursor
  label background, their card header. It is deterministic across sessions
  (persisted server-side, in the `PublicProfile` bundle). It **cannot**
  change any other user's rendering, any shared chrome, or any token.
  Viewer-side `collaboration.*` toggles (Track B) can still turn remote
  labels/cursors off entirely for that viewer.
- **Profile effect** — `none` | `glow` (static accent glow behind the
  avatar/card) | `gradient` (accent gradient card header) | `pulse` (a
  slow accent pulse). All CSS-only, accent-derived, **disabled under
  reduced motion** (`pulse` → `glow`; transitions → none). A closed set —
  no user-supplied effect definition.

### 6.6 Badges

- **Server catalog** (`backend/src/profile/badges.ts`), two classes:
  - **User-selectable skill badges** — a fixed catalog
    (`☁ Cloud`, `⚡ Systems`, `🟦 TypeScript`, `⚛ React`, `🐳 Docker`,
    `🤖 AI`, `🧪 Testing`, `🎨 UI`, …). Any authenticated user may pick up
    to 6 and order them.
  - **Server-authoritative role/system badges** — `Admin` (from
    `users.role`), `Owner` / `Maintainer` / `Contributor` (derived from
    project membership — shown contextually on a project's collaborator
    card, not globally). **Not writable via the API** — `PUT /badges`
    drops any badge id that is not in the user-selectable catalog.
    Forgery-proof: the render layer computes role badges from `users` /
    `project_collaborators`, never from `user_badges`.
- No uploaded badge art, no HTML/CSS badge definitions.

### 6.7 Profile image security (single upload pipeline)

Reuse `parseMultipartFormData`. **One** new pipeline
(`backend/src/profile/media.ts`), no second uploader.

| Check | Rule |
|---|---|
| Count | exactly one file part |
| Size | avatar ≤ 512 KiB; banner ≤ 2 MiB (pre-decode, from `Content-Length` + actual buffer) |
| MIME by **magic bytes** | PNG (`89 50 4E 47`), JPEG (`FF D8 FF`), WebP (`RIFF…WEBP`) only. The declared `Content-Type` is ignored. |
| **SVG** | rejected outright (no sanitizer in the stack) |
| Dimensions | parsed from the image header (small dedicated header readers for the 3 formats); avatar ≤ 1024×1024, banner ≤ 3840×1440; ≥ 32 px each side; reject if unparseable |
| Bytes-after-header sanity | reject truncated / trailing-garbage beyond a small tolerance |
| Storage | `<dataDir>/profile-media/<userId>/<uuid>.<ext>` — outside every workspace, so no path-traversal into project files; filename is a server UUID, never client-derived |
| Serving | `GET /api/users/:id/avatar` → `res.sendFile` with **forced** `Content-Type` from the stored `mime`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`, `Content-Security-Policy: default-src 'none'`, `Cache-Control: private, max-age=300`. Never `text/html`, never executed. |
| Replace | inserting a new avatar/banner row deletes the previous row + unlinks its file (best-effort) |
| Rate | `RateLimiter` — a few uploads/minute/user |
| Audit | `PROFILE_MEDIA_UPLOADED` |

No image re-encoding (no library) — validation is strict-reject, not
sanitize-and-accept. A file that passes all checks is stored verbatim and
only ever served as a fixed non-executable content type.

### 6.8 Profile privacy

- `profile_visibility`: `collaborators` (default — any user who shares a
  project can see the profile page) | `private` (only self; the
  collaboration card still shows the **essential** identity: name, avatar,
  role, custom status, live activity per `show_activity` — because those
  are needed to collaborate).
- Field flags (`show_location`, `show_links`, `show_recent_history`,
  `show_current_file`, `show_featured`) gate **only those presentation
  fields** in `GET /users/:id/profile` and `GET /projects/:id/profiles`.
- **Hard invariant:** `userId`, `username`, `display_name`, `role`,
  project membership, and the fact that the user is present/active are
  **never** hidden from an authorized collaborator — the collaboration
  system's identity and authorization behavior is unchanged by any privacy
  setting. `show_current_file = 0` hides the *file name on the card*; it
  does **not** stop M57 presence (which is how "who's here" and follow
  work) — it is a card-rendering choice, documented as such. (A future
  "invisible mode" is out of scope and explicitly noted as not delivered.)
- A privacy flag never affects the server's authorization checks, room
  membership, or the M60 timeline's own access rules.

### 6.9 Profile export / import

- `GET /users/me/profile/export` → `{ version, exportedAt, profile:{…},
  status:{…}, badges:[…], links:[…], privacy:{…} }` — **customization
  only**, media by reference (id), never bytes.
- `POST /users/me/profile/import` → parse (≤ 32 KiB), migrate to current
  `version`, **per-field re-validation** identical to the `PUT` endpoints
  (lengths, enums, contrast-checked hex, `https` host allowlist,
  grantable badges, owned/collab featured projects), drop anything
  invalid, diff-preview, apply. No field is ever interpreted as code /
  CSS / HTML; media ids that don't belong to the importing user are
  dropped.

### 6.10 Profile customization UI

`frontend/src/components/Profile/` — same primitives as Settings
(`components/common/controls/`, `glass-*`, portal). Sections:

```
Profile
├── Preview      ← live <CollaboratorCard> + a compact popover preview,
│                  updates on EVERY change before save
├── Identity     display name · pronouns · location · bio
├── Appearance   avatar · banner · profile accent · profile effect
├── Status       availability default · custom status + emoji + expiry
├── Badges       pick (≤6) + drag-reorder
├── Developer    GitHub · website · other links (≤5)
├── Featured     pick from own/collab projects (≤8) + reorder
└── Privacy      visibility + field flags
```

- **Live preview is mandatory** and previews the *actual*
  `<CollaboratorCard>` / popover components the multiplayer UI uses — so
  "what will Rahul see" is answered without save→reload.
- Save is explicit per section (`PUT` the section); the preview reflects
  unsaved edits; "Discard" reverts to the last saved state.
- Opened via `CommandRegistry` ("Edit my profile") + the self-avatar menu
  in `CollaboratorAvatarStack` + a link from Settings → "Edit profile"
  (which navigates to the profile surface — the two are separate but
  cross-linked).

### 6.11 Shared identity architecture (implementation)

- `frontend/src/collab/identity.ts` — `IdentityStore`: `Map<userId,
  PublicProfile>`, hydrated by `GET /api/projects/:id/profiles` on room
  join, refreshed on a `profile_event` broadcast (receive-only
  `MESSAGE_CUSTOM`, `{type:'profile_event', userId}` → refetch that user
  or the bundle, throttled). `get(userId)` returns the profile or a
  synthetic fallback (`{displayName: username, accent: getUserColor(id),
  avatar: null}`).
- `frontend/src/components/common/identity/` —
  - `<CollaboratorAvatar userId size ring? />` — avatar image (via
    `/api/users/:id/avatar?v=<version>`) or initials+accent; **replaces
    all current inline avatar rendering** (avatar stack, popover ×2,
    TeamPanel, comment rows).
  - `<CollaboratorName userId />` — display name, accent-tinted, with role
    badge.
  - `<CollaboratorCard userId compact? />` — the full/compact card from
    the §1 mockup: banner, avatar, name, `@username`, badges, custom
    status, `🟢 availability`, **live** activity/file/intent (read from
    the existing `collaborators` presence array — *not* a new store),
    `[View profile]`.
- `CollaboratorAvatarStack.tsx`, `TeamPanel.tsx`, `FollowBanner.tsx`,
  `AttentionTray.tsx`, comment rows, `ActivityTimeline` actor cells are
  **retrofitted** to these primitives. Remote cursor labels (`y-monaco`
  awareness rendering) stay **name-only** — no card.
- Awareness payload is **not** enlarged with profile data — **and custom
  status is explicitly not mirrored into awareness** (decision §13.6). It
  is durable `user_custom_status`, delivered via the `/projects/:id/profiles`
  bundle + a `profile_event` invalidation ping, and combined with ephemeral
  M57 presence **client-side** inside `<CollaboratorCard>` (`profile.customStatus`
  + `presence.activity`). No second synchronization source; a performance
  test (§9.7 #2) asserts no `customStatus` key appears in awareness.

### 6.12 Track C security model

| Boundary | Stance |
|---|---|
| **Identity forgery** | `userId`/`username`/`role`/membership in any profile response come from `users` / `project_collaborators` server-side, never from `user_profiles`. `PUT /profile` cannot set them. |
| **Role-badge forgery** | Role/system badges are render-time-derived from authoritative tables; `PUT /badges` drops non-catalog ids. |
| **Image abuse** | Magic-byte MIME, dimension caps, size caps, SVG rejected, stored outside workspaces under server UUIDs, served as forced non-executable `Content-Type` with `nosniff` + restrictive CSP, never as HTML. |
| **XSS** | `bio`, `display_name`, `location`, custom status `text`, link `label` — sanitized (C0/DEL stripped, length-capped) and rendered **text-only** (React children). No `innerHTML` / Markdown→HTML anywhere. `<script>`/`<img onerror>` payloads render literally (tested). |
| **URL abuse** | Links `https://` only, length-capped, `javascript:`/`data:` rejected, `github` kind host-locked to `github.com`; rendered with `rel="noopener noreferrer nofollow"` `target="_blank"`. |
| **Accent / effect injection** | Accent = enum or one contrast-checked `#rrggbb`; effect = enum. Never a CSS string. |
| **Privacy vs security** | Privacy flags gate presentation fields only; a documented hard invariant keeps identity/role/authorization/presence visible to authorized collaborators. No flag changes a server authorization check. |
| **Cross-user isolation** | `PUT /users/me/*` only ever writes the session user's rows; `/users/:id/*` GETs are privacy-filtered relative to the requester and require a shared project (or self). Featured projects / media ids that aren't the user's are dropped. |
| **DoS** | All fields bounded; ≤6 badges / ≤5 links / ≤8 featured / 1 avatar / 1 banner; upload + write rate-limited; `profiles` bundle is O(members), cached client-side, refreshed on a throttled ping. |
| **Custom status expiry** | Server clamps `expires_at` ≤ 24 h; a periodic sweep (mirrors M60's purge timer) clears expired rows and emits `profile_event`. The client also hides an expired status defensively. |

---

## 7. Cross-track integration points

| Integration | Behavior |
|---|---|
| **Comment author rows** use `<CollaboratorAvatar>` / `<CollaboratorName>` (Track C) | one identity model |
| **Mention chips** render the mentioned user's display name + accent (Track C) via `IdentityStore` | consistent identity |
| **`accessibility.motion` (B)** gates M58 pulses, M59 follow transitions, **and** Track C profile effects | one motion switch |
| **`collaboration.*` presentation toggles (B)** control remote cursors/labels/comment-indicator visibility for the viewer only | presentation, not security |
| **Theme/accent (B)** and **profile accent (C)** are distinct: B = my whole-IDE view; C = how *my* identity tints for *everyone* | documented, non-overlapping |
| **M60 timeline** gains `comment` events (A) and its actor cells use `<CollaboratorName>` (C) | history stays coherent |
| **`WhileYouWereAway` (M60)** gains a "N mentions" grouping (A) | reuse, not a new surface |
| **Profile "Recent history"** (C, privacy-gated) renders M60 `queryTimeline` filtered to that user | reuse, read-only |

---

## 8. Server-authoritative / client-derived / ephemeral / historical — the final map

**SERVER-AUTHORITATIVE (SQLite, REST, session identity):**
comment threads/replies/mentions/reactions/resolution/tombstones and their
persisted anchors; `anchor_status` last-report; `user_settings` blob;
`user_profiles` (incl. privacy flags) / `user_custom_status` /
`profile_media` / `user_badges` / `user_links` / `user_featured_projects`;
the user-selectable badge catalog; every authorization decision
(`requireProjectAccess`, role, membership); `userId` / `username` / `role`
in every identity payload.

**CLIENT-DERIVED (React, CSS tokens, localStorage):**
theme / accent / density / motion / layout sizes / local editor prefs /
collaboration presentation toggles / notification-surface visibility;
**anchor resolution** (RelativePosition → Monaco position, stale
classification, fingerprint recovery); comment marker/widget/popover
rendering; settings search; live setting + profile preview; the
`<CollaboratorAvatar/Name/Card>` rendering and the `IdentityStore` cache.

**EPHEMERAL REALTIME (`MESSAGE_CUSTOM`, room-scoped, receive-only):**
M57 presence, M58 attention, M59 focus — **unchanged**; new receive-only
pings `comment_event` (broadcast), `comment_mention` (targeted),
`profile_event` (broadcast). None carry authoritative data — they trigger a
REST refetch.

**HISTORICAL (M60 `timeline.ts`, append-only, derived):**
`comment` lifecycle events as a 5th union source (created / replied /
resolved / reopened); nothing else added; `queryWhileAway` gains `comment`.

This separation is asserted by tests: no comment/profile authorization
lives client-side; no setting maps to authz; no ephemeral frame is trusted
as authoritative; the timeline never double-counts.

---

## 9. Testing strategy

Behavioral, deterministic (fake timers + explicit injection; no sleeps). A
reverted essential change must fail a test.

### 9.1 Track A — anchors (`frontend/test/comment.anchor.*`, pure + Yjs integration)

Real `Y.Doc` + `Y.Text`, two simulated clients where concurrency matters:

1. insert lines **above** the anchor → resolved position shifts down by
   exactly that many lines; state `exact`.
2. edit **inside** the anchored range (same length) → still `exact`;
   changed length → `drifted`, no warning.
3. delete lines **around** (not through) the anchor → position tracks.
4. delete the **entire** anchored range → both ends resolve to the same
   collapsed point or `null` → `stale` (never silently on the next line's
   code).
5. **concurrent** collaborator edit above the anchor (real
   `y-protocols/sync` between two docs) → converges, anchor still correct.
6. **reconnect** (new Yjs clientID, re-sync from server state) → decoded
   RelativePosition still resolves to the same logical position.
7. **save / reload** (fresh `Y.Doc` seeded from the same text) → resolves.
8. file **replaced wholesale** (delete all + insert different) → `null` →
   `stale`; fingerprint recovery: stored slice fuzzy-matches the moved
   code → `[Find nearby context]` offers the right line; **anchor not
   auto-rewritten**.
9. malformed / truncated anchor blob → resolve returns `null` → `stale`,
   no throw.
10. **never jumps to unrelated code**: a mutation that makes the anchor
    ambiguous → `stale`, asserted the marker is absent from the editor and
    present only in the panel with the warning.

### 9.2 Track A — comments (`backend/test/m61-comments.test.ts`, real routes + in-memory DB)

create / reply / edit (author-only; non-author → 403) / delete (author or
owner → tombstone; other → 403; replies survive) / resolve / reopen
(idempotent); reply-to-reply flattens to root; mention validation
(cross-project id dropped, non-member dropped, valid persisted + delivered
to a connected target only); reaction fixed-set enforced, PK dedupe,
toggle-off; `body` size + sanitization (`<img onerror>` stored/returned
literal); rate limit (31st write → 429); project isolation (`GET
/comments` for a non-member → 404; project B room never gets project A's
`comment_event`); `comment_event` receive-only + forge-proof (a client
frame of that type is ignored); callout→comment creates a new row and does
**not** mutate the M58 event; `queryTimeline` emits exactly the 4 comment
lifecycle kinds and nothing on keystroke/edit/reaction; `queryWhileAway`
includes `comment`; migration v11→v12 (three assertions in
`migrations.test.ts`).

### 9.3 Track A — frontend (`frontend/test/Comments.*`, `Editor.comments.*`)

gutter marker at `anchor_start_line`; `💬 N` with replies; hover widget
text is `textContent`; thread popover renders root+replies ordered,
edited/deleted states, reaction chips; reply composer `@` autocomplete
lists only project members; resolve → thread leaves the active view,
appears under "Resolved (N)", reopen → returns; navigation command jumps
via `openAndRevealLocation` (closed-file spy-order: open before reveal);
`comment_event` triggers a throttled refetch; unauthorized user's client
never renders another project's comments.

### 9.4 Track B (`frontend/test/settings.*`)

registry: every id has a `default`, `validate`, `apply`; `validate`
rejects out-of-range / wrong-type; **reset round-trip** for every id.
Store: scope precedence (`session > workspace > global > default` with a
crafted conflict); `set` → `apply` called once, no global re-render (spy);
`resetCategory` / `resetAll`. Search: "cursor" returns Editor·Cursor +
Collaboration·Remote cursors (asserts it reads the registry, not the DOM —
a hidden setting still matches). Migrations: v1→v2 reshape; a newer-version
blob → unknown keys dropped, no crash. Import: valid applies; oversized /
too-many-keys / unknown-key / bad-enum / bad-hex / non-JSON all rejected or
dropped with the rest applied; keyboard conflict entry dropped. Theme:
`apply` sets `data-theme`; density sets `data-density` and real spacing
changes (computed style assertion); accent hex contrast-reject. Keyboard:
`parseChord`/`matchChord`/`formatChord`/`chordConflict` matrix; rebinding
updates dispatch; conflict blocks save; reset restores defaults; the
refactored `useKeyboardShortcuts` fires the same commands as before for the
default map (regression). Accessibility: `accessibility.motion = reduced`
sets `data-motion` **and** the context flag; M58/M59/profile-effect
consumers read it and disable (asserted at each). Notifications: `muted`
hides the tray card but a spy confirms the M60/audit write still happens.
Layout: slider clamps to min/max; "Reset layout" restores.

### 9.5 Track C (`backend/test/m61-profile.test.ts`, `frontend/test/Profile.*`)

**Backend:** profile PUT per-field validation (display name ≤64, bio ≤400
sanitized, pronouns/location caps); username unchanged (not a profile
field); custom status expiry clamp ≤24 h + sweep clears + emits
`profile_event`; badge authorization (non-catalog id dropped; role badge
never writable; role badge render derived from `users`/`collaborators`);
badge count cap 6, reorder; featured-project selection (non-owned/non-collab
dropped; cap 8); link validation (`https` only, `javascript:` rejected,
`github` host-locked, cap 5); privacy flags filter `GET /users/:id/profile`
and `/projects/:id/profiles` (location/links/history hidden when off;
`userId`/`username`/`role` **always** present — the hard invariant);
`profile_visibility = private` → 404 for non-self on the page, but the
`/projects/:id/profiles` card still carries essential identity; avatar
upload — PNG/JPEG/WebP by magic bytes accepted, `text/html`-declared PNG
accepted (declared type ignored), actual HTML rejected, **SVG rejected**,
oversized rejected, over-dimension rejected, truncated rejected; served
with forced `Content-Type` + `nosniff` + CSP; replace unlinks the old
file; path-traversal in any field impossible (UUID filenames, fixed dir);
cross-user isolation (`PUT /users/me/*` only writes the session user;
another user's media id dropped); profile import re-validation (every field
class); migration v1→v2; XSS payloads in every text field stored/returned
literal; `PROFILE_*` audit events written with `sanitizeDetails`.

**Frontend:** `IdentityStore` hydrates from `/projects/:id/profiles`,
refreshes on `profile_event` (throttled); `<CollaboratorAvatar>` shows
image then falls back to initials+accent on error; `<CollaboratorCard>`
shows banner/badges/custom-status + **live** activity from the presence
array (not a second store); profile editor **live preview** updates on
every field change before save (avatar, banner, accent, status, badges,
bio, privacy); reduced-motion disables `pulse` effect; another user's
accent choice tints **only their** surfaces (a test renders two cards and
asserts the local user's card is unaffected); remote cursor label stays
name-only.

### 9.6 Regression (all workstreams — run at every gate)

Full M57 / M58 / M59 / M60 suites, `m4-collab` concurrent-convergence,
`collab-awareness-security`, `Editor.eol`, `Editor.viewstate`,
`migrations.test.ts` (updated to v12) — green. Yjs convergence unchanged
with comment + profile traffic interleaved. `useKeyboardShortcuts`
refactor: existing shortcut behavior unchanged for the default map.
Existing `SettingsModal` callers migrated; `GET/PUT /api/auth/preferences`
still works (projection). No new lint warnings; backend + frontend `tsc`
clean; `vite build` exit 0.

### 9.7 Performance proofs (M61-D — a dedicated test file per package)

Each is a revert-failing assertion, not a benchmark:

1. **No profile write touches Yjs / awareness** — a `PUT /users/me/profile`
   spied against `room.doc.transact` and `awareness.setLocalState` → 0
   calls; `doc.share` size unchanged.
2. **No profile data in awareness** — inspect the authoritative awareness
   state after a profile change: no `avatar`, `banner`, `bio`, `badges`,
   `customStatus` keys (custom status included — decision §13.6).
3. **No comment persistence on the typing hot path** — `Y.Text` edits with
   an open thread on the file → 0 comment-table writes; comments persist
   only on explicit submit.
4. **A settings change does not re-render the whole IDE** — `set("editor.
   fontSize", …)` → a render spy on `IDE` / `Sidebar` / `TeamPanel` shows 0
   re-renders; only the Editor's `updateOptions` fires.
5. **`profile_event` / `comment_event` are invalidation, not broadcast** —
   assert the wire frame is a fixed small shape (`{type, userId}` /
   `{type, threadId, filePath, kind, at}`) carrying no profile/comment body.
6. **IdentityStore updates are scoped** — a `profile_event` for user X →
   only X's entry refetched; other entries untouched; subscribers for other
   users not notified.
7. **Comment refresh is scoped** — a `comment_event` for `a.ts` → only
   `a.ts` threads refetched.
8. **No polling loops** — grep the M61 frontend for `setInterval` → only
   the allowed ones (relative-time tickers, already bounded); no fetch on a
   timer.
9. **No unbounded local history** — the comment store keeps threads only
   for open files (evicted on close); the mention-card list is capped (≤10);
   the IdentityStore is bounded by project membership.

### 9.8 Adversarial security sweep (M61-D — `m61-security.test.ts` per package)

**Comments:** spoofed `author`/`userId` in the body ignored; forged
`project_id` → 404; forged mention target (cross-project / non-member /
arbitrary) dropped; `<script>` / `<img onerror>` / `[x](javascript:)` in
`body` render literally; oversized body → 400; unauthorized edit / delete /
resolve → 403; cross-project read → 404; a malformed / hostile anchor blob
→ `stale`, never an exception, never unrelated code.

**Profile:** spoofed identity in `PUT` ignored; `PUT /users/me/*` cannot
write another user's rows; `admin` / role badge id in `PUT /badges`
dropped; featured project the user cannot access dropped; `javascript:` /
`data:` / non-`github.com`-for-`kind:github` URL rejected; SVG / HTML-as-PNG
/ oversized / over-dimension / truncated image rejected; path traversal in
any field impossible (UUID filenames, fixed dir, `..` in `display_name`
etc. is just text); arbitrary CSS / HTML / token map in any profile field
impossible (enums + validated hex only); imported profile JSON
re-validated per field, hostile values dropped.

**Settings:** invalid value → rejected/clamped; unknown key → dropped;
oversized import (> 64 KiB) / > 300 keys → rejected; malformed JSON →
rejected; no value is ever CSS / code / a token map; no setting id maps to
an authz concept (asserted against a banned-substring list);
`user_settings.data` only readable by its owner.

---

## 10. Browser / multi-session acceptance (Docker + `claude-in-chrome` when connected; else a headless multi-client script — reported PARTIAL for visual)

### 10.1 Comments (two authenticated sessions, same project)

1. A selects code in `auth/session.ts` L40–52 → **Comment** → types →
   submit.
2. B sees the gutter marker + panel entry **immediately** (`comment_event`
   → refetch).
3. B opens the thread, **replies**.
4. A sees the reply.
5. B **@mentions** A in a reply.
6. A's "Attention & Mentions" tray shows the mention card; `[Go to
   comment]` opens the file + thread.
7. A adds a 👍 **reaction**; B sees the count.
8. A **resolves** → the thread leaves both clients' active view, shows
   under "Resolved (N)".
9. A **reopens** → returns.
10. A edits code **above** the anchor (inserts 10 lines) → the marker
    tracks to the new line on both clients; state `exact`.
11. A **replaces the whole function body** → the thread goes **explicitly
    stale** (`⚠ Original code location changed`, `[Find nearby context]`),
    never silently on unrelated code.
12. B navigates from the panel roll-up to an unresolved thread in another
    file.
13. A non-member session gets **404** on `GET /comments` and never renders
    the discussion.
14. Callout promotion: A creates an M58 callout → `[Keep as comment]` → a
    persistent comment appears; the callout still expires on its own TTL.

### 10.2 Customization (one session)

1. Open Settings (`Ctrl/Cmd+,`).
2. Search **"cursor"** → hits in Editor + Collaboration.
3. Toggle **Remote cursors** off → remote carets disappear live.
4. Change **Density** → spacing visibly tightens/loosens with no reload.
5. Change **Theme** → palette updates instantly.
6. Change **Collaborator labels** to "Hover" → TeamPanel/label behavior
   updates.
7. Rebind a shortcut; create a conflict → save blocked with a warning;
   resolve → saved.
8. **Reset section** (Appearance) → defaults return.
9. **Export** settings → JSON downloads; edit an out-of-range value;
   **Import** → that value is clamped/dropped, the rest applies.
10. Reload → theme / density / accent / shortcuts persist (server blob);
    panel widths persist (workspace).
11. Set `accessibility.motion = reduced` → M58 attention pulse + a profile
    `pulse` effect both go still.

### 10.3 Profile (two sessions)

1. Open **Edit my profile**.
2. Upload an **avatar** (PNG) → preview updates immediately; the avatar
   stack + TeamPanel update after save.
3. Set a **banner** gradient → preview updates.
4. Set **profile accent** to a custom hex (passes contrast) → preview
   tints; a failing hex is rejected inline.
5. Set a **custom status** `🐳 Building CloudIDE`, expiry 1 h → shows on
   the card; distinct from the live "Editing …" activity line.
6. Add + **reorder badges**.
7. Edit **bio**; add a **GitHub link** (`javascript:` rejected).
8. Toggle **"show location" off**.
9. Save; **reload** → everything persists.
10. Session B opens A's **collaborator card** → sees avatar, banner,
    badges, custom status, **live** activity/file; **location is hidden**
    per A's privacy; `userId`/name/role always visible.
11. B's `accessibility.motion = reduced` → A's profile `pulse` renders as
    a static glow on B's screen.
12. A's accent choice does **not** change how B's own card renders.
13. Upload an **SVG** as avatar → rejected. Upload HTML renamed `.png` →
    rejected (magic bytes).

### 10.4 Cross-system (M61-D — two sessions, after A/B/C gates)

1. A's **profile** (avatar, name, custom status) shows in B's collaborator
   card / avatar stack / popover.
2. B's card also shows A's **live activity + current file** — visibly
   *separate* from the custom status line.
3. A comments on code → the comment's **author row uses the same identity**
   (avatar + accent + name) as the collaborator card.
4. A **@mentions** B → the mention chip + tray card render B's identity
   from the same `IdentityStore`.
5. The **ActivityTimeline** row "A commented on …" uses the same identity.
6. A changes their avatar → `profile_event` → B's card + comment rows +
   timeline actor **all update** without a reload, **without any Yjs /
   awareness / document change**.
7. A changes **presence** (opens a different file) → B sees the activity
   line update **without** any profile mutation.
8. Project **authorization is unchanged** throughout — a non-member still
   gets 404 on comments and profiles; roles still gate editing.
9. **Attention → comment**: an M58 "Come look here" whose target opens a
   comment thread and focuses the exact anchored code (M58 + M59 + M61-A
   composed).
10. `accessibility.motion = reduced` (B) stills M58 pulses **and** A's
    profile `pulse` effect **and** comment marker transitions on B's screen.

---

## 11. Explicit non-goals (M61)

Generic chat / DMs; social profiles beyond a project's collaborators;
global friend/follow system; profile discovery / directory / marketplace;
AI-generated comments / summaries / status; semantic conflict resolution;
full team analytics; raw terminal / stdout / stderr sharing or broadcast;
arbitrary custom JavaScript, CSS, HTML, or SVG in themes / settings /
profiles; a user-editable token map ("advanced theme editor"); uploaded
badge art; a GitHub replacement (featured projects are cards + links, not
repos); browser Notification API / sound (no infra — enum leaves room);
"invisible mode" / hiding presence from authorized collaborators; a second
WebSocket endpoint; a second presence / collaborator / identity store; a
second upload pipeline; a second design system; widening the `users` table.

---

## 12. Risks / tradeoffs

| Risk | Likelihood | Mitigation |
|---|---|---|
| RelativePosition edge cases silently mis-anchor a comment | Medium | Dual-signal (RelativePosition + fingerprint); `null` → explicit stale; test matrix §9.1 incl. "never on unrelated code"; `[Find nearby]` never auto-rewrites. |
| M61 is three subsystems — scope blowout | High | Strict phasing (A verified before B before C); shared primitives built once; non-goals §11; each track has its own test file + acceptance block; the plan checkpoints per phase with rollback. |
| Awareness payload bloat from profile data | Medium | Profile data travels over REST (`/projects/:id/profiles`) + a throttled `profile_event` ping, **not** in awareness. Custom-status mirror into awareness is optional and bounded. |
| Profile image upload as an attack surface | Medium | Magic-byte MIME, dimension/size caps, SVG rejected, stored outside workspaces under UUIDs, served forced-type + `nosniff` + CSP, never HTML, rate-limited, single pipeline. |
| A privacy flag is read as a security control | Medium | Hard invariant §6.8 + tests: identity/role/authz/presence never hidden; privacy gates presentation fields only; no flag touches a server authz check. |
| The settings blob becomes a dumping ground / desyncs from the registry | Medium | Client validates every key against the registry on load + import; unknown keys dropped; 32 KiB / 200-key server cap; versioned migrations in one file. |
| Keyboard refactor perturbs existing shortcuts | Low | Registry defaults mirror today's chords exactly; regression test fires the same commands for the default map; dispatch path unchanged. |
| Comment `comment_event` refetch storm under heavy editing | Low | The frame is a throttled/deduped invalidation ping (~250 ms), not data; refetch is one scoped `GET` per file; mirrors the M60 `collab_change` cadence which is proven. |
| Landing on the uncommitted M57–M60 tree | Certain | M61 is new files + additive branches + one migration; the diff stays separable; do not revert M57–M60. |
| Theme migration (`:root` → `[data-theme]`) breaks a component using a raw color | Medium | Enumerate raw-color / hard-coded-px components in the plan; migrate them to tokens as part of the density/theme task; visual regression pass in acceptance. |
| `user_preferences` → `user_settings` migration drops a user's editor prefs | Low | v12 migration copies the 7 rows verbatim into the blob; `GET /preferences` projection keeps compat; tested with a seeded pre-v12 DB. |

---

## 13. Resolved decisions (repository/architecture-determined or ratified)

1. **Comments panel placement** — a collapsible section in the right rail
   stacked with TeamPanel (not a new floating panel).
2. **Gutter-marker default visibility** — active, non-stale threads only;
   resolved/stale visible when the Comments panel is open or via a per-file
   toggle.
3. **`user_preferences` retirement** — fold into `user_settings` at v12,
   keep the endpoint projection one milestone, drop the table in M62.
4. **Reaction set** — fixed `👍 👎 🎉 👀 ❤️ 🚀`.
5. **Anchor recovery** — SHA-256 first 16 hex of the ≤256-char
   whitespace-collapsed anchored slice for drift detection; the slice text
   itself (`anchor_prefix`) stored for fuzzy recovery; recovery match
   threshold ~0.8; **never auto-jump on weak similarity, never silently
   rewrite the anchor.**
6. **Custom status is NOT mirrored into Yjs awareness.** It is durable
   profile state (`user_custom_status`) delivered via the
   `/projects/:id/profiles` bundle + a `profile_event` invalidation ping,
   and combined with ephemeral M57 presence **client-side** in
   `<CollaboratorCard>`. Rationale: profile status is durable, presence is
   ephemeral, keeping them separate avoids a second synchronization source,
   and `profile_event` invalidation is sufficient. Revisit only on measured
   performance need in a future milestone.
7. **Built-in theme count** — 4 (`cloud-dark` default, `cloud-midnight`,
   `cloud-dim`, `cloud-light`).
8. **Banner preset catalog size** — ~8 CSS-defined gradient/texture presets.
9. **Profile persistence** — six tables, privacy folded into `user_profiles`
   (§6.3 persistence decision). Not seven, not one JSON blob.
10. **Comment anchor `anchor_prefix` column** — `comment_threads` stores the
    slice text (not only its hash) — a plan refinement over the spec's
    first draft; §6.3-style evidence: `fuzzyMatchSlice` needs the text.

---

## 14. Workstream structure & dependency graph

M61 ships as **four independently-gated workstreams**. Each has its own test
files, its own browser-acceptance block, and its own gate; execution can
stop cleanly after any gate with a green, shippable subsystem.

```
                    ┌─────────────────────────────────────────┐
                    │ M61-A · Contextual Comments             │
                    │  A1 migration v12 (ALL M61 tables)      │──┐
                    │  A2 comment/profile ping transport     │──┼──┐
                    │  A3 anchor math (pure)                  │  │  │
                    │  A4 comment validation (pure)          │  │  │
                    │  A5 comment DB store                    │  │  │
                    │  A6 comment REST                        │  │  │
                    │  A7 M60 timeline comment source        │  │  │
                    │  A8 fe comment api/store/client        │  │  │
                    │  A9 editor gutter markers + hover      │  │  │
                    │  A10 thread popover + composer         │  │  │
                    │  A11 panel + nav + callout→comment     │  │  │
                    │  ───────────────── A-GATE ─────────────│  │  │
                    └────────────────────────────────────────┘  │  │
   depends only on A1 ──────────────────────────────────────────┘  │
                    ┌────────────────────────────────────────┐     │
                    │ M61-B · IDE Customization              │     │
                    │  B1 shared control primitives          │     │
                    │  B2 token layer: theme/density/motion  │     │
                    │  B3 registry + keys + migrations (pure)│     │
                    │  B4 be user_settings store + routes    │     │
                    │  B5 SettingsStore + apply + api        │     │
                    │  B6 wire apply: appearance/editor/…    │     │
                    │  B7 keyboard refactor + rebind UI      │     │
                    │  B8 notifications + reduced-motion gate│     │
                    │  B9 Settings surface + export/import   │     │
                    │  ───────────────── B-GATE ─────────────│     │
                    └────────────────────────────────────────┘     │
   depends on A1 + A2 (profile_event transport) ───────────────────┘
                    ┌────────────────────────────────────────┐
                    │ M61-C · Profile Identity & Customization│
                    │  C1 badge catalog + validation (pure)  │
                    │  C2 media pipeline                      │
                    │  C3 profile DB store + buildPublicProfile│
                    │  C4 profile REST + media serve + sweep  │
                    │  C5 fe IdentityStore + api + client     │
                    │  C6 identity primitives (Avatar/Name/Card)│
                    │  C7 profile editor + live preview       │
                    │  C8 profile page (history + featured)   │
                    │  ───────────────── C-GATE ─────────────│
                    └────────────────────────────────────────┘
                         │        │        │
              A-GATE ────┴── B-GATE ──┴── C-GATE  (all three green)
                                 │
                    ┌────────────▼───────────────────────────┐
                    │ M61-D · Cross-system integration       │
                    │  D1 retrofit ALL collaborator surfaces │
                    │      to the identity primitives        │
                    │  D2 wire the seams: comment author ↔   │
                    │      identity, mention ↔ identity,     │
                    │      timeline actor ↔ identity,        │
                    │      notification gates on the A tray, │
                    │      reduced-motion → profile effects  │
                    │  D3 cross-system browser acceptance    │
                    │  D4 performance-proof test suite       │
                    │  D5 adversarial security sweep         │
                    │  D6 full regression + STATUS.md close  │
                    └────────────────────────────────────────┘
```

**Cross-workstream dependencies (the only ones):**
- **B → A1** (schema) and **A2** is *not* needed by B.
- **C → A1** (schema) + **A2** (the `broadcastProfileEvent` transport method).
- **D → A-GATE + B-GATE + C-GATE** (all frozen interfaces).
- Nothing in A depends on B or C. A ships with a **local initials-fallback**
  for comment-author avatars; D swaps in `<CollaboratorAvatar>`.
- B's reduced-motion functional gate wires into M58/M59 in B8; the
  **profile-effect** consumer is a no-op stub in B8 and becomes real in D2.
- B's `notification.mentions/comments` gates: the A11 tray shows mention
  cards unconditionally until D2 adds the gate.

**A gate = ** A's full test suite green + `m57/m58/m59/m60` regression green
+ Track-A browser acceptance (§10.1) PASS/PARTIAL recorded + these
interfaces **frozen**: `comment_event` / `comment_mention` wire shapes,
`CommentThreadDTO` / `CommentDTO`, the anchor payload
(`{relStart,relEnd,slice,startLine,endLine,prefixHash}`), the
`broadcast*Event` method signatures.

**B gate =** B's suite green + regression green + Track-B browser
acceptance (§10.2) recorded + frozen: `SettingDef<T>`, `SettingsStore`
public API, `useSetting` / `useSettingFlag`, the `motion.reduced` flag key,
`GET/PUT /api/auth/settings` shape, `CURRENT_SETTINGS_VERSION`.

**C gate =** C's suite green + regression green + Track-C browser
acceptance (§10.3) recorded + frozen: `PublicProfile` shape, `IdentityStore`
public API, `profile_event` wire shape, `<CollaboratorAvatar/Name/Card>`
props, `GET /api/projects/:id/profiles` bundle shape.

**D gate =** cross-system acceptance (§10.4) + performance proofs (§9.7) +
adversarial security sweep (§9.8) + full M57–M60 + Yjs + EOL regression +
STATUS.md `## Milestone 61` written. **M61 CLOSED.**

---

## 15. Spec / plan paths

- Spec (this file):
  `docs/superpowers/specs/2026-08-31-m61-contextual-comments-customization-design.md`
- Plan:
  `docs/superpowers/plans/2026-08-31-m61-contextual-comments-customization.md`

The plan is organized as the four workstreams above, test-first, each task:
files · dependencies · frozen-interface block · failing test (with the exact
revert-failing behavior) · implementation · verification command ·
checkpoint · rollback. Parallelize only genuinely independent tasks whose
interfaces are already fixed (the pure modules — anchor math, comment
validation, `settings/keys.ts`, badge catalog, profile validation — and
their tests).
