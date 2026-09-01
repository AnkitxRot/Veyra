# M61 — Contextual Collaboration + Deep User Customization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three connected product systems on the M57–M60 collaboration stack as **four independently-gated workstreams** — (A) persistent code-anchored comment threads with resilient Yjs-aware anchors, (B) a typed setting registry + token-driven theme/layout/editor/accessibility customization, (C) a server-authoritative user-profile/identity layer, (D) cross-system integration wiring one identity model through every collaborator surface + full regression + browser verification.

**Architecture:** Additive — one SQLite migration (v12) creating all M61 tables, new REST under `/api/projects/:id/comments`, `/api/auth/settings`, `/api/users/me/*`, `/api/projects/:id/profiles`, three receive-only `MESSAGE_CUSTOM` invalidation pings (`comment_event`, `comment_mention`, `profile_event`), and new frontend modules. **No new WebSocket endpoint, no new document-sync mechanism, no second presence/collaborator/identity store, no second design system, no profile data in Yjs awareness.** Comment anchors are `Y.RelativePosition` blobs stored server-side and resolved client-side against the live `Y.Text`. Preferences persist as a versioned per-user JSON blob (server) + namespaced `localStorage` (workspace). Profile identity is fetched per-project over REST, cached in one `IdentityStore`, invalidated by `profile_event`, and combined with M57 presence client-side.

**Tech Stack:** TypeScript, Express, `node:sqlite` (`DatabaseSync`), `ws`, Yjs + `y-monaco`, React 18 + Vite, Monaco, Vitest. **Zero new runtime dependencies.**

**Spec:** `docs/superpowers/specs/2026-08-31-m61-contextual-comments-customization-design.md` — the plan argues from the spec; executors read both. Workstream structure + dependency graph: spec §14. Testing: spec §9 (incl. §9.7 performance proofs, §9.8 adversarial security). Browser acceptance: spec §10 (§10.1 A, §10.2 B, §10.3 C, §10.4 cross-system).

## Global Constraints

- **No new dependencies.** `yjs` is already a direct dep of both packages: use `Y.createRelativePositionFromTypeIndex`, `Y.encodeRelativePosition`, `Y.decodeRelativePosition`, `Y.createAbsolutePositionFromRelativePosition`. Hashing: `node:crypto` (backend) / `crypto.subtle` (frontend).
- **One migration: v12.** All M61 tables land in a single `MIGRATIONS` entry + the inline `openDb` schema (task A1). `backend/test/migrations.test.ts` hard-asserts `.toBe(11)` and the `[1..11]` list in **3 places** — all become `12` / `[1..12]`.
- **Server is the only identity/authorization authority.** Every route: `requireProjectAccess(db, userOf(req).id, req.params.id, minRole)` (comments/profiles-bundle) or `requireAuth(db)` (settings/own-profile). Actor identity is `userOf(req)` / `req.user!.id` — **never** a body field. All timestamps server-set (`datetime('now')`).
- **Receive-only pings.** `comment_event` / `comment_mention` / `profile_event` are authored **only** by the server (mirror `broadcastCollabChange`). The client shape-guards and never sends them. They carry **no authoritative data** — a fixed small shape that triggers a scoped REST refetch. `comment_event = {type, threadId, filePath, kind, at}`; `comment_mention = {type, threadId, commentId, filePath, line, author:{userId,username}, preview, at}`; `profile_event = {type:"profile_event", userId}`.
- **Text-only rendering everywhere.** `body`, `bio`, `display_name`, `location`, custom-status `text`, link `label`, previews — sanitized (strip C0/DEL except `\n\t`, length-cap, trim) and rendered as React children / `textContent`. Never `innerHTML`, `dangerouslySetInnerHTML`, Markdown→HTML. XSS payloads render literally (tested per surface).
- **No arbitrary code/CSS/HTML/SVG.** Theme/accent/density = enums + one contrast-checked `#rrggbb`. Profile effect/banner-kind = enums. Badges = server catalog only. Import re-validates every value; unknown keys dropped; size + key-count capped.
- **Privacy ≠ security.** A Track C privacy flag hides presentation fields only. `userId` / `username` / `role` / project membership / presence are **never** hidden from an authorized collaborator; no flag changes a server authz check.
- **Custom status is NOT mirrored into Yjs awareness** (spec §13.6). It is durable `user_custom_status`, delivered via the `/projects/:id/profiles` bundle + `profile_event`, combined with M57 presence client-side in `<CollaboratorCard>`.
- **Hand-synced types.** `frontend/src/types.ts` mirrors backend wire types (repo convention). Keep the M61 section in sync as you go.
- **Verification per task:** backend `cd backend && npx vitest run <file>` + `npm run typecheck`; frontend `cd frontend && npx vitest run <file>` + `npm run build`. Docker-dependent tests auto-skip without Docker.
- **Commit after every green task** on a feature branch. **Do not commit to `master`; do not push; do not merge** — accumulate on the branch for the user's review (repo rule).
- **Workstream order & gates (spec §14):** M61-A → A-GATE → M61-B → B-GATE → M61-C → C-GATE → M61-D. B depends only on A1. C depends on A1 + A2. D depends on A-GATE + B-GATE + C-GATE. Within a workstream, pure modules + their tests may be parallelized once their interface block is fixed. Each `*-GATE` task freezes the listed interfaces and records browser acceptance; execution may stop cleanly at any gate.

---

## File Structure

### Backend (new)

| File | Workstream | Responsibility |
|---|---|---|
| `backend/src/comments/validate.ts` | A | Pure: `sanitizeCommentBody`, `parseMentionIds`, `EMOJI_SET`/`isEmoji`, `isAnchorPayload`, `COMMENT_MAX_LEN`. No `Db`. |
| `backend/src/comments/store.ts` | A | DB layer: `createThread`, `addReply`, `editComment`, `tombstoneComment`, `resolveThread`, `reopenThread`, `listThreadsForFile`, `listUnresolved`, `setThreadAnchorStatus`, `replaceMentions`, `upsertReaction`/`removeReaction`. Takes `Db` first, returns plain rows. |
| `backend/src/comments/routes.ts` | A | `registerCommentRoutes(router, db, cfg)` — REST; wires store + validate + `requireProjectAccess` + rate limiter + `broadcastCommentEvent` + audit. |
| `backend/src/comments/timelineSource.ts` | A | `queryCommentTimeline(db, projectId, {limit, before, since})` → `TimelineEvent[]` for the 4 lifecycle kinds. |
| `backend/src/settings/store.ts` | B | `getUserSettings(db, userId)` / `putUserSettings(db, userId, {version, data})` (32 KiB / 200-key caps, JSON-parse check) + legacy `user_preferences` ↔ `user_settings` projection helpers. |
| `backend/src/settings/routes.ts` | B | `GET/PUT /api/auth/settings`; the `/api/auth/preferences` compat projection. |
| `backend/src/profile/badges.ts` | C | Pure: `USER_BADGE_CATALOG`, `isGrantableBadge`, `roleBadgesFor`. |
| `backend/src/profile/validate.ts` | C | Pure: field caps, enum sets, `sanitizeProfileText`, `isHttpsUrl`, `GITHUB_HOSTS`, `isHex6`, `contrastOk`, `clampStatusExpiry`. |
| `backend/src/profile/media.ts` | C | `parseImage`, `validateImage`, `storeMedia`, `mediaPathFor`, `deleteMedia`. Reuses `parseMultipartFormData`. |
| `backend/src/profile/store.ts` | C | DB layer for `user_profiles` (incl. privacy), `user_custom_status`, `user_badges`, `user_links`, `user_featured_projects`, `profile_media`. |
| `backend/src/profile/publicProfile.ts` | C | `buildPublicProfile(db, targetId, viewerId, projectId?)` — privacy-filtered; identity copied from `users`/`project_collaborators`. |
| `backend/src/profile/routes.ts` | C | `registerProfileRoutes(router, db, cfg)` — `/api/users/me/*`, `/api/users/:id/*`, `/api/projects/:id/profiles`, media upload/serve. |

### Backend (modified)

| File | Workstream | Change |
|---|---|---|
| `backend/src/db.ts` | A1 | v12 migration + inline schema for **all** M61 tables (spec §4.3 + §6.3) + the `user_preferences → user_settings` copy loop. |
| `backend/src/collab/manager.ts` | A2 | `broadcastCommentEvent`, `sendCommentMentionTo`, `broadcastProfileEvent` on `CollaborationRoom` + delegates on `CollaborationManager` (next to `broadcastCollabChange`). |
| `backend/src/collab/timeline.ts` | A7 | Add comment source to `queryTimeline` union; `TimelineEvent.kind + "comment"`; `MEANINGFUL_KINDS.add("comment")`. |
| `backend/src/audit.ts` | A6/C4 | `AuditEventType + "COMMENT_ADDED" | "COMMENT_RESOLVED" | "PROFILE_UPDATED" | "PROFILE_MEDIA_UPLOADED"`. |
| `backend/src/config.ts` | A6/C4 | `commentWriteMax`, `commentWriteWindowMs`, `profileMediaAvatarMaxBytes`, `profileMediaBannerMaxBytes`, `customStatusMaxMs`, `customStatusSweepMs`, `profileMediaDir` via `boundedIntEnv`/`join(dataDir,…)`. |
| `backend/src/app.ts` | A6/B4/C4 | Register comment/settings/profile routers; `express` route to serve profile media; start the custom-status expiry sweep. |
| `backend/src/index.ts` | C4 | Clear the sweep timer in graceful shutdown. |
| `backend/src/auth/routes.ts` | B4 | Mount settings routes; `/preferences` GET/PUT proxy into `user_settings`. |
| `backend/test/migrations.test.ts` | A1 | v11→v12 (3 assertions) + a v12-table-exists test. |

### Frontend (new)

| File | Workstream | Responsibility |
|---|---|---|
| `frontend/src/comments/anchor.ts` | A | Pure: `encodeAnchor`, `resolveAnchor`, `fingerprint`, `fuzzyMatchSlice`, offset↔position helpers. |
| `frontend/src/comments/api.ts` | A | Comment REST client. |
| `frontend/src/comments/store.ts` | A | `CommentStore` — per-file threads; `applyEvent` → throttled scoped refetch. |
| `frontend/src/components/Comments/mentionText.tsx` | A | Pure render helper: split `body` into text + `@username` spans against a known-username set. |
| `frontend/src/components/Comments/CommentGutter.tsx` | A | Editor decoration collection: markers + range tint + hover widget. |
| `frontend/src/components/Comments/CommentComposer.tsx` | A | Textarea + `@` autocomplete; shared by new-thread and reply. |
| `frontend/src/components/Comments/CommentThread.tsx` | A | Thread popover: root + replies + composer + reactions + resolve/reopen. |
| `frontend/src/components/Comments/CommentsPanel.tsx` | A | Right-rail section: current-file threads + unresolved roll-up. |
| `frontend/src/hooks/useFocusTrap.ts` | A | Small first/last-tabbable focus-trap hook (if not already present). |
| `frontend/src/settings/contrast.ts` | B | WCAG relative-luminance ratio + `contrastOk(hex, base)`. |
| `frontend/src/components/common/controls/{Switch,Segmented,Slider,ColorField,Select}.tsx` + `index.ts` | B | Shared setting/profile controls over `glass-*`. |
| `frontend/src/settings/registry.ts` | B | `SettingDef<T>`, `SETTINGS`, `getDef`, `allDefs`, `searchDefs`. |
| `frontend/src/settings/keys.ts` | B | Pure: `parseChord`, `formatChord`, `matchChord`, `chordConflict`. |
| `frontend/src/settings/migrations.ts` | B | `SETTINGS_MIGRATIONS`, `CURRENT_SETTINGS_VERSION`, `migrate`. |
| `frontend/src/settings/apply.ts` | B | `makeApplyContext` — `setCssVar`/`setRootAttr`/`updateMonacoOptions`/`setContextFlag` + `settingsContextEmitter` + `useSettingFlag`. |
| `frontend/src/settings/store.ts` | B | `SettingsStore` + `useSetting`. |
| `frontend/src/settings/api.ts` | B | `fetchSettings`, `putSettings`. |
| `frontend/src/components/Settings/SettingsSurface.tsx` | B | Two-pane portal (replaces `SettingsModal`). |
| `frontend/src/components/Settings/SettingRow.tsx` | B | One registry row → control + label + description + reset. |
| `frontend/src/components/Settings/KeyboardCategory.tsx` | B | Command list + rebind + conflict. |
| `frontend/src/collab/identity.ts` | C | `IdentityStore`, `PublicProfile`, `useIdentity(userId)`. |
| `frontend/src/profile/api.ts` | C | Profile CRUD + media upload. |
| `frontend/src/components/common/identity/{CollaboratorAvatar,CollaboratorName,CollaboratorCard}.tsx` + `index.ts` | C | The one identity model's render primitives. |
| `frontend/src/components/Profile/ProfileSurface.tsx` + section components | C | Profile editor (sections + live preview). |
| `frontend/src/components/Profile/ProfilePreview.tsx` | C | `<CollaboratorCard>` + popover from the unsaved draft. |
| `frontend/src/components/Profile/ProfilePage.tsx` | C | Read-only profile page (history + featured). |

### Frontend (modified)

| File | Workstream | Change |
|---|---|---|
| `frontend/src/types.ts` | A/B/C | `CommentThreadDTO`, `CommentDTO`, `CommentEventWire`, `CommentMentionWire`, `PublicProfileDTO`, `ProfileEventWire`, `SettingsExport`; `TimelineEventKind + "comment"`. |
| `frontend/src/collab/client.ts` | A8 | `MESSAGE_CUSTOM` receive branches for `comment_event` / `comment_mention` / `profile_event` → `emit`. No author method. |
| `frontend/src/components/Editor/Editor.tsx` | A9 / B6 | Mount `<CommentGutter>`; `cloudide.comment.create` action; (B6) read editor settings from the store. |
| `frontend/src/components/IDE/IDE.tsx` | A11 / B5,B9 / C5 / D | `CommentStore` + `IdentityStore` lifecycle; `SettingsStore.init` on boot; thread-popover host; `comment_event`/`comment_mention`/`profile_event` listeners; timeline refetch on `comment_event`; mount `SettingsSurface` + `ProfileSurface` + `ProfilePage`; `Ctrl/Cmd+,`. |
| `frontend/src/components/Collab/AttentionTray.tsx` | A11 / B8 / D | "Attention & Mentions" — `comment_mention` cards; (B8) `notification.*` gate stub → (D2) real. |
| `frontend/src/components/Collab/CollaboratorAvatarStack.tsx` | C6 (self-menu) / D1 | Self-menu → "Edit profile"; (D1) replace inline avatar rendering with primitives. |
| `frontend/src/components/Collab/TeamPanel.tsx` | A11 / D1 | Mount `<CommentsPanel>` sibling section; (D1) identity primitives. |
| `frontend/src/components/Collab/{FollowBanner,ActivityTimeline,WhileYouWereAway}.tsx` | D1/D2 | Identity primitives; `kind:"comment"` rows; "N mentions while away". |
| `frontend/src/hooks/useKeyboardShortcuts.ts` | B7 | Build the chord→command map from the registry; keep dispatch. |
| `frontend/src/components/Toolbar/Toolbar.tsx` | B9 | Gear → `ide-open-settings`. |
| `frontend/src/styles/tokens.css` | B2 | Palette tokens → `:root[data-theme]`; `data-density`, `--text-scale`, `data-motion`; 4 themes. |
| `frontend/src/styles/glass.css` | B1 | Append control classes (no new file). |
| `frontend/src/styles/collab.css` | A9/A10 | Comment marker / tint / widget / popover classes (reuse M58 patterns). |
| `frontend/src/monacoSetup.ts` | B2 | `defineTheme` for the 3 non-default Monaco themes. |
| `frontend/src/components/Settings/SettingsModal.tsx` | B9 | Deleted; update the 1 import site (`IDE.tsx`). |

---

# WORKSTREAM M61-A — Contextual Comments

*A ships fully standalone: comment-author avatars use a local initials fallback; D1 swaps in `<CollaboratorAvatar>`. A depends on nothing outside itself.*

### Task A1: Migration v12 — all M61 tables

**Files:**
- Modify: `backend/src/db.ts` (inline `openDb` schema + a `{ version: 12, … }` `MIGRATIONS` entry — SQL identical, `CREATE TABLE IF NOT EXISTS`; the v10/v11 pattern)
- Modify: `backend/test/migrations.test.ts` (`toBe(11)`→`12`; two `[1..11]`→`[1..12]`; add the table-exists + FK-cascade test)
- Test: `backend/test/migrations.test.ts`

**Interfaces — Produces (frozen for B, C):** the exact table set — `comment_threads`, `comments`, `comment_mentions`, `comment_reactions` (spec §4.3, **with `comment_threads.anchor_prefix TEXT NOT NULL`** — the ≤256-char slice text for fuzzy recovery, added immediately after `anchor_prefix_hash`); `user_settings` (`user_id` PK, `version` INT NOT NULL DEFAULT 1, `data` TEXT NOT NULL DEFAULT '{}', `updated_at`); `user_profiles` (spec §6.3, privacy folded in), `user_custom_status`, `profile_media`, `user_badges`, `user_links`, `user_featured_projects` + the listed indexes.

- [ ] **Step 1: Write the failing test** — in `migrations.test.ts`:

```ts
it("M61: v12 creates the comment, settings and profile tables with cascades", () => {
  const db = openDb(":memory:");
  expect(getSchemaVersion(db)).toBe(12);
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(t=>t.name);
  for (const t of [
    "comment_threads","comments","comment_mentions","comment_reactions",
    "user_settings","user_profiles","user_custom_status","profile_media",
    "user_badges","user_links","user_featured_projects",
  ]) expect(names).toContain(t);
  const fk = db.prepare("PRAGMA foreign_key_list(comments)").all() as {table:string,on_delete:string}[];
  expect(fk.find(r=>r.table==="comment_threads")!.on_delete).toBe("CASCADE");
  const cols = (db.prepare("PRAGMA table_info(comment_threads)").all() as {name:string}[]).map(c=>c.name);
  expect(cols).toContain("anchor_prefix");
  expect(cols).toContain("anchor_prefix_hash");
  const pcols = (db.prepare("PRAGMA table_info(user_profiles)").all() as {name:string}[]).map(c=>c.name);
  expect(pcols).toContain("profile_visibility");
  expect(pcols).toContain("show_location");
});
it("M61: v12 copies pre-existing user_preferences rows into user_settings.data", () => {
  // hand-build a v11 DB with a user + a user_preferences row (font_size 16), reopen via openDb,
  // assert JSON.parse(user_settings.data)["editor.fontSize"] === 16
});
```

Change the three existing assertions to `12` / `[1,2,3,4,5,6,7,8,9,10,11,12]`.

- [ ] **Step 2: Run — expect FAIL.** `cd backend && npx vitest run test/migrations.test.ts`
- [ ] **Step 3: Implement.** Append the full DDL (spec §4.3 + §6.3, all `IF NOT EXISTS`) to the inline `db.exec` block **and** the v12 `up()`. `comment_threads` columns:

```sql
CREATE TABLE IF NOT EXISTS comment_threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  anchor_rel_start BLOB, anchor_rel_end BLOB,
  anchor_start_line INTEGER NOT NULL, anchor_end_line INTEGER NOT NULL,
  anchor_prefix_hash TEXT NOT NULL,
  anchor_prefix TEXT NOT NULL,
  anchor_status TEXT NOT NULL DEFAULT 'ok',
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT, resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  root_comment_id TEXT NOT NULL
);
```

In the v12 `up()` only, after the `CREATE`s, add:

```ts
const legacy = db.prepare("SELECT user_id, font_size, tab_size, word_wrap, minimap, line_numbers, cursor_blinking, render_whitespace FROM user_preferences").all() as any[];
const ins = db.prepare("INSERT INTO user_settings (user_id, version, data) VALUES (?, 1, ?) ON CONFLICT(user_id) DO NOTHING");
for (const r of legacy) ins.run(r.user_id, JSON.stringify({
  "editor.fontSize": Number(r.font_size), "editor.tabSize": Number(r.tab_size),
  "editor.wordWrap": r.word_wrap, "editor.minimap": !!r.minimap,
  "editor.lineNumbers": r.line_numbers, "editor.cursorBlinking": r.cursor_blinking,
  "editor.renderWhitespace": r.render_whitespace,
}));
```

- [ ] **Step 4: Run — expect PASS.** Full `migrations.test.ts` + `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(m61-a): migration v12 — comment, settings, profile tables`

---

### Task A2: Comment / profile ping transport (server)

**Files:**
- Modify: `backend/src/collab/manager.ts` — 3 methods on `CollaborationRoom` + 3 delegates on `CollaborationManager`, next to `broadcastCollabChange`
- Test: `backend/test/m61-transport.test.ts` (real `CollaborationRoom` + the `makeWs()`/join harness from `m57-presence.test.ts`)

**Interfaces — Produces (frozen for A6, C4):**
- `CollaborationRoom.broadcastCommentEvent(ev: Record<string,unknown>): void` — `if (this.disposed) return`; `encodeCustom({type:"comment_event",...ev})` → every client `readyState===1`.
- `CollaborationRoom.sendCommentMentionTo(userId: number, ev): void` — filter `this.clients` by `s.userId === userId` (mirror `sendAttentionTo`), `encodeCustom({type:"comment_mention",...ev})`.
- `CollaborationRoom.broadcastProfileEvent(ev): void` — `encodeCustom({type:"profile_event",...ev})` to all.
- `CollaborationManager.broadcastCommentEvent(projectId, ev)` / `.sendCommentMentionTo(projectId, userId, ev)` / `.broadcastProfileEvent(projectId, ev)` → `this.rooms.get(projectId)?.…`

- [ ] **Step 1: Write the failing test:**

```ts
it("broadcastCommentEvent → every client; sendCommentMentionTo → target only", async () => {
  const room = makeRoom();
  const a = await joinWs(room, { userId: 1, username: "a", role: "editor" });
  const b = await joinWs(room, { userId: 2, username: "b", role: "editor" });
  room.broadcastCommentEvent({ threadId: "t1", filePath: "a.ts", kind: "created", at: 1 });
  expect(lastCustom(a).type).toBe("comment_event");
  expect(lastCustom(b).type).toBe("comment_event");
  room.sendCommentMentionTo(2, { threadId: "t1", commentId: "c1", filePath: "a.ts", line: 3, author: { userId: 1, username: "a" }, preview: "look", at: 2 });
  expect(lastCustom(b).type).toBe("comment_mention");
  expect(customFrames(a).some(f => f.type === "comment_mention")).toBe(false);
});
it("broadcastProfileEvent carries only {type,userId}", async () => {
  const room = makeRoom();
  const a = await joinWs(room, { userId: 1, username: "a", role: "editor" });
  room.broadcastProfileEvent({ userId: 7 });
  expect(lastCustom(a)).toEqual({ type: "profile_event", userId: 7 });
});
it("a client cannot author any of these frames (server ignores unknown MESSAGE_CUSTOM types)", async () => {
  const room = makeRoom();
  const a = await joinWs(room, { userId: 1, username: "a", role: "editor" });
  const b = await joinWs(room, { userId: 2, username: "b", role: "editor" });
  sendCustom(a, { type: "comment_event", threadId: "forged", kind: "created" });
  sendCustom(a, { type: "profile_event", userId: 999 });
  await tick();
  expect(customFrames(b).some(f => f.threadId === "forged" || f.userId === 999)).toBe(false);
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — copy `broadcastCollabChange`'s body 3×. `handleMessage`'s `MESSAGE_CUSTOM` branch already ignores unknown `type`s (only `file_open` + `attention_*` handled) — add a one-line comment: `// comment_event / comment_mention / profile_event are OUTBOUND-only (server-authored).`
- [ ] **Step 4: Run — expect PASS.** Run `m57-presence` + `m58-attention` for regression. `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(m61-a): server transport for comment/profile invalidation pings`

---

### Task A3: Anchor math — pure module (frontend)

**Files:**
- Create: `frontend/src/comments/anchor.ts`
- Test: `frontend/test/comment.anchor.test.ts`

**Interfaces — Produces (frozen for A6 payload shape, A8, A9):**
- `encodeAnchor(yText: Y.Text, startOffset: number, endOffset: number): Promise<{ relStart: string; relEnd: string; slice: string; startLine: number; endLine: number; prefixHash: string }>` — `slice` ≤256 chars raw; `prefixHash = fingerprint(slice)`.
- `resolveAnchor(doc: Y.Doc, filePath: string, a: { relStart; relEnd; slice; startLine; endLine; prefixHash }): Promise<{ state: 'exact'|'drifted'|'stale'; range: { startLineNumber; startColumn; endLineNumber; endColumn } | null; recovery: { line: number } | null }>`
- `fingerprint(text: string): Promise<string>` — SHA-256 first 16 hex of the whitespace-collapsed, ≤256-char text.
- `fuzzyMatchSlice(docText: string, slice: string): { line: number; score: number } | null` — token-Jaccard over 3-line windows; return best iff `score ≥ 0.8`.
- `offsetToPosition(text, offset)`, `positionToOffset(text, line, col)`.

- [ ] **Step 1: Write the failing test** (4 cases — full assertions):

```ts
import * as Y from "yjs";
import { encodeAnchor, resolveAnchor } from "../src/comments/anchor";
const docWith = (t: string) => { const d = new Y.Doc(); d.getText("f").insert(0, t); return d; };

it("exact after an insertion ABOVE the anchor", async () => {
  const d = docWith("line1\nline2\nTARGET\nline4\n"); const t = d.getText("f");
  const s = "line1\nline2\n".length, e = s + "TARGET".length;
  const a = await encodeAnchor(t, s, e);
  t.insert(0, "new\nnew\n");
  const r = await resolveAnchor(d, "f", a);
  expect(r.state).toBe("exact"); expect(r.range!.startLineNumber).toBe(5);
});
it("stale when the whole anchored range is replaced", async () => {
  const d = docWith("a\nTARGET LINE\nb\n"); const t = d.getText("f");
  const a = await encodeAnchor(t, 2, 2 + "TARGET LINE".length);
  t.delete(0, t.length); t.insert(0, "completely different content\n");
  const r = await resolveAnchor(d, "f", a);
  expect(r.state).toBe("stale"); expect(r.range).toBeNull();
});
it("stale + recovery line when the slice moved", async () => {
  const d = docWith("header\nconst x = compute(a, b)\nfooter\n"); const t = d.getText("f");
  const s = "header\n".length, e = s + "const x = compute(a, b)".length;
  const a = await encodeAnchor(t, s, e);
  t.delete(0, t.length);
  t.insert(0, "new header\nnew line\nanother\nconst x = compute(a, b)\nend\n");
  const r = await resolveAnchor(d, "f", a);
  expect(r.state).toBe("stale"); expect(r.recovery?.line).toBe(4);
});
it("drifted (no warning) when anchored text changed length in place", async () => {
  const d = docWith("x\nTARGET\ny\n"); const t = d.getText("f");
  const a = await encodeAnchor(t, 2, 2 + "TARGET".length);
  t.insert(2 + "TAR".length, "XXX");
  const r = await resolveAnchor(d, "f", a);
  expect(r.state).toBe("drifted"); expect(r.range!.startLineNumber).toBe(2);
});
```

- [ ] **Step 2: Run — expect FAIL.** `cd frontend && npx vitest run test/comment.anchor.test.ts`
- [ ] **Step 3: Implement** (see the reference below; `staleWithRecovery` uses `a.slice` + `fuzzyMatchSlice`):

```ts
import * as Y from "yjs";
const MAX_SLICE = 256;
export async function fingerprint(text: string): Promise<string> {
  const norm = text.replace(/\s+/g, " ").trim().slice(0, MAX_SLICE);
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(norm));
  return [...new Uint8Array(buf)].slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");
}
export function offsetToPosition(text: string, offset: number) {
  let line = 1, col = 1;
  for (let i = 0; i < offset && i < text.length; i++) { if (text[i] === "\n") { line++; col = 1; } else col++; }
  return { lineNumber: line, column: col };
}
export function positionToOffset(text: string, line: number, col: number) {
  let off = 0, l = 1;
  for (let i = 0; i < text.length && l < line; i++) { if (text[i] === "\n") { l++; off = i + 1; } }
  return off + (col - 1);
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export async function encodeAnchor(yText: Y.Text, startOffset: number, endOffset: number) {
  const relS = Y.createRelativePositionFromTypeIndex(yText, startOffset);
  const relE = Y.createRelativePositionFromTypeIndex(yText, endOffset);
  const text = yText.toString();
  const slice = (text.slice(startOffset, endOffset) || text.slice(startOffset, startOffset + MAX_SLICE)).slice(0, MAX_SLICE);
  return {
    relStart: b64(Y.encodeRelativePosition(relS)), relEnd: b64(Y.encodeRelativePosition(relE)),
    slice, startLine: offsetToPosition(text, startOffset).lineNumber, endLine: offsetToPosition(text, endOffset).lineNumber,
    prefixHash: await fingerprint(slice),
  };
}
export async function resolveAnchor(doc: Y.Doc, filePath: string, a: {
  relStart: string; relEnd: string; slice: string; startLine: number; endLine: number; prefixHash: string;
}) {
  const yText = doc.getText(filePath); const text = yText.toString();
  let relS: Y.RelativePosition, relE: Y.RelativePosition;
  try { relS = Y.decodeRelativePosition(unb64(a.relStart)); relE = Y.decodeRelativePosition(unb64(a.relEnd)); }
  catch { return stale(text, a); }
  const absS = Y.createAbsolutePositionFromRelativePosition(relS, doc);
  const absE = Y.createAbsolutePositionFromRelativePosition(relE, doc);
  if (!absS || !absE || absS.type !== yText || absE.type !== yText) return stale(text, a);
  const so = Math.min(absS.index, absE.index), eo = Math.max(absS.index, absE.index);
  if (so === eo && a.slice.trim().length > 0) return stale(text, a);   // range collapsed
  const p1 = offsetToPosition(text, so), p2 = offsetToPosition(text, eo);
  const range = { startLineNumber: p1.lineNumber, startColumn: p1.column, endLineNumber: p2.lineNumber, endColumn: p2.column };
  const currentHash = await fingerprint(text.slice(so, eo));
  return { state: currentHash === a.prefixHash ? "exact" as const : "drifted" as const, range, recovery: null };
}
function stale(text: string, a: { slice: string }) {
  const m = fuzzyMatchSlice(text, a.slice);
  return { state: "stale" as const, range: null, recovery: m ? { line: m.line } : null };
}
export function fuzzyMatchSlice(docText: string, slice: string) {
  const want = new Set(slice.toLowerCase().split(/\W+/).filter(Boolean));
  if (want.size === 0) return null;
  const lines = docText.split("\n"); let best: { line: number; score: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const have = new Set(lines.slice(i, i + 3).join(" ").toLowerCase().split(/\W+/).filter(Boolean));
    let inter = 0; for (const w of want) if (have.has(w)) inter++;
    const score = inter / (want.size + have.size - inter || 1);
    if (!best || score > best.score) best = { line: i + 1, score };
  }
  return best && best.score >= 0.8 ? best : null;
}
```

- [ ] **Step 4: Run — expect PASS** (all 4). `npm run build`.
- [ ] **Step 5: Commit** — `feat(m61-a): Yjs RelativePosition comment anchor math`

---

### Task A4: Comment validation — pure module (backend)

**Files:**
- Create: `backend/src/comments/validate.ts`
- Test: `backend/test/m61-comment-validate.test.ts`

**Interfaces — Produces (frozen for A5, A6):**
- `COMMENT_MAX_LEN = 4000`, `MAX_MENTIONS = 20`, `EMOJI_SET: ReadonlySet<string>` = `👍 👎 🎉 👀 ❤️ 🚀`.
- `sanitizeCommentBody(v): string | null` — strip C0/DEL except `\n\t`, collapse 3+ blank lines → 2, trim; `null` if empty or > `COMMENT_MAX_LEN`.
- `isEmoji(v): v is string` — `EMOJI_SET.has(v)`.
- `parseMentionIds(v): number[]` — array → `Number.isInteger` → dedupe → cap `MAX_MENTIONS`.
- `isAnchorPayload(v): v is AnchorPayload` — `{ relStart, relEnd, slice(string ≤256), startLine, endLine (isAwarenessCoord), prefixHash /^[0-9a-f]{16}$/ }`; base64 fields ≤ 4096 chars.

- [ ] **Step 1: Write the failing test:**

```ts
import { sanitizeCommentBody, parseMentionIds, isEmoji, isAnchorPayload, EMOJI_SET } from "../src/comments/validate";
it("body: strips control chars, keeps newlines, rejects empty/oversize", () => {
  expect(sanitizeCommentBody("a\x00b")).toBe("ab");
  expect(sanitizeCommentBody("l1\nl2")).toBe("l1\nl2");
  expect(sanitizeCommentBody("   ")).toBeNull();
  expect(sanitizeCommentBody("x".repeat(4001))).toBeNull();
});
it("mentions: dedupe + cap 20; non-ints dropped", () => {
  expect(parseMentionIds([1,1,2,"3",3.5,null])).toEqual([1,2]);
  expect(parseMentionIds(Array.from({length:50},(_,i)=>i+1)).length).toBe(20);
});
it("emoji: exactly the fixed six", () => {
  expect(EMOJI_SET.size).toBe(6);
  expect(isEmoji("👍")).toBe(true); expect(isEmoji("💩")).toBe(false);
});
it("anchor payload shape guard", () => {
  const ok = { relStart:"AA", relEnd:"BB", slice:"x", startLine:1, endLine:1, prefixHash:"0123456789abcdef" };
  expect(isAnchorPayload(ok)).toBe(true);
  expect(isAnchorPayload({ ...ok, prefixHash:"nope" })).toBe(false);
  expect(isAnchorPayload({ ...ok, relStart:"A".repeat(5000) })).toBe(false);
  expect(isAnchorPayload({ ...ok, slice:"x".repeat(300) })).toBe(false);
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — reuse the C0/DEL loop from `collab/attention.ts` `sanitizeAttentionMessage`; `isAwarenessCoord` importable from `collab/presence.ts`.
- [ ] **Step 4: Run — expect PASS.** `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(m61-a): comment input validation`

---

### Task A5: Comment DB store

**Files:**
- Create: `backend/src/comments/store.ts`
- Test: `backend/test/m61-comment-store.test.ts`

**Interfaces — Consumes:** `Db`, `randomUUID`, `isAnchorPayload` type. **Produces (frozen for A6, A7):** all sync, `db` first —
- `createThread(db, { projectId, filePath, anchor, authorId, body }): { threadId: string; rootCommentId: string }` — inserts thread + root comment in one `BEGIN`/`COMMIT`.
- `addReply(db, { threadId, projectId, authorId, body }): { commentId: string }` — `parent_comment_id` forced to the thread's `root_comment_id`.
- `editComment(db, { commentId, authorId, body }): boolean` — `false` if not the author or tombstoned; sets `edited_at`.
- `tombstoneComment(db, { commentId, actorId, projectOwnerId }): boolean` — `true` iff `actorId === author_id || actorId === projectOwnerId`; sets `deleted_at`, blanks `body`, deletes that comment's mention/reaction rows; replies survive.
- `resolveThread(db, { threadId, actorId })` / `reopenThread(db, { threadId })`.
- `setThreadAnchorStatus(db, threadId, status: 'ok'|'stale')`.
- `replaceMentions(db, commentId, userIds: number[])`.
- `upsertReaction(db, commentId, userId, emoji)` / `removeReaction(db, commentId, userId, emoji)`.
- `listThreadsForFile(db, projectId, filePath, status: 'active'|'resolved'|'all'): ThreadWithComments[]`.
- `listUnresolved(db, projectId, limit: number, before: string | null): { threads: ThreadWithComments[]; nextBefore: string | null }` — `(updated_at, id)` cursor (copy `encodeCursor`/`decodeCursor` from `collab/timeline.ts`).
- Types: `ThreadRow`, `CommentRow`, `ReactionRow`, `ThreadWithComments { thread: ThreadRow; root: CommentRow; replies: CommentRow[]; reactions: ReactionRow[]; mentions: { userId: number; username: string }[] }`.
- Every mutation bumps `comment_threads.updated_at`.

- [ ] **Step 1: Write the failing test** (representative — 3 cases):

```ts
it("lifecycle: create → reply → resolve → reopen → tombstone keeps replies", () => {
  const db = seed(); // 2 users (1 owner, 2 collab), project "p"
  const anchor = { relStart:"A", relEnd:"B", slice:"x", startLine:3, endLine:3, prefixHash:"0".repeat(16) };
  const { threadId, rootCommentId } = createThread(db, { projectId:"p", filePath:"a.ts", authorId:2, body:"root", anchor });
  addReply(db, { threadId, projectId:"p", authorId:1, body:"reply" });
  resolveThread(db, { threadId, actorId:1 });
  expect(listThreadsForFile(db,"p","a.ts","all")[0].thread.resolved_by).toBe(1);
  reopenThread(db, { threadId });
  expect(listThreadsForFile(db,"p","a.ts","active").length).toBe(1);
  expect(editComment(db, { commentId: rootCommentId, authorId: 1, body: "hax" })).toBe(false);
  expect(tombstoneComment(db, { commentId: rootCommentId, actorId: 1, projectOwnerId: 1 })).toBe(true);
  const t = listThreadsForFile(db,"p","a.ts","all")[0];
  expect(t.root.deleted_at).not.toBeNull(); expect(t.root.body).toBe("");
  expect(t.replies.map(r=>r.body)).toEqual(["reply"]);
});
it("reactions dedupe by (comment,user,emoji)", () => {
  const db = seed();
  const { rootCommentId } = createThread(db, { projectId:"p", filePath:"a.ts", authorId:2, body:"x",
    anchor:{ relStart:"A",relEnd:"B",slice:"x",startLine:1,endLine:1,prefixHash:"0".repeat(16) } });
  upsertReaction(db, rootCommentId, 1, "👍"); upsertReaction(db, rootCommentId, 1, "👍");
  expect(listThreadsForFile(db,"p","a.ts","all")[0].reactions.filter(r=>r.emoji==="👍").length).toBe(1);
});
it("listUnresolved paginates by (updated_at,id), excludes resolved", () => {
  const db = seed();
  for (let i=0;i<5;i++) createThread(db, { projectId:"p", filePath:`f${i}.ts`, authorId:2, body:`c${i}`,
    anchor:{ relStart:"A",relEnd:"B",slice:"x",startLine:1,endLine:1,prefixHash:"0".repeat(16) } });
  const p1 = listUnresolved(db,"p",2,null); expect(p1.threads.length).toBe(2);
  const p2 = listUnresolved(db,"p",2,p1.nextBefore);
  expect(p2.threads.map(t=>t.thread.id)).not.toContain(p1.threads[0].thread.id);
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — prepared statements; `listThreadsForFile` = 1 query per table + JS assembly (small N/file).
- [ ] **Step 4: Run — expect PASS.** `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(m61-a): comment thread DB store`

---

### Task A6: Comment REST routes

**Files:**
- Create: `backend/src/comments/routes.ts`
- Modify: `backend/src/app.ts` (mount under the projects router so `:id` + `requireProjectAccess` compose), `backend/src/config.ts` (`commentWriteMax=30`, `commentWriteWindowMs=60_000`), `backend/src/audit.ts` (`COMMENT_ADDED`, `COMMENT_RESOLVED`), `frontend/src/types.ts` (`CommentThreadDTO`, `CommentDTO`, `CommentEventWire`, `CommentMentionWire`)
- Test: `backend/test/m61-comments.test.ts` (full app via `startTestApi` from `test/helpers.ts`)

**Interfaces — Frozen for A8:** the routes + DTOs of spec §4.4. Handler shape: `requireProjectAccess` → `validate.*` → mention filter `mentionIds.filter(id => { try { requireProjectAccess(db, id, projectId, "viewer"); return true; } catch { return false; } })` → rate-limit (create/reply/edit) via `Map<`${userId}:${projectId}`, RateLimiter>` → `store.*` → `collaborationManager.broadcastCommentEvent(projectId, {threadId, filePath, kind, at: Date.now()})` → for each surviving mention: `collaborationManager.sendCommentMentionTo(projectId, id, {...})` → `recordAuditLog` (create/resolve) → `res.json(dto)`.

- [ ] **Step 1: Write the failing test** (the §9.2 matrix — write all; here the shape):

```ts
it("editor creates; viewer reads; non-member 404; viewer cannot write (403)", async () => { /* per spec §9.2 */ });
it("mention: non-member dropped; member persisted + delivered to a connected target only", async () => { /* … */ });
it("edit author-only (403 else); delete author-or-owner (tombstone); replies survive", async () => { /* … */ });
it("reaction fixed-set enforced (400 for 💩); PK dedupe; toggle off", async () => { /* … */ });
it("body XSS payload stored + returned literally", async () => {
  /* create body "<img src=x onerror=alert(1)>"; GET returns the exact string */
});
it("31st write in the window → 429", async () => { /* 30 creates, then one more */ });
it("every mutation calls collaborationManager.broadcastCommentEvent (spy)", async () => { /* … */ });
it("resolve/reopen idempotent; anchor-status advisory (stores 'stale')", async () => { /* … */ });
it("cross-project isolation: room B never gets project A's comment_event", async () => { /* … */ });
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — expect PASS** (full file). `npm run typecheck`. Run `api.test.ts` for regression.
- [ ] **Step 5: Commit** — `feat(m61-a): comment REST API`

---

### Task A7: M60 timeline — comment source

**Files:**
- Create: `backend/src/comments/timelineSource.ts`
- Modify: `backend/src/collab/timeline.ts` (`TimelineEvent.kind + "comment"`; union call; `MEANINGFUL_KINDS.add("comment")`), `frontend/src/types.ts` (`TimelineEventKind + "comment"`)
- Test: `backend/test/m61-comment-timeline.test.ts`

**Interfaces — Produces:** `queryCommentTimeline(db, projectId, { limit, before, since }): TimelineEvent[]` — reads `comment_threads` + `comments` (join `users`); `id: "comment:<commentId>"`; `kind: "comment"`; `at` = comment `created_at` (or thread `resolved_at`); `title` ∈ {`commented on <file> L<line>`, `replied on <file>`, `resolved a comment thread`, `reopened a comment thread`}; `subtitle` = ≤120-char body preview; `navigable` = has `filePath` + `lineRange`. Cursor predicate pushed in like the other sources (`('comment:'||c.id) < ?`).

- [ ] **Step 1: Write the failing test:**

```ts
it("emits comment lifecycle events, nothing on reaction/edit", () => {
  const db = seedProject();
  const { threadId, rootCommentId } = createThread(db, { projectId:"p", filePath:"a.ts", authorId:2, body:"root",
    anchor:{ relStart:"A",relEnd:"B",slice:"x",startLine:3,endLine:3,prefixHash:"0".repeat(16) } });
  addReply(db, { threadId, projectId:"p", authorId:1, body:"r" });
  upsertReaction(db, rootCommentId, 1, "👍");
  editComment(db, { commentId: rootCommentId, authorId: 2, body: "edited" });
  resolveThread(db, { threadId, actorId: 1 });
  const t = queryTimeline(db, "p", { limit: 50 }).events.filter(e => e.kind === "comment").map(e => e.title);
  expect(t.some(x => x.startsWith("commented on"))).toBe(true);
  expect(t.some(x => x.startsWith("replied on"))).toBe(true);
  expect(t).toContain("resolved a comment thread");
  expect(t.some(x => /reaction|edited/.test(x))).toBe(false);
});
it("queryWhileAway includes comment events, excludes the caller's own", () => { /* … */ });
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — in `timeline.ts` add a 5th `out.push(...queryCommentTimeline(...))` block (mirror the Git-commit block).
- [ ] **Step 4: Run — expect PASS.** Run `m60-timeline*`. `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(m61-a): comment events in the M60 timeline`

---

### Task A8: Frontend comment API + store + client wiring

**Files:**
- Create: `frontend/src/comments/api.ts`, `frontend/src/comments/store.ts`
- Modify: `frontend/src/collab/client.ts` (3 receive branches), `frontend/src/types.ts`
- Test: `frontend/test/comment.store.test.ts`, `frontend/test/collab.comment.client.test.ts`

**Interfaces — Frozen for A9, A10, A11, C5:**
- `api.ts`: `fetchThreads(projectId, file, status)`, `createThread(projectId, {filePath, anchor, body, mentions})`, `addReply`, `editComment`, `deleteComment`, `resolveThread`, `reopenThread`, `react`, `unreact`, `reportAnchorStatus`. Via `api<T>()`.
- `store.ts`: `class CommentStore { constructor(projectId: string); load(file: string): Promise<void>; threadsFor(file: string): ThreadWithComments[]; unresolved(): ThreadWithComments[]; applyEvent(ev: CommentEventWire): void; on(cb: () => void): () => void; dispose(): void }` — `applyEvent` schedules a per-file debounced (≈250 ms) `fetchThreads` for `ev.filePath` only.
- `client.ts`: `case "comment_event"` / `"comment_mention"` / `"profile_event"` (shape-guarded, mirror the `collab_change` guard) → `this.emit("comment_event", parsed)` etc. Add a `_handleCustomForTest(json)` shim if the test needs it (or reuse an existing one).

- [ ] **Step 1: Write the failing tests:**

```ts
// collab.comment.client.test.ts
it("emits comment_event for a valid frame, ignores a malformed one", () => {
  const c = makeClient(); const seen: any[] = []; c.on("comment_event", e => seen.push(e));
  c._handleCustomForTest(JSON.stringify({ type: "comment_event", threadId: "t", filePath: "a.ts", kind: "created", at: 1 }));
  c._handleCustomForTest(JSON.stringify({ type: "comment_event" }));
  expect(seen.length).toBe(1);
});
// comment.store.test.ts
it("applyEvent triggers one throttled scoped refetch per file", async () => {
  const spy = vi.spyOn(api, "fetchThreads").mockResolvedValue({ threads: [], nextBefore: null });
  const s = new CommentStore("p");
  s.applyEvent({ type: "comment_event", threadId: "t", filePath: "a.ts", kind: "created", at: 1 });
  s.applyEvent({ type: "comment_event", threadId: "t", filePath: "a.ts", kind: "replied", at: 2 });
  s.applyEvent({ type: "comment_event", threadId: "u", filePath: "b.ts", kind: "created", at: 3 });
  await vi.advanceTimersByTimeAsync(300);
  expect(spy).toHaveBeenCalledTimes(2);                      // a.ts once, b.ts once
  expect(spy).toHaveBeenCalledWith("p", "a.ts", expect.anything());
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — expect PASS.** `npm run build`.
- [ ] **Step 5: Commit** — `feat(m61-a): frontend comment API, store, client wiring`

---

### Task A9: Editor gutter markers + hover widget + mentionText

**Files:**
- Create: `frontend/src/components/Comments/CommentGutter.tsx`, `frontend/src/components/Comments/mentionText.tsx`
- Modify: `frontend/src/components/Editor/Editor.tsx` (mount `<CommentGutter>` in the editor wrapper; add `cloudide.comment.create` action → `encodeAnchor` against `collabClientRef.current.doc.getText(activeFile)` from the current selection → `commentsApi.createThread` → open the popover), `frontend/src/styles/collab.css`
- Test: `frontend/test/Editor.comments.test.tsx`, `frontend/test/mentionText.test.tsx`

**Interfaces — Frozen for A10, A11:**
- `<CommentGutter editor monaco activeFile doc threads onOpenThread />` — for each thread: `await resolveAnchor(doc, activeFile, thread.anchor)`; `exact`/`drifted` → `createDecorationsCollection().set([...])` with `glyphMarginClassName: "comment-glyph"` + `💬N` `after` deco + a hover content widget (all text `textContent`); click → `onOpenThread(threadId)`. `stale` → **not decorated** (panel-only). Teardown on unmount (mirror the M58 cleanup effect).
- `mentionText(body: string, knownUsernames: Set<string>): ReactNode[]` — split on `/@(\w+)/`; wrap matches in `knownUsernames` in `<span className="mention">@name</span>`; everything else is a plain string child (auto-escaped).

- [ ] **Step 1: Write the failing tests:**

```tsx
// mentionText.test.tsx
it("wraps only known @usernames; escapes everything else", () => {
  const { container } = render(<>{mentionText("hi @rahul <b>x</b> @ghost", new Set(["rahul"]))}</>);
  expect(container.querySelectorAll(".mention").length).toBe(1);
  expect(container.textContent).toContain("<b>x</b>");    // literal
});
// Editor.comments.test.tsx  (Monaco mocked via frontend/test/mocks/monaco.ts)
it("marks the resolved line for an active thread; nothing for a stale one", async () => {
  const { getDecorations } = renderGutterWith({ activeFile: "a.ts", threads: [activeThreadAtLine(4), staleThread()] });
  await flush();
  expect(getDecorations().filter(d => d.options.glyphMarginClassName === "comment-glyph").length).toBe(1);
});
it("clicking a marker calls onOpenThread(id)", async () => { /* … */ });
it("comment render never edits the Monaco model", async () => { /* spy applyEdits/pushEditOperations → 0 */ });
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — copy the M58 decoration+widget path (`Editor.tsx` ~906–1057) as the template.
- [ ] **Step 4: Run — expect PASS.** `npm run build`. Run `Editor.attention.test.tsx` for regression.
- [ ] **Step 5: Commit** — `feat(m61-a): comment gutter markers + hover preview`

---

### Task A10: Comment thread popover + composer

**Files:**
- Create: `frontend/src/components/Comments/CommentThread.tsx`, `frontend/src/components/Comments/CommentComposer.tsx`, `frontend/src/hooks/useFocusTrap.ts`
- Test: `frontend/test/CommentThread.test.tsx`, `frontend/test/CommentComposer.test.tsx`

**Interfaces — Frozen for A11, D1 (avatar slot):**
- `<CommentThread thread root replies reactions mentions currentUserId members onReply onEdit onDelete onResolve onReopen onReact onClose />` — ordered list; per row a **local `<span className="c-avatar">{initials}</span>` fallback (D1 swaps `<CollaboratorAvatar>`)** + name + relative time + `edited`/`deleted` state + reaction chip row + `+` (fixed 6) + (author) edit/delete; `[Resolve]`/`[Reopen]`; `useFocusTrap`; Esc → `onClose`; ↑/↓ between comments.
- `<CommentComposer members value onChange onSubmit placeholder />` — textarea; `@` opens a keyboard-navigable member dropdown (username prefix); select inserts `@username `; Enter submits `{ body, mentions: number[] }` (mentions derived by matching `@tokens` to `members`), Shift+Enter newline.

- [ ] **Step 1: Write the failing tests:**

```tsx
it("renders root + ordered replies; deleted placeholder; resolve toggles", () => { /* … */ });
it("reaction: + then 👍 → onReact('👍'); clicking an active chip → onReact('👍') again", () => { /* … */ });
it("Esc → onClose; focus trapped in the popover", () => { /* … */ });
// composer
it("@ opens member autocomplete; select inserts @username; unknown @handle stays literal", () => {
  const members = [{ userId: 7, username: "rahul" }]; const onSubmit = vi.fn();
  render(<CommentComposer members={members} value="" onChange={()=>{}} onSubmit={onSubmit} />);
  // type "@ra" → pick rahul → type " look @ghost" → Enter
  expect(onSubmit).toHaveBeenCalledWith({ body: "@rahul look @ghost", mentions: [7] });
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — `glass-floating` container; `useFocusTrap` = ~20-line first/last tabbable cycle.
- [ ] **Step 4: Run — expect PASS.** `npm run build`.
- [ ] **Step 5: Commit** — `feat(m61-a): comment thread popover + mention composer`

---

### Task A11: Comments panel + navigation + callout promotion + tray mentions

**Files:**
- Create: `frontend/src/components/Comments/CommentsPanel.tsx`
- Modify: `frontend/src/components/Collab/TeamPanel.tsx` (mount `<CommentsPanel>` as a sibling section), `frontend/src/components/Collab/AttentionTray.tsx` ("Attention & Mentions" — `comment_mention` cards, **always shown for now — B8/D2 add the `notification.*` gate**), `frontend/src/components/IDE/IDE.tsx` (`CommentStore` lifecycle mirroring the `timeline` state pattern; `client.on("comment_event", …)` → `store.applyEvent` + timeline tail refetch; `client.on("comment_mention", …)` → `setMentionCards(c => [ev, ...c].slice(0, 10))`; `handleCommentNavigate(thread)` → `openAndRevealLocation(handleOpenFile, {filePath, line: thread.anchor.startLine})` then open popover; thread-popover host), callout card (`[Keep as comment]`)
- Modify: the `CommandRegistry` consumer that registers IDE commands (add "Comments: Next in file", "Comments: Previous in file", "Comments: Go to unresolved")
- Test: `frontend/test/CommentsPanel.test.tsx`, `frontend/test/IDE.comments.test.tsx`, `frontend/test/AttentionTray.mentions.test.tsx`

**Interfaces:**
- `<CommentsPanel projectId activeFile threads unresolved showResolved onToggleResolved onNavigate onOpenThread />`.
- `[Keep as comment]` → `commentsApi.createThread(projectId, { filePath: callout.file, anchor: await encodeAnchor(doc.getText(callout.file), <offsets from callout.range>), body: callout.message, mentions: [] })`. Does **not** touch the M58 `AttentionStore` entry.

- [ ] **Step 1: Write the failing tests:**

```tsx
it("panel: active threads for the file + project-wide unresolved roll-up; row click navigates", () => { /* … */ });
it("nav command jumps to the next comment via openAndRevealLocation (open before reveal for a closed file)", async () => {
  const openSpy = vi.fn().mockResolvedValue(undefined); const revealSpy = vi.fn();
  document.addEventListener("ide-reveal-location", revealSpy);
  // trigger "Comments: Next in file" for a thread in a not-open file
  expect(openSpy.mock.invocationCallOrder[0]).toBeLessThan(revealSpy.mock.invocationCallOrder[0]);
});
it("[Keep as comment] creates a thread and leaves the callout event intact", async () => {
  const createSpy = vi.spyOn(commentsApi, "createThread").mockResolvedValue({ thread: { id: "t" } } as any);
  // render tray with a callout {file:"a.ts", range, message:"the race is here"}, click Keep as comment
  expect(createSpy).toHaveBeenCalledWith("p", expect.objectContaining({ body: "the race is here" }));
  // AttentionStore still holds the callout
});
it("comment_mention → tray card with [Go to comment] → navigate + open thread", () => { /* … */ });
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — expect PASS.** `npm run build`. Run `AttentionTray.test.tsx` + `TeamPanel.test.tsx`.
- [ ] **Step 5: Commit** — `feat(m61-a): comments panel, navigation, callout promotion, tray mentions`

---

### Task A-GATE: M61-A regression + browser acceptance + freeze

**Files:** evidence note in scratchpad; no source change.

- [ ] **Step 1:** `cd backend && npx vitest run` — full suite green; `m57-presence`, `m58-attention`, `collab.focus*`/M59, `m60-*`, `m4-collab`, `collab-awareness-security`, `migrations` all green. Record `N passed / 0 failed / M skipped`.
- [ ] **Step 2:** `cd frontend && npx vitest run` — full suite green. `npm run build` exit 0. `cd backend && npm run typecheck` exit 0. `eslint` both — 0 new errors.
- [ ] **Step 3:** Two authenticated Chrome sessions (or the headless 2-client script), same project, Docker up. Walk spec §10.1 steps 1–14. Record PASS/PARTIAL per step; screenshot the anchored→stale transition (10–11) and the mention card (6).
- [ ] **Step 4:** Freeze (write into the evidence note, referenced by C and D): `comment_event` / `comment_mention` wire shapes; `CommentThreadDTO` / `CommentDTO`; anchor payload `{relStart, relEnd, slice, startLine, endLine, prefixHash}`; `broadcastCommentEvent` / `sendCommentMentionTo` / `broadcastProfileEvent` signatures; `CommentStore` public API. Clean up test artifacts.
- [ ] **Step 5: Commit** — `test(m61-a): A-GATE — regression + browser acceptance + frozen interfaces`

---

# WORKSTREAM M61-B — IDE Customization

*Depends only on A1 (migration). Does not use A2.*

### Task B1: Shared control primitives + contrast helper

**Files:**
- Create: `frontend/src/components/common/controls/{Switch,Segmented,Slider,ColorField,Select}.tsx` + `index.ts`, `frontend/src/settings/contrast.ts`
- Modify: `frontend/src/styles/glass.css` (append control classes)
- Test: `frontend/test/controls.test.tsx`, `frontend/test/contrast.test.ts`

**Interfaces — Frozen for B9, C7:**
- `<Switch checked onChange label id />` (`role="switch"`, Space/Enter).
- `<Segmented options={{value,label}[]} value onChange ariaLabel />` (`role="radiogroup"`, arrow keys).
- `<Slider min max step value onChange onCommit ariaLabel />` (debounced `onCommit`).
- `<ColorField value onChange onCommit swatches={string[]} contrastBase />` — swatches + hex input; low-contrast/invalid hex → inline error, no `onCommit`.
- `<Select options value onChange ariaLabel />`.
- `contrast.ts`: `relativeLuminance(hex): number`, `contrastRatio(a, b): number`, `contrastOk(hex, base, min = 4.5): boolean`.

- [ ] **Step 1: Write the failing tests:**

```tsx
it("Switch toggles on Space + fires onChange", () => { /* … */ });
it("Segmented moves selection with ArrowRight/Left", () => { /* … */ });
it("ColorField rejects a low-contrast hex, no onCommit", () => {
  const onCommit = vi.fn();
  render(<ColorField value="#89b4fa" onChange={()=>{}} onCommit={onCommit} contrastBase="#151a26" swatches={[]} />);
  // type "#161a26" → inline error visible, onCommit not called
  expect(onCommit).not.toHaveBeenCalled();
});
it("Slider debounces onCommit, fires onChange live", async () => { /* … */ });
it("contrastRatio(#000,#fff) ≈ 21; contrastOk rejects near-identical", () => { /* … */ });
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — thin wrappers over `glass-*`.
- [ ] **Step 4: Run — expect PASS.** `npm run build`.
- [ ] **Step 5: Commit** — `feat(m61-b): shared settings control primitives + contrast helper`

---

### Task B2: Token layer — theme / density / motion / text-scale

**Files:**
- Modify: `frontend/src/styles/tokens.css`, `frontend/src/monacoSetup.ts`, the ~10 highest-traffic components with raw colors/px (enumerate in Step 1)
- Test: `frontend/test/tokens.theme.test.ts`

**Interfaces — Frozen for B6:**
- `document.documentElement.dataset.theme ∈ {"", "cloud-midnight", "cloud-dim", "cloud-light"}` (empty = `cloud-dark`).
- `dataset.density ∈ {"", "compact", "spacious"}`; `dataset.motion === "reduced"` zeroes `--duration-*`/`--spring-*`; `--text-scale` multiplies `--text-*`.
- Monaco themes `cloud-dark` (default), `cloud-midnight`, `cloud-dim`, `cloud-light` via `defineTheme`.

- [ ] **Step 1: Write the failing test + inventory:**

```ts
it("data-theme swaps --bg-surface", () => {
  document.documentElement.dataset.theme = "";
  const dark = getComputedStyle(document.documentElement).getPropertyValue("--bg-surface").trim();
  document.documentElement.dataset.theme = "cloud-light";
  expect(getComputedStyle(document.documentElement).getPropertyValue("--bg-surface").trim()).not.toBe(dark);
});
it("data-density=compact shrinks --space-3", () => { /* … */ });
it("data-motion=reduced zeroes --duration-normal", () => { /* … */ });
it("--text-scale multiplies --text-base", () => { /* … */ });
```

Run `rg -n "#[0-9a-fA-F]{6}|:\s*\d+px" frontend/src/components --glob '*.tsx'` → migrate the ~10 highest-traffic hits to tokens (TeamPanel dots, avatar stack, popover, etc.); note the rest in STATUS as acceptable debt.

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — move the ~24 palette vars into `:root, :root[data-theme="cloud-dark"] { … }` + 3 sibling `[data-theme]` blocks; `[data-density]` remaps `--space-1..8` + `--control-h`; `[data-motion="reduced"]` mirrors the existing `@media (prefers-reduced-motion)` rules; keep the `@media` blocks (cover "system").
- [ ] **Step 4: Run — expect PASS.** `npm run build`. `npm run dev` → toggle all 4 themes in devtools, no unreadable text.
- [ ] **Step 5: Commit** — `feat(m61-b): themeable token layer + density + motion + text-scale`

---

### Task B3: Setting registry + keys.ts + migrations.ts (pure)

**Files:**
- Create: `frontend/src/settings/registry.ts`, `frontend/src/settings/keys.ts`, `frontend/src/settings/migrations.ts`
- Test: `frontend/test/settings.registry.test.ts`, `frontend/test/settings.keys.test.ts`, `frontend/test/settings.migrations.test.ts`

**Interfaces — Frozen for B4–B9, C7:**
- `registry.ts`: `SettingDef<T>` (spec §5.1), `SETTINGS: SettingDef<any>[]`, `getDef(id)`, `allDefs()`, `searchDefs(query): SettingDef[]` (fuzzy over `category+section+label+description+keywords`). `apply` bodies: real one-liners for CSS-var ids now; typed stubs `() => {}` for Monaco/context ids (filled in B6/B7/B8).
- `keys.ts`: `parseChord("Ctrl+Shift+P") → { mod, shift, alt, key }`, `formatChord(chord, isMac)`, `matchChord(e, chord)`, `chordConflict(a, b): boolean`.
- `migrations.ts`: `CURRENT_SETTINGS_VERSION = 1`, `SETTINGS_MIGRATIONS: { to: number; migrate: (d) => d }[]` (empty at v1 + a commented no-op example), `migrate(data, fromVersion): { data, version }`.
- Registry id set (spec §5): `appearance.{theme,accent,accentCustom,density,motion,editorTheme}`; `editor.{fontSize,tabSize,wordWrap,minimap,lineNumbers,cursorBlinking,renderWhitespace,breadcrumbs,formatOnSave}`; `layout.{explorerWidth,sideRailWidth,terminalHeight,bottomPanelHeight,panels.explorer,panels.team,panels.timeline,panels.preview,panels.terminal}`; `collaboration.{showRemoteCursors,showRemoteSelections,remoteLabels,activityBadges,commentIndicators,attentionAnimations,followBehavior,presenceDensity,myLabelStyle}`; `notification.{mentions,comments,attentionRequests,collaboratorJoins,teamActivity,executionActivity}`; `keyboard.{commandPalette,quickOpen,save,toggleSidebar,toggleBottomPanel,openSettings,comments.next,comments.prev,comments.unresolved}`; `accessibility.{motion,contrast,textScale,focusRing}`; `advanced.experimental.*`.

- [ ] **Step 1: Write the failing tests:**

```ts
// registry
it("every setting: default, validate(default)===true, validate(garbage)===false, valid category", () => {
  for (const d of allDefs()) {
    expect(d.default).not.toBeUndefined();
    expect(d.validate(d.default)).toBe(true);
    expect(d.validate(Symbol() as any)).toBe(false);
    expect(["appearance","layout","editor","collaboration","notifications","keyboard","accessibility","advanced"]).toContain(d.category);
  }
});
it("no setting id maps to an authorization concept", () => {
  const banned = /role|permission|admin|owner|auth|token|secret|member/i;
  for (const d of allDefs()) expect(d.id).not.toMatch(banned);
});
it("search('cursor') → editor cursor + collaboration remote cursors", () => {
  const ids = searchDefs("cursor").map(d => d.id);
  expect(ids).toEqual(expect.arrayContaining(["editor.cursorBlinking", "collaboration.showRemoteCursors"]));
});
// keys
it("parse/format/match round-trip + conflict detection", () => {
  const c = parseChord("Ctrl+Shift+P");
  expect(formatChord(c, false)).toBe("Ctrl+Shift+P");
  expect(matchChord({ ctrlKey: true, shiftKey: true, key: "P" } as any, c)).toBe(true);
  expect(chordConflict(parseChord("Ctrl+P"), parseChord("Ctrl+P"))).toBe(true);
  expect(chordConflict(parseChord("Ctrl+P"), parseChord("Ctrl+Shift+P"))).toBe(false);
});
// migrations
it("migrate is a no-op at current version", () => {
  expect(migrate({ "editor.fontSize": 14 }, 1)).toEqual({ data: { "editor.fontSize": 14 }, version: 1 });
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — expect PASS.** `npm run build`.
- [ ] **Step 5: Commit** — `feat(m61-b): setting registry, chord parser, settings migrations`

---

### Task B4: Backend `user_settings` store + routes + legacy projection

**Files:**
- Create: `backend/src/settings/store.ts`, `backend/src/settings/routes.ts`
- Modify: `backend/src/auth/routes.ts` (mount; `/preferences` GET/PUT proxy into `user_settings`), `backend/src/app.ts` (register)
- Test: `backend/test/m61-user-settings.test.ts`

**Interfaces — Frozen for B5:**
- `getUserSettings(db, userId): { version: number; data: Record<string, unknown> }` (default `{version:1,data:{}}`).
- `putUserSettings(db, userId, { version, data })` — throws `ApiError(400)` if `data` not a plain object, `JSON.stringify(data).length > 32768`, or `Object.keys(data).length > 200`; `ON CONFLICT(user_id) DO UPDATE`.
- `projectLegacyPrefs(data): LegacyPrefs` / `applyLegacyPrefPatch(data, patch): Record<string, unknown>` — map the 7 keys ↔ `editor.*`.
- `GET /api/auth/settings` → `{ version, data }`; `PUT` → validate + store + `USER_PREFERENCES_UPDATED` audit → stored.
- `/api/auth/preferences` GET → `projectLegacyPrefs(getUserSettings().data)` over `DEFAULT_USER_PREFERENCES`; PUT → validate via existing `updateUserPreferences` rules, write `editor.*` into `user_settings`.

- [ ] **Step 1: Write the failing test:**

```ts
it("GET default, PUT stores, oversize rejected", async () => {
  const { api, owner } = await startTestApi();
  expect((await api.get("/api/auth/settings", owner)).data).toEqual({});
  await api.put("/api/auth/settings", { version: 1, data: { "appearance.theme": "cloud-light" } }, owner);
  expect((await api.get("/api/auth/settings", owner)).data["appearance.theme"]).toBe("cloud-light");
  await api.put("/api/auth/settings", { version: 1, data: { big: "x".repeat(40000) } }, owner, 400);
});
it("legacy /preferences round-trips through user_settings", async () => {
  const { api, owner } = await startTestApi();
  await api.put("/api/auth/preferences", { fontSize: 16 }, owner);
  expect((await api.get("/api/auth/preferences", owner)).preferences.fontSize).toBe(16);
  expect((await api.get("/api/auth/settings", owner)).data["editor.fontSize"]).toBe(16);
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — expect PASS.** Run `auth`/`api` tests. `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(m61-b): server-backed user settings + legacy projection`

---

### Task B5: `SettingsStore` (frontend) + `apply.ts` + `api.ts`

**Files:**
- Create: `frontend/src/settings/store.ts`, `frontend/src/settings/apply.ts`, `frontend/src/settings/api.ts`
- Test: `frontend/test/settings.store.test.ts`

**Interfaces — Frozen for B6–B9, C7, D2:**
- `SettingsStore` singleton: `init({ serverData, serverVersion })` → `migrate` → merge scopes → `applyAll()`. `get<T>(id): T` (precedence `session > workspace > global > default`, `validate` on read). `setScoped(id, v, scope)` + `set(id, v)` (→ setting's own scope). `resetOne/resetCategory/resetAll`. `export(): SettingsExport` / `import(json): { applied: number; dropped: string[] }`. `subscribe(idOrCat, cb)`. `search`.
- `useSetting<T>(id): [T, (v: T) => void]` via `useSyncExternalStore`.
- `apply.ts`: `makeApplyContext(monacoGetter): ApplyContext { setCssVar, setRootAttr, updateMonacoOptions, setContextFlag }`; module-level flag `Map` + `settingsContextEmitter`; `useSettingFlag(key): boolean`.
- `localStorage` keys: `cloudeee.settings.global` (mirror of server), `cloudeee.ws.<pid>.settings`. Global writes debounce a 400 ms `putSettings`.

- [ ] **Step 1: Write the failing tests:**

```ts
it("scope precedence session > workspace > global > default", () => {
  const s = makeStore();
  expect(s.get("editor.fontSize")).toBe(13.5);
  s.setScoped("editor.fontSize", 14, "global");
  s.setScoped("editor.fontSize", 15, "workspace");
  s.setScoped("editor.fontSize", 16, "session");
  expect(s.get("editor.fontSize")).toBe(16);
});
it("set() calls apply once, does not notify unrelated subscribers", () => {
  const applySpy = vi.fn();
  const s = makeStoreWithDef({ id: "x.y", default: false, apply: applySpy, control: "toggle", category: "advanced", section: "x", label: "x", description: "", scope: "global", validate: (v): v is boolean => typeof v === "boolean" });
  const unrelated = vi.fn(); s.subscribe("editor.fontSize", unrelated);
  s.set("x.y", true);
  expect(applySpy).toHaveBeenCalledTimes(1);
  expect(unrelated).not.toHaveBeenCalled();
});
it("resetAll → every id back to default", () => { /* set many, resetAll, assert */ });
it("import: valid applies, unknown/bad-enum dropped, out-of-range clamped, rest applied", () => {
  const s = makeStore();
  const r = s.import(JSON.stringify({ version: 1, data: {
    "appearance.theme": "cloud-light", "appearance.theme.bogus": "x", "appearance.density": "ultra", "editor.fontSize": 999,
  }}));
  expect(s.get("appearance.theme")).toBe("cloud-light");
  expect(r.dropped).toEqual(expect.arrayContaining(["appearance.theme.bogus", "appearance.density"]));
  expect(s.get("editor.fontSize")).toBe(32);
});
it("a newer-version blob drops unknown keys, warns once, no crash", () => { /* … */ });
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — expect PASS.** `npm run build`.
- [ ] **Step 5: Commit** — `feat(m61-b): SettingsStore with scope precedence, reset, import/export`

---

### Task B6: Wire `apply` bodies — appearance / editor / layout / collaboration

**Files:**
- Modify: `frontend/src/settings/registry.ts` (fill `apply`), `frontend/src/components/Editor/Editor.tsx` (read editor ids from `useSetting`, keep the `preferences` prop as a one-milestone fallback), `frontend/src/components/IDE/IDE.tsx` (`SettingsStore.init` on boot from `fetchSettings()`; layout CSS vars), the layout container CSS (consume `--layout-*`), the remote-cursor rendering in `Editor.tsx` (respect `collaboration.show*` via `useSettingFlag`)
- Test: `frontend/test/settings.apply.test.tsx`

**Interfaces:** `appearance.theme.apply → ctx.setRootAttr("theme", v==="cloud-dark"?"":v)` + `monaco.editor.setTheme`; `appearance.accent.apply → ctx.setCssVar("--accent", resolveAccent(v, custom))` + derived; `appearance.density.apply → ctx.setRootAttr("density", v==="comfortable"?"":v)`; `appearance.motion`/`accessibility.motion → ctx.setRootAttr("motion", reduced?"reduced":"")` + `ctx.setContextFlag("motion.reduced", reduced)`; `editor.* → ctx.updateMonacoOptions({...})`; `layout.*Width/*Height → ctx.setCssVar("--layout-…", v+"px")` (slider clamps in the registry `min`/`max`); `collaboration.show* → ctx.setContextFlag(...)`.

- [ ] **Step 1: Write the failing tests:**

```tsx
it("editor.fontSize → monaco.updateOptions, no editor remount (model identity unchanged)", async () => { /* … */ });
it("collaboration.showRemoteCursors=false hides remote carets", async () => { /* render Editor + a remote presence; toggle; decoration gone */ });
it("layout.explorerWidth writes --layout-explorer-w, clamped [180,480]", () => { /* … */ });
it("appearance.density=compact sets data-density; a spacing token shrinks (computed style)", () => { /* … */ });
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — replace the `preferences` `useEffect` (Editor.tsx ~284–296) with `useSetting` reads.
- [ ] **Step 4: Run — expect PASS.** Run `Editor.*`. `npm run build`.
- [ ] **Step 5: Commit** — `feat(m61-b): live-apply appearance/editor/layout/collaboration settings`

---

### Task B7: Keyboard — registry-driven `useKeyboardShortcuts` + rebind UI

**Files:**
- Modify: `frontend/src/hooks/useKeyboardShortcuts.ts`, `frontend/src/settings/registry.ts` (`keyboard.*` defaults = today's chords + `keyboard.openSettings = "Ctrl+,"`)
- Create: `frontend/src/components/Settings/KeyboardCategory.tsx`
- Test: extend `frontend/test/useKeyboardShortcuts.test.ts`, `frontend/test/KeyboardCategory.test.tsx`

**Interfaces — Frozen for B9:** `useKeyboardShortcuts(handlers)` signature unchanged; internally builds `chord → action` from `SettingsStore` `keyboard.*` + `keys.ts` `matchChord` and dispatches to the handler bag / `CommandRegistry.execute`. `<KeyboardCategory />` lists each `keyboard.*` def + current binding + a "record chord" control; `chordConflict` against all other `keyboard.*` values blocks a conflicting save; per-row + "Reset all shortcuts".

- [ ] **Step 1: Write the failing tests:**

```ts
it("default map fires the same handlers as the pre-refactor chords (Ctrl+Shift+P/Ctrl+P/Ctrl+S/Ctrl+B/Ctrl+J)", () => { /* … */ });
it("rebinding quickOpen to Ctrl+E: Ctrl+E opens quick-open, Ctrl+P does nothing", () => { /* … */ });
it("KeyboardCategory blocks a save that conflicts with an existing binding", () => { /* … */ });
it("Reset all shortcuts restores defaults", () => { /* … */ });
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — keep the `capture: true` window listener; `Ctrl+,` dispatches `ide-open-settings`.
- [ ] **Step 4: Run — expect PASS.** `npm run build`.
- [ ] **Step 5: Commit** — `feat(m61-b): registry-driven keyboard shortcuts + rebinding UI`

---

### Task B8: Notifications + reduced-motion functional gate (M58/M59; profile-effect stub)

**Files:**
- Modify: `frontend/src/components/Collab/AttentionTray.tsx` (gate `comment_mention`/attention/comment cards by `notification.*`), `frontend/src/components/Collab/CollaboratorAvatarStack.tsx` (badge gate), `frontend/src/components/Collab/WhileYouWereAway.tsx` (`notification.teamActivity`), `frontend/src/components/Editor/Editor.tsx` (M58 attention pulse reads `useSettingFlag("motion.reduced")`), the M59 follow transition, `frontend/src/components/Comments/CommentGutter.tsx` (marker fade)
- Test: `frontend/test/settings.notifications.test.tsx`, `frontend/test/settings.motion.gate.test.tsx`

**Interfaces — Frozen for D2:** the `notification.*` gates + `motion.reduced` consumer wiring. A **no-op `useMotionReducedForEffects()` stub** in a shared place that C's profile effects will consume (D2 makes it live) — so C7's tests can already assert the flag is readable.

- [ ] **Step 1: Write the failing tests:**

```tsx
it("notification.mentions=muted hides the tray card; the mention is still stored/logged (spy)", () => { /* … */ });
it("accessibility.motion=reduced removes the M58 attention pulse class", () => { /* … */ });
it("motion.reduced flag is readable by a profile-effect consumer stub", () => { /* … */ });
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — expect PASS.** Run `AttentionTray.test.tsx`, `Editor.attention.test.tsx`, `collab.follow.*`.
- [ ] **Step 5: Commit** — `feat(m61-b): notification preferences + functional reduced-motion gate`

---

### Task B9: Settings surface (two-pane, search) + export/import; delete `SettingsModal`

**Files:**
- Create: `frontend/src/components/Settings/SettingsSurface.tsx`, `frontend/src/components/Settings/SettingRow.tsx`
- Delete: `frontend/src/components/Settings/SettingsModal.tsx`
- Modify: `frontend/src/components/IDE/IDE.tsx` (mount `SettingsSurface`; `showSettings` + `ide-open-settings`; drop `SettingsModal` + `DEFAULT_PREFERENCES`), `frontend/src/components/Toolbar/Toolbar.tsx` (gear → `ide-open-settings`), the `CommandRegistry` consumer ("Open Settings")
- Test: `frontend/test/SettingsSurface.test.tsx`

**Interfaces:** `<SettingsSurface open onClose />` — portal `glass-floating`; left `role="tablist"` categories (arrow-nav); right = `SETTINGS.filter(byCategoryOrSearch)` grouped by `section` → `<SettingRow def />`; search filters across categories; Advanced = Reset-all / Export / Import / Reset-layout / `advanced.experimental.*`. `<SettingRow def />` picks the control by `def.control`, wires `useSetting(def.id)`, shows label/description/value/`⟲`. `useFocusTrap` (from A10).

- [ ] **Step 1: Write the failing tests:**

```tsx
it("categories; selecting Editor shows only editor settings", () => { /* … */ });
it("search 'cursor' → cross-category results labelled by category", () => { /* … */ });
it("changing a control applies live (no Save button) — data-theme updates on select", () => { /* … */ });
it("Export downloads JSON; Import with an out-of-range value clamps it, applies the rest", () => { /* mock createObjectURL + file input */ });
it("Reset section restores that category's defaults", () => { /* … */ });
it("Tab reaches every control; Esc closes; focus trapped", () => { /* … */ });
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Grep for remaining `SettingsModal` imports → fix (`IDE.tsx`).
- [ ] **Step 4: Run — expect PASS.** `npm run build`.
- [ ] **Step 5: Commit** — `feat(m61-b): searchable two-pane Settings surface + export/import`

---

### Task B-GATE: M61-B regression + browser acceptance + freeze

- [ ] **Step 1:** Full backend + frontend suites green; `npm run build` exit 0; `backend npm run typecheck`; `eslint` both 0 new.
- [ ] **Step 2:** One Chrome session: walk spec §10.2 steps 1–11. Screenshot theme + density change + search results. Verify the ~1249 px breadcrumb/Quick-Open overlap is **not worse** at 1024/1280/1440 with Settings open.
- [ ] **Step 3:** Freeze (evidence note): `SettingDef<T>`, `SettingsStore` public API, `useSetting`/`useSettingFlag`, `motion.reduced` flag key, `GET/PUT /api/auth/settings` shape, `CURRENT_SETTINGS_VERSION`, `<control>` primitive props.
- [ ] **Step 4: Commit** — `test(m61-b): B-GATE — regression + browser acceptance + frozen interfaces`

---

# WORKSTREAM M61-C — Profile Identity & Customization

*Depends on A1 (schema) + A2 (`broadcastProfileEvent`). Uses B's `useSettingFlag("motion.reduced")` if B-GATE is green; otherwise a local `matchMedia('(prefers-reduced-motion)')` fallback (D2 unifies).*

### Task C1: Badge catalog + profile validation (pure)

**Files:**
- Create: `backend/src/profile/badges.ts`, `backend/src/profile/validate.ts`
- Test: `backend/test/m61-profile-pure.test.ts`

**Interfaces — Frozen for C3, C4, C7:**
- `badges.ts`: `USER_BADGE_CATALOG: Record<string, { emoji: string; label: string }>` (~10: `cloud`, `systems`, `typescript`, `react`, `docker`, `ai`, `testing`, `ui`, `python`, `rust`); `isGrantableBadge(id): boolean`; `roleBadgesFor({ platformRole }, { projectRole? }): { id: string; label: string }[]` (`admin` / `owner` / `maintainer` / `contributor` — derived, never stored).
- `validate.ts`: caps `NAME_MAX=64, BIO_MAX=400, PRONOUNS_MAX=32, LOCATION_MAX=64, STATUS_MAX=128, LINK_LABEL_MAX=40, LINK_URL_MAX=200`; `MAX_BADGES=6, MAX_LINKS=5, MAX_FEATURED=8`; `sanitizeProfileText(v, max): string | null`; `isHttpsUrl(v): boolean` (rejects `javascript:`/`data:`, requires `https:`); `GITHUB_HOSTS = new Set(["github.com","www.github.com"])`; `BANNER_KINDS`/`PROFILE_EFFECTS`/`AVAILABILITY_DEFAULTS` sets; `isHex6(v)`; `contrastOk(hex, base)`; `clampStatusExpiry(iso, maxMs): string | null`.

- [ ] **Step 1: Write the failing tests:**

```ts
it("badge grant rules", () => {
  expect(isGrantableBadge("docker")).toBe(true);
  expect(isGrantableBadge("admin")).toBe(false);
  expect(roleBadgesFor({ platformRole: "admin" }, {}).map(b => b.id)).toContain("admin");
  expect(roleBadgesFor({ platformRole: "user" }, { projectRole: "owner" }).map(b => b.id)).toContain("owner");
});
it("profile text: sanitize + caps", () => {
  expect(sanitizeProfileText("a\x00b", 64)).toBe("ab");
  expect(sanitizeProfileText("x".repeat(500), 400)).toBeNull();
  expect(sanitizeProfileText("  ", 64)).toBeNull();
});
it("url rules: https only, github host-locked", () => {
  expect(isHttpsUrl("https://example.com")).toBe(true);
  expect(isHttpsUrl("javascript:alert(1)")).toBe(false);
  expect(isHttpsUrl("http://x.com")).toBe(false);
});
it("status expiry clamped to <= 24h", () => {
  const far = new Date(Date.now() + 100 * 3600e3).toISOString();
  expect(new Date(clampStatusExpiry(far, 24*3600e3)!).getTime()).toBeLessThanOrEqual(Date.now() + 24*3600e3 + 2000);
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — expect PASS.** `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(m61-c): profile badge catalog + field validation`

---

### Task C2: Profile media pipeline

**Files:**
- Create: `backend/src/profile/media.ts`
- Modify: `backend/src/config.ts` (`profileMediaAvatarMaxBytes=512*1024`, `profileMediaBannerMaxBytes=2*1024*1024`, `profileMediaDir = join(dataDir, "profile-media")`)
- Test: `backend/test/m61-profile-media.test.ts` (fixture buffers: tiny real PNG/JPEG/WebP, an SVG, an HTML file, a PNG with a 5000×5000 IHDR)

**Interfaces — Frozen for C4:**
- `parseImage(buffer): { mime: "image/png"|"image/jpeg"|"image/webp"; width: number; height: number } | { error: string }` — magic-byte sniff + per-format header dimension reader (PNG IHDR; JPEG SOFn scan; WebP VP8/VP8L/VP8X). Declared content-type ignored.
- `validateImage(buffer, kind: "avatar"|"banner", cfg): { ok: true; mime; width; height } | { ok: false; reason: string }` — + size cap + dimension caps (avatar ≤1024², banner ≤3840×1440, ≥32) + SVG/HTML rejection.
- `storeMedia(db, cfg, userId, kind, buffer, meta): { id: string }` — write `<profileMediaDir>/<userId>/<uuid>.<ext>`, insert row, delete+unlink the previous row of that kind.
- `mediaPathFor(db, cfg, mediaId): { path: string; mime: string } | null`; `deleteMedia(db, cfg, mediaId)`.

- [ ] **Step 1: Write the failing tests:**

```ts
it("accepts a real PNG regardless of declared type; rejects SVG and HTML-as-png", () => {
  expect(validateImage(PNG_1x1, "avatar", cfg)).toMatchObject({ ok: true, mime: "image/png" });
  expect(validateImage(SVG_BYTES, "avatar", cfg).ok).toBe(false);
  expect(validateImage(HTML_BYTES, "avatar", cfg).ok).toBe(false);
});
it("rejects oversize bytes and over-dimension images", () => {
  expect(validateImage(Buffer.alloc(cfg.profileMediaAvatarMaxBytes + 1, 0), "avatar", cfg).ok).toBe(false);
  expect(validateImage(PNG_5000x5000_header, "avatar", cfg).ok).toBe(false);
});
it("storeMedia writes under profileMediaDir/<userId>/<uuid> and replaces the previous row", () => {
  const a = storeMedia(db, cfg, 1, "avatar", PNG_1x1, { mime:"image/png", width:1, height:1 });
  const b = storeMedia(db, cfg, 1, "avatar", PNG_1x1, { mime:"image/png", width:1, height:1 });
  expect((db.prepare("SELECT COUNT(*) c FROM profile_media WHERE user_id=1 AND kind='avatar'").get() as any).c).toBe(1);
  expect(mediaPathFor(db, cfg, a.id)).toBeNull();
  expect(mediaPathFor(db, cfg, b.id)!.mime).toBe("image/png");
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — `mkdirSync(recursive)`; dimension readers ~15 lines each.
- [ ] **Step 4: Run — expect PASS.** `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(m61-c): profile image validation + storage pipeline`

---

### Task C3: Profile DB store + `buildPublicProfile`

**Files:**
- Create: `backend/src/profile/store.ts`, `backend/src/profile/publicProfile.ts`
- Test: `backend/test/m61-profile-store.test.ts`

**Interfaces — Frozen for C4, C5:**
- `store.ts`: `getOwnProfile(db, userId)`, `putProfile(db, userId, patch)` (validated fields only, ignores unknown/identity keys), `putStatus(db, userId, {emoji,text,expiresAt})` / `clearStatus`, `sweepExpiredStatuses(db): number[]`, `putBadges(db, userId, [{badgeId,position}])` (drops non-grantable), `putLinks`, `putFeatured(db, userId, projectIds, isAllowed: (pid) => boolean)`, `putPrivacy(db, userId, flags)`.
- `publicProfile.ts`: `buildPublicProfile(db, targetId, viewerId, projectId?): PublicProfile | null` — `null` iff `profile_visibility='private'` AND `viewerId !== targetId` AND `projectId` is undefined (the *page* path). The `projectId` path always returns essential identity. Identity (`userId`, `username`, `displayName || username`, `role`) copied from `users` + `project_collaborators`. `location`/`links`/`recentHistory`/`currentFile` gated by the privacy flags relative to `viewerId` (self always sees all).
- `PublicProfile` shape (frozen — hand-sync to `frontend/src/types.ts` as `PublicProfileDTO`): `{ userId, username, displayName, role, accent, avatarMediaId: string|null, avatarVersion: number, badges: {id,emoji,label}[], roleBadges: {id,label}[], customStatus: {emoji,text,expiresAt}|null, pronouns?, location?, links?: {kind,label,url}[], bio?, effect, bannerKind, bannerValue?, bannerMediaId?: string|null }`.

- [ ] **Step 1: Write the failing tests:**

```ts
it("buildPublicProfile always exposes identity; hides location when show_location=0", () => {
  const db = seedUsers();
  putProfile(db, 2, { displayName: "Rahul", location: "Berlin", bio: "hi" });
  putPrivacy(db, 2, { show_location: 0 });
  const p = buildPublicProfile(db, 2, 1, "proj")!;
  expect(p.userId).toBe(2); expect(p.username).toBeTruthy(); expect(p.role).toBeTruthy();
  expect(p.location).toBeUndefined();
  expect(p.bio).toBe("hi");
});
it("private visibility: null on the page path, essential identity on the projects path", () => {
  const db = seedUsers(); putPrivacy(db, 2, { profile_visibility: "private" });
  expect(buildPublicProfile(db, 2, 1, undefined)).toBeNull();
  expect(buildPublicProfile(db, 2, 1, "proj")!.username).toBeTruthy();
});
it("putBadges drops non-catalog ids; role badges never stored", () => { /* … */ });
it("putFeatured drops projects the user cannot access", () => { /* isAllowed=()=>false → [] */ });
it("sweepExpiredStatuses clears and returns affected userIds", () => { /* … */ });
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — expect PASS.** `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(m61-c): profile DB store + privacy-filtered public profile`

---

### Task C4: Profile REST + media serve + status sweep + `profile_event`

**Files:**
- Create: `backend/src/profile/routes.ts`
- Modify: `backend/src/app.ts` (register; `express` route `GET /api/users/:id/avatar` + `/banner` → `res.sendFile` with forced headers; start the status-sweep `setInterval`), `backend/src/index.ts` (clear the sweep timer in graceful shutdown), `backend/src/audit.ts` (`PROFILE_UPDATED`, `PROFILE_MEDIA_UPLOADED`), `backend/test/helpers.ts` (add `api.postMultipart` / `api.getRaw` if absent)
- Test: `backend/test/m61-profile-routes.test.ts`

**Interfaces — Frozen for C5:** all routes of spec §6.4. `PUT /users/me/*` → validate → `store.*` → `recordAuditLog` → for each project the user is a member of: `collaborationManager.broadcastProfileEvent(projectId, { userId })`. `GET /api/users/:id/avatar` → `mediaPathFor` → `res.set({ "Content-Type": mime, "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline", "Content-Security-Policy": "default-src 'none'", "Cache-Control": "private, max-age=300" }).sendFile(path)`; 404 if none. Sweep: `setInterval(() => { for (const uid of sweepExpiredStatuses(db)) forEachProject(uid, pid => collaborationManager.broadcastProfileEvent(pid, { userId: uid })); }, cfg.customStatusSweepMs).unref()`.

- [ ] **Step 1: Write the failing tests:**

```ts
it("PUT /users/me/profile validates + persists; username not settable", async () => { /* body {username:"hax"} ignored */ });
it("PUT /users/me/badges drops 'admin'; role badge still shown via GET (derived)", async () => { /* … */ });
it("PUT /users/me/links rejects javascript: and non-github host for kind=github", async () => { /* … */ });
it("avatar upload: PNG accepted (declared text/html ignored), SVG rejected; served with forced type + nosniff", async () => {
  const { api, owner } = await startTestApi();
  expect((await api.postMultipart("/api/users/me/avatar", { file: ["a.png", PNG_1x1, "text/html"] }, owner)).status).toBe(200);
  const img = await api.getRaw(`/api/users/${owner.id}/avatar`, owner);
  expect(img.headers["content-type"]).toBe("image/png");
  expect(img.headers["x-content-type-options"]).toBe("nosniff");
  await api.postMultipart("/api/users/me/avatar", { file: ["x.svg", SVG_BYTES, "image/svg+xml"] }, owner, 400);
});
it("GET /projects/:id/profiles: privacy-filtered bundle for members; 404 for non-member", async () => { /* … */ });
it("any profile PUT broadcasts profile_event to the user's project rooms (spy)", async () => { /* … */ });
it("XSS payload in bio stored + returned literally", async () => { /* … */ });
it("cross-user: PUT /users/me/* only writes the session user; another user's media id dropped", async () => { /* … */ });
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — expect PASS.** Full suite for regression. `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(m61-c): profile REST, media serving, status expiry sweep`

---

### Task C5: Frontend `IdentityStore` + profile API + client wiring

**Files:**
- Create: `frontend/src/collab/identity.ts`, `frontend/src/profile/api.ts`
- Modify: `frontend/src/collab/client.ts` (confirm the `profile_event` branch from A8), `frontend/src/types.ts` (`PublicProfileDTO`, `ProfileEventWire`)
- Test: `frontend/test/collab.identity.test.ts`

**Interfaces — Frozen for C6, C7, D1, D2:**
- `identity.ts`: `class IdentityStore { constructor(projectId: string); hydrate(): Promise<void>; get(userId: number): PublicProfile /* real or synthetic fallback {displayName: presenceName ?? String(userId), accent: getUserColor(userId), avatarMediaId: null, avatarVersion: 0, badges: [], roleBadges: [], effect: "none", bannerKind: "none"} */; applyEvent(ev: ProfileEventWire): void /* throttled scoped refetch */; on(cb: () => void): () => void; dispose(): void }`.
- `useIdentity(userId): PublicProfile` hook.
- `api.ts`: `getProjectProfiles(projectId)`, `getMyProfile`, `putProfile`, `putStatus`, `clearStatus`, `putBadges`, `putLinks`, `putFeatured`, `putPrivacy`, `uploadAvatar(file)`, `uploadBanner(file)`, `deleteAvatar`, `deleteBanner`, `getUserProfile(id)`, `exportProfile`, `importProfile`.

- [ ] **Step 1: Write the failing tests:**

```ts
it("get() → synthetic fallback before hydrate, real profile after", async () => {
  const s = new IdentityStore("p");
  expect(s.get(7)).toMatchObject({ userId: 7, displayName: expect.any(String), accent: expect.any(String) });
  vi.spyOn(api, "getProjectProfiles").mockResolvedValue([{ userId: 7, username: "rahul", displayName: "Rahul", role: "editor", accent: "#f38ba8", badges: [], roleBadges: [], effect: "none", bannerKind: "none", avatarMediaId: null, avatarVersion: 0, customStatus: null }]);
  await s.hydrate();
  expect(s.get(7).displayName).toBe("Rahul");
});
it("applyEvent throttles + scopes refetch (two events for user 7 → one getProjectProfiles or one getUserProfile(7))", async () => { /* … */ });
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — expect PASS.** `npm run build`.
- [ ] **Step 5: Commit** — `feat(m61-c): frontend IdentityStore + profile API`

---

### Task C6: Identity primitives

**Files:**
- Create: `frontend/src/components/common/identity/{CollaboratorAvatar,CollaboratorName,CollaboratorCard}.tsx` + `index.ts`
- Modify: `frontend/src/components/Collab/CollaboratorAvatarStack.tsx` (self-avatar menu → "Edit profile" via `ide-open-profile`; **do not retrofit the rest yet — that is D1**)
- Test: `frontend/test/identity.primitives.test.tsx`

**Interfaces — Frozen for C7, D1:**
- `<CollaboratorAvatar userId: number size: number ring?: boolean />` — `<img src={`/api/users/${userId}/avatar?v=${avatarVersion}`}>` with `onError` → `<div>` initials + accent (from `useIdentity`).
- `<CollaboratorName userId: number showRole?: boolean />` — display name, `style={{ color: accentTextSafe(accent) }}`, optional role chip.
- `<CollaboratorCard userId: number compact?: boolean presence?: CollaboratorPresence />` — banner (kind-driven), avatar, name, `@username`, badges (user then role), `customStatus` line, `🟢 availability`, then **live** `presence` activity/file/intent (from the prop, not a store), `[View profile]` → `ide-open-profile-page` `{userId}`. `compact` = the popover subset.

- [ ] **Step 1: Write the failing tests:**

```tsx
it("CollaboratorAvatar shows the image, falls back to initials on error", () => {
  render(<CollaboratorAvatar userId={7} size={24} />, { wrapper: withIdentity({ 7: { displayName: "Rahul K", accent: "#f38ba8", avatarVersion: 3, avatarMediaId: "m" } }) });
  fireEvent.error(screen.getByRole("img"));
  expect(screen.getByText("RA")).toBeInTheDocument();
});
it("CollaboratorCard: custom status distinct from live activity", () => {
  render(<CollaboratorCard userId={7} presence={presenceEditing("auth.ts")} />, { wrapper: withIdentity({ 7: { customStatus: { emoji: "🐳", text: "Building" } } }) });
  expect(screen.getByText(/Building/)).toBeInTheDocument();
  expect(screen.getByText(/auth\.ts/)).toBeInTheDocument();
});
it("another user's accent does not affect the local user's own card", () => { /* render two cards, assert */ });
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — expect PASS.** `npm run build`. Run `CollaboratorAvatarStack.test.tsx` (self-menu change only).
- [ ] **Step 5: Commit** — `feat(m61-c): identity render primitives (avatar/name/card)`

---

### Task C7: Profile editor + live preview + export/import

**Files:**
- Create: `frontend/src/components/Profile/ProfileSurface.tsx`, `frontend/src/components/Profile/ProfilePreview.tsx`, section components
- Modify: `frontend/src/components/IDE/IDE.tsx` (mount `ProfileSurface`; `ide-open-profile` listener), the `CommandRegistry` consumer ("Edit my profile"), `frontend/src/components/Settings/SettingsSurface.tsx` (header link → `ide-open-profile`)
- Test: `frontend/test/ProfileSurface.test.tsx`

**Interfaces:** `<ProfileSurface open onClose />` — portal; left section nav; right = active section form; a persistent `<ProfilePreview draft />` pane rendering `<CollaboratorCard>` + compact popover from an override identity seeded by `draft` (not the live store). Each section `PUT`s its own slice on Save; "Discard" reverts. Avatar/banner via hidden file input → `profileApi.uploadAvatar` → bump a local `avatarVersion` for the preview.

- [ ] **Step 1: Write the failing tests:**

```tsx
it("live preview updates on avatar/banner/accent/status/badges/bio/privacy before save", () => {
  render(<ProfileSurface open onClose={()=>{}} />, { wrapper: withProfile(baseProfile) });
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Rahul K" } });
  expect(within(screen.getByTestId("profile-preview")).getByText("Rahul K")).toBeInTheDocument();
});
it("a low-contrast profile accent hex is rejected inline, not previewed", () => { /* … */ });
it("Save calls the matching slice endpoint; Discard reverts the draft", () => { /* spy profileApi.putProfile */ });
it("import with a javascript: link drops that link, applies the rest", () => { /* … */ });
it("reduced-motion renders the 'pulse' effect preview as a static glow", () => { /* … */ });
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Badge reorder = up/down buttons (keyboard-accessible) or HTML5 DnD.
- [ ] **Step 4: Run — expect PASS.** `npm run build`.
- [ ] **Step 5: Commit** — `feat(m61-c): profile editor with live preview + export/import`

---

### Task C8: Profile page — recent history + featured projects

**Files:**
- Modify: `backend/src/profile/routes.ts` (`GET /api/users/:id/profile` adds `recentHistory` = `queryTimeline` filtered to that user across viewer∩target shared projects (cap 20) when `show_recent_history` + a shared project exists; `featured` = `user_featured_projects` ⨝ `projects` when `show_featured`)
- Create: `frontend/src/components/Profile/ProfilePage.tsx`
- Modify: `frontend/src/components/IDE/IDE.tsx` (`ide-open-profile-page` listener → mount `<ProfilePage userId>`)
- Test: `backend/test/m61-profile-page.test.ts`, `frontend/test/ProfilePage.test.tsx`

**Interfaces:** `GET /api/users/:id/profile` → `{ profile: PublicProfile, recentHistory?: TimelineEvent[], featured?: {id,name,description,language}[] }`.

- [ ] **Step 1: Write the failing tests:**

```ts
it("recent history included only when show_recent_history + a shared project", async () => { /* … */ });
it("featured projects the viewer cannot open are still listed by name+desc (no file access)", async () => { /* … */ });
```
```tsx
it("ProfilePage: identity, badges, links (rel=noopener noreferrer nofollow), history rows, featured cards", () => { /* … */ });
it("private profile → 'This profile is private' for a non-owner", () => { /* … */ });
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — expect PASS.** `npm run build`; `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(m61-c): profile page — recent history + featured projects`

---

### Task C-GATE: M61-C regression + browser acceptance + freeze

- [ ] **Step 1:** Full backend + frontend suites green; `npm run typecheck`; `npm run build`; `eslint` — 0 new. M57–M60 regression green.
- [ ] **Step 2:** Two Chrome sessions, Docker up: walk spec §10.3 steps 1–13. Screenshot: profile editor + live preview, session B's view of A's card (location hidden), SVG rejection, reduced-motion effect downgrade.
- [ ] **Step 3:** Freeze (evidence note): `PublicProfile` / `PublicProfileDTO` shape, `IdentityStore` public API, `profile_event` wire shape, `<CollaboratorAvatar/Name/Card>` props, `GET /api/projects/:id/profiles` bundle shape.
- [ ] **Step 4: Commit** — `test(m61-c): C-GATE — regression + browser acceptance + frozen interfaces`

---

# WORKSTREAM M61-D — Cross-system integration + regression + browser

*Runs only after A-GATE, B-GATE, C-GATE are all green (interfaces frozen).*

### Task D1: Retrofit every collaborator surface to the identity primitives

**Files:**
- Modify: `frontend/src/components/Collab/CollaboratorAvatarStack.tsx` (delete the inline avatar `<div>`s at ~236–275, ~363–379, and the two popover identity blocks → `<CollaboratorAvatar>` / `<CollaboratorName>` / compact `<CollaboratorCard>`; keep Follow/Jump + the M59 focus block), `frontend/src/components/Collab/TeamPanel.tsx` (dots → `<CollaboratorAvatar size={16}>`; name → `<CollaboratorName>`), `frontend/src/components/Collab/FollowBanner.tsx`, `frontend/src/components/Collab/ActivityTimeline.tsx` (actor cell → `<CollaboratorName>`), `frontend/src/components/Collab/WhileYouWereAway.tsx`, `frontend/src/components/Comments/CommentThread.tsx` + `CommentsPanel.tsx` (swap the A10 local `c-avatar` fallback → `<CollaboratorAvatar>` / `<CollaboratorName>`), `frontend/src/components/Comments/mentionText.tsx` consumers (mention chip → `<CollaboratorName>` styling), `frontend/src/components/IDE/IDE.tsx` (`IdentityStore` lifecycle alongside `CommentStore`; `client.on("profile_event", ev => identityStore.applyEvent(ev))`)
- Test: `frontend/test/identity.retrofit.test.tsx` + re-run every retrofitted surface's existing suite

**Interfaces:** no new — consumes the frozen C6 primitives + C5 store.

- [ ] **Step 1: Write the failing tests:**

```tsx
it("CollaboratorAvatarStack still opens the popover; Follow/Jump still fire", () => { /* run the existing assertions against the retrofit */ });
it("comment author row + mention chip + timeline actor all render the same identity for a given userId", () => { /* one IdentityStore entry → assert all three surfaces show that displayName + accent */ });
it("remote cursor label stays name-only (no card)", () => { /* Editor remote label — text only */ });
it("a profile_event refreshes the avatar in the stack, TeamPanel, and a comment row without a reload", () => { /* mock getUserProfile new avatarVersion → all three <img src> update */ });
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — expect PASS.** Run `CollaboratorAvatarStack.test.tsx`, `TeamPanel.test.tsx`, `collab.follow.*`, `ActivityTimeline.test.tsx`, `AttentionTray.test.tsx`, `CommentThread.test.tsx`, `CommentsPanel.test.tsx` — all green. `npm run build`.
- [ ] **Step 5: Commit** — `feat(m61-d): one identity model — retrofit every collaborator surface`

---

### Task D2: Wire the cross-system seams

**Files:**
- Modify: `frontend/src/components/Collab/AttentionTray.tsx` (the A11 "always shown" mention/comment cards now gated by `notification.mentions` / `notification.comments` — the B8 gate hooks), the B8 `useMotionReducedForEffects()` stub → real (reads `useSettingFlag("motion.reduced")`), Track C profile effects (`CollaboratorCard` / `ProfilePreview`) consume it, `frontend/src/components/Collab/ActivityTimeline.tsx` (render `kind:"comment"` rows with `<CollaboratorName>` + navigate via `openAndRevealLocation`), M58 "Come look here" → if the target is a comment context, open the thread + focus the anchored code (compose M58 `attention_request` + M61-A `handleCommentNavigate`)
- Test: `frontend/test/crosssystem.seams.test.tsx`

- [ ] **Step 1: Write the failing tests:**

```tsx
it("notification.mentions=muted now hides the A11 mention card (gate is live)", () => { /* … */ });
it("accessibility.motion=reduced disables a profile 'pulse' effect in CollaboratorCard", () => { /* … */ });
it("a comment lifecycle timeline row navigates to the file+anchor line via openAndRevealLocation", () => { /* … */ });
it("M58 'Come look' whose target is a comment opens the thread + focuses the anchored code", () => { /* … */ });
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — expect PASS.** Regression: `AttentionTray.test.tsx`, `Editor.attention.test.tsx`, `collab.follow.*`, `ActivityTimeline.test.tsx`. `npm run build`.
- [ ] **Step 5: Commit** — `feat(m61-d): wire cross-system seams (notifications, motion, timeline, attention→comment)`

---

### Task D3: Cross-system browser acceptance

**Files:** evidence note only.

- [ ] **Step 1:** Two authenticated Chrome sessions, Docker up. Walk spec §10.4 steps 1–10. Screenshot: A's profile in B's card + comment row + timeline actor (one identity); the avatar updating everywhere on a `profile_event` with no reload; presence updating without a profile mutation.
- [ ] **Step 2:** Re-walk spec §10.1 (comments) + §10.2 (settings) quickly to confirm the D1 retrofit + D2 seams didn't regress comment author rows / mention chips / timeline actors / settings.
- [ ] **Step 3:** Clean up test users, uploaded media, comments.
- [ ] **Step 4: Commit** — `test(m61-d): cross-system browser acceptance evidence`

---

### Task D4: Performance-proof test suite

**Files:**
- Create: `backend/test/m61-performance.test.ts`, `frontend/test/m61-performance.test.tsx`
- Test: those files

**Interfaces:** implements spec §9.7 items 1–9 as revert-failing assertions.

- [ ] **Step 1: Write the failing tests** — one `it` per §9.7 item:

```ts
// backend
it("no profile write touches Yjs / awareness", async () => { /* spy room.doc.transact + awareness.setLocalState → 0; doc.share.size unchanged */ });
it("no customStatus key in the authoritative awareness state", () => { /* … */ });
it("comment_event / profile_event frames carry no body", () => { /* assert fixed shape */ });
```
```tsx
// frontend
it("no comment persistence on the typing hot path", () => { /* Y.Text edits with an open thread → 0 comment API calls */ });
it("a settings change does not re-render IDE/Sidebar/TeamPanel", () => { /* render spies → 0; only Editor.updateOptions */ });
it("IdentityStore update is scoped to the changed user", () => { /* profile_event for X → only X refetched, other subscribers not notified */ });
it("comment refresh is scoped to the changed file", () => { /* comment_event for a.ts → only a.ts refetched */ });
it("no polling loops in M61 frontend modules", () => { /* static: grep the M61 dirs for setInterval → only allowed tickers */ });
it("local history is bounded (comment store evicts closed files; mention cards <= 10)", () => { /* … */ });
```

- [ ] **Step 2: Run — expect FAIL** (write the assertions first, then confirm the implementation already satisfies them; if any fails, fix the implementation — these are the real guarantees).
- [ ] **Step 3: Make green** — fix any real violation found.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `test(m61-d): performance-proof suite`

---

### Task D5: Adversarial security sweep

**Files:**
- Create: `backend/test/m61-security.test.ts`, `frontend/test/m61-security.test.ts`
- Test: those files

**Interfaces:** implements spec §9.8 (comments / profile / settings adversarial cases) as one `it` per case.

- [ ] **Step 1: Write the failing tests** — the full §9.8 list. Examples:

```ts
it("comment: spoofed author.userId in the body is ignored (row carries the session id)", async () => { /* … */ });
it("comment: forged mention target (cross-project / non-member / arbitrary) dropped", async () => { /* … */ });
it("comment: hostile anchor blob → stale, never an exception, never unrelated code", async () => { /* … */ });
it("profile: PUT /users/me/* cannot write another user's rows", async () => { /* … */ });
it("profile: 'admin' badge id in PUT /badges dropped; role badge derived", async () => { /* … */ });
it("profile: SVG / HTML-as-PNG / oversize / over-dimension image rejected", async () => { /* … */ });
it("profile: no field accepts CSS / HTML / a token map (enums + validated hex only)", async () => { /* … */ });
it("settings: oversize import (>64KiB) / >300 keys / malformed JSON rejected", () => { /* … */ });
it("settings: no setting id maps to an authz concept (banned-substring assertion)", () => { /* … */ });
it("settings: user_settings.data only readable by its owner", async () => { /* user B GET → their own default, not A's */ });
```

- [ ] **Step 2: Run — expect FAIL** (or PASS if the implementation already holds — then the test is the regression guard).
- [ ] **Step 3: Fix** any real hole found.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `test(m61-d): adversarial security sweep`

---

### Task D6: Full regression + STATUS.md close

**Files:**
- Modify: `STATUS.md` (`## Milestone 61` section), `frontend/src/types.ts` (final M61 section review), confirm `backend/test/migrations.test.ts` v12
- Test: full suites

- [ ] **Step 1:** `cd backend && npx vitest run` — record `N passed / 0 failed / M skipped`. Confirm `m57-presence`, `m58-attention`, M59, `m60-*`, `m4-collab`, `collab-awareness-security`, `migrations`, all `m61-*` green.
- [ ] **Step 2:** `cd frontend && npx vitest run` — record counts; confirm `collab.*`, `Editor.eol`, `Editor.viewstate`, `AttentionTray`, `TeamPanel`, `CollaboratorAvatarStack`, `ActivityTimeline`, all `m61`/`Comments`/`settings`/`Profile`/`identity` green.
- [ ] **Step 3:** `cd backend && npm run typecheck` (exit 0); `cd frontend && npm run build` (exit 0); `eslint` both — 0 new errors. `git diff --check`.
- [ ] **Step 4:** EOL regression: locally revert `Editor.eol.test.tsx`'s guarded change → it fails → restore (the M60 closeout ritual).
- [ ] **Step 5:** Write the `## Milestone 61` STATUS.md section: objective, the four-workstream architecture + dependency graph, anchoring decision, comment/settings/profile data models, the persistence decision (six profile tables, privacy folded), security/privacy model, the full acceptance matrix (every spec §9 + §10 criterion → PROVEN / PARTIAL + evidence), browser-pass tables, known limitations, "M61 CLOSED". Update "Next recommended milestone": M61 closed; the sole open product-decision item remains the real AI provider. **Do not commit — leave the tree for the user's review.**

---

## Self-Review

**1. Spec coverage:**

| Spec section | Workstream · Task(s) |
|---|---|
| §2 / §8 layer model (tests assert separation) | A2 (transport ignore), B3 (no authz id), C3 (identity always exposed), D4, D5 |
| §4.2 anchoring (RelativePosition + fingerprint + slice + stale + recovery) | A3 |
| §4.3 comment tables (+ `anchor_prefix`) | A1 |
| §4.4 REST API | A6 |
| §4.5 `comment_event` live | A2, A6, A8 |
| §4.6 mentions → notification | A6 (delivery), A11 (tray), B8+D2 (gate) |
| §4.7 reactions (fixed set) | A4, A5, A6 |
| §4.8 comment UI (marker/hover/popover/panel/file badge/nav/callout→comment) | A9, A10, A11 |
| §4.9 M60 timeline integration | A7, D2 (nav + actor identity) |
| §4.10 Track A security | A4, A5, A6, D5 |
| §5.1 registry / §5.2 store | B3, B5 |
| §5.3 scoping + `user_preferences` fold | A1 (copy), B4, B5 |
| §5.4 theme/token/accent/density/editor theme | B2, B6 |
| §5.5 settings UI + search | B9 |
| §5.6 keyboard | B3 (keys), B7 |
| §5.7 accessibility (motion gate, contrast, textScale, focus) | B2 (tokens), B8 (gate), B9 (a11y tests), D2 (profile effects) |
| §5.8 layout | B3, B6 |
| §5.9 notifications | B3, B8, D2 |
| §5.10 reset/export/import | B5, B9 |
| §5.11 versioned schema | B3 (migrations.ts), B5 |
| §5.12 Track B security | B3 (authz-id test), B5 (import), D5 |
| §6.3 profile tables (privacy folded, six tables) | A1 |
| §6.4 profile REST | C4 |
| §6.5 appearance + accent blast radius | C6, C7 (isolation test) |
| §6.6 badges (user + role) | C1, C3, C4 |
| §6.7 image security (single pipeline) | C2, C4, D5 |
| §6.8 privacy (hard identity invariant) | C3, C4, D5 |
| §6.9 profile export/import | C7 |
| §6.10 profile editor + live preview | C7 |
| §6.11 shared identity architecture | C5, C6, D1 |
| §6.12 Track C security | C1–C4, D5 |
| §7 cross-track integration | D1, D2 |
| §9 testing | every task Step 1 + gate tasks + D4 + D5 |
| §9.7 performance proofs | D4 |
| §9.8 adversarial security | D5 |
| §10.1 / §10.2 / §10.3 / §10.4 browser acceptance | A-GATE / B-GATE / C-GATE / D3 |
| §13 resolved decisions | A1 (`anchor_prefix`), A11 (panel placement), A9 (marker visibility), B4 (`user_preferences`), A4 (reactions), A3 (anchor recovery), C-anywhere (no custom status in awareness — asserted D4), B2 (4 themes), C7 (banner presets), A1/C3 (six profile tables) |
| §14 workstream structure + dependency graph | the whole plan's shape; gate tasks A-/B-/C-GATE + D6 |

No gaps. Decision §13.6 (no custom status in awareness) has no "add" task — it is an absence, guarded by D4 test #2.

**2. Placeholder scan:** UI-heavy tasks (A6, A11, C4, C7, C8, D1, D2, D5) use `/* … */` inside `it(...)` blocks whose title names the exact behavior + references the spec §9 line; the non-obvious logic (A3 anchor math, A5 store, A2 transport, B3 registry, B5 store, C2 media, C3 publicProfile, C5 identity) is spelled out in full with real code. Acceptable under the "skilled developer" assumption — the crux is never elided. D4/D5 explicitly say "write the assertion first; if the implementation already satisfies it, the test is the regression guard; if not, fix the implementation" — no placeholder, a defined procedure.

**3. Type consistency:**
- `encodeAnchor` → `{relStart, relEnd, slice, startLine, endLine, prefixHash}` — matches A1's `comment_threads` columns (`anchor_prefix` = `slice`, `anchor_prefix_hash` = `prefixHash`), A4 `isAnchorPayload`, A5 `createThread`'s `anchor` param, A6 request body, A3 `resolveAnchor` input. Consistent.
- `broadcastCommentEvent` / `sendCommentMentionTo` / `broadcastProfileEvent` — same names A2 (define), A6 + C4 (call), A8 (client emit).
- `comment_event = {type, threadId, filePath, kind, at}` — A2 test, A6 impl, A8 guard, D4 shape assertion. Consistent.
- `PublicProfile` shape — defined C3, hand-synced to `PublicProfileDTO` (C5), consumed C6/C7/C8/D1; `avatarVersion` bumped after upload (C7) and used for cache-busting in `<CollaboratorAvatar>` (C6).
- `buildPublicProfile(db, targetId, viewerId, projectId?)` — C3 / C4 / C8 identical.
- `useSettingFlag` / `setContextFlag` / `"motion.reduced"` flag key — B5 (define) / B6 / B8 / C7 / D2. Consistent.
- `SettingsStore` `setScoped(id, v, scope)` + `set(id, v)` — B5 defines both; B6/B9 use `set`; the B5 precedence test uses `setScoped`.
- `IdentityStore` `get` / `hydrate` / `applyEvent` / `on` / `dispose` — C5 defines, C6/C7/D1 consume.
- `CommentStore` `load` / `threadsFor` / `unresolved` / `applyEvent` / `on` / `dispose` — A8 defines, A9/A10/A11/D1 consume.

**Cross-workstream dependency check:** B → A1 only (migration). C → A1 + A2 (`broadcastProfileEvent`). D → A-GATE + B-GATE + C-GATE. A uses a local `c-avatar` initials fallback (A10) → D1 swaps `<CollaboratorAvatar>`. B8's profile-effect motion consumer is a stub → D2 makes it real. A11's tray mention cards are ungated → D2 adds the `notification.*` gate. All three cross-workstream seams are explicitly a D task, not a hidden dependency.

**Stoppability:** each `*-GATE` task ends at green tests + browser acceptance + frozen interfaces; stopping after A-GATE ships working comments (with fallback avatars), after B-GATE adds working customization, after C-GATE adds a working profile editor + primitives, and D is pure integration polish + hardening. Every task has files · frozen-interface block (where relevant) · failing test · implementation · verification · commit · rollback (revert the task's commit).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-31-m61-contextual-comments-customization.md`. It is structured as four independently-gated workstreams (M61-A → A-GATE → M61-B → B-GATE → M61-C → C-GATE → M61-D), 34 tasks, each with its own test cycle and rollback; execution can stop cleanly at any gate.**

**Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, two-stage review between tasks. Best for a plan this size; the gate tasks are natural human-review checkpoints.

**2. Inline Execution** — tasks executed in this session via executing-plans, batch execution with checkpoints at each gate.

**Which approach?** (And: begin at M61-A Task A1, or is there anything in the restructured spec/plan to adjust first?)
