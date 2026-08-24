# Save-Truthfulness Verification Plan (Milestone M1)

**Bug class:** BUG-1 (P0 data loss). Since commit `cc55a1a`, `openFiles[].content`
freezes at file-open time; every save consumer that read it persisted stale
bytes. M1 introduces a live-model-backed save primitive and funnels all save
triggers through one canonical `ide-save` contract.

**Changed files:**

- `frontend/src/components/Editor/Editor.tsx` — `liveModels` registry,
  `getLiveContent()` / `applyLiveContent()` exports, `LiveContentApi` ref
  wiring, registry pruning/detach lifecycle.
- `frontend/src/components/IDE/IDE.tsx` — `resolveLiveFileContent()`,
  `dispatchCanonicalSave()`, canonical `ide-save` listener, run auto-save loop
  (live content + success-only dirty clearing), format-document model-first
  application, palette/keyboard rewiring.
- `frontend/src/hooks/useKeyboardShortcuts.ts` — Ctrl+S dispatches the
  canonical event with `{ path }` instead of invoking a stale-content handler.
- `backend/test/api.test.ts` — server-side byte-fidelity contract tests.
- `scripts/qa/save-truthfulness.md` — this document.

---

## Environment

1. Backend: `npm run dev -w @cloud-ide/backend`
2. Frontend: `npm run dev -w @cloud-ide/frontend` → http://localhost:5173
3. Docker Desktop running with `cloudeeeide-runner:latest` built
   (`npm run runner:build`) — needed only for Target 3 (Run).
4. Register two accounts (A and B) in two browser profiles/windows for
   Targets 2 and 4. Share A's project with B as **editor**
   (Share modal → add by username).

DevTools tip: keep the Network tab open filtered to `file`; each save must
produce exactly one `POST /api/projects/<id>/file` whose request payload
matches what is visible in the editor.

---

## Target 1 — Solo Dirty Save

**Verifies:** the core regression. Previously Ctrl+S posted file-open-time
content and the editor visibly reverted.

| Step | Action | Expected |
|---|---|---|
| 1.1 | Log in as A. Open any project, create/open `main.py`, note its content. | File opens normally. |
| 1.2 | Append a distinctive line, e.g. `print("M1 truth 1727")`. Do **not** blur the editor. | Dirty dot appears on tab. |
| 1.3 | Press `Ctrl+S` while focus is inside Monaco. | Toast "Saved main.py". Network shows POST body containing the typed line. |
| 1.4 | Reload the page (F5), reopen `main.py`. | The typed line is present after reload. **No reversion to pre-edit text.** |
| 1.5 | `GET /api/projects/<id>/file?path=main.py` (or check workspace file on disk). | Bytes match the editor exactly. |

Pass criteria: steps 1.3–1.5 all hold. Failure signature of the old bug:
toast says "Saved" but POST payload lacks the new line and the editor reverts
within ~1 render frame.

---

## Target 2 — Defocused Save

**Verifies:** the global shortcut path (window-capture handler) saves the same
truth as the in-editor path, including files whose model still exists but is
not focused, and clean-buffer no-op behavior.

| Step | Action | Expected |
|---|---|---|
| 2.1 | With `notes.md` open and edited (dirty), click the sidebar file tree / bottom panel so Monaco loses focus. | Tab still shows dirty indicator. |
| 2.2 | Press `Ctrl+S`. | Exactly one POST with the edited content; toast shown. |
| 2.3 | Reload and reopen `notes.md`. | Edited content persisted. |
| 2.4 | Press `Ctrl+S` again immediately (buffer now clean). | One idempotent POST with identical bytes; no error, no state corruption. |

Pass criteria: 2.2–2.4 hold; no double-dispatch (only ONE `ide-save` handling
per keypress — verify via Network: one POST per press).

---

## Target 3 — Auto-Save on Run

**Verifies:** the run pipeline executes what the user sees, not stale bytes.

| Step | Action | Expected |
|---|---|---|
| 3.1 | Open `main.py` (Python project). Run once (`Ctrl+Enter`) to establish baseline output. | Output panel shows baseline print(s). |
| 3.2 | Change the printed string to something unmistakable, e.g. `print("RUN-TRUTH-M1")`. Keep focus in the editor. | Tab dirty. |
| 3.3 | Click **Run** in the toolbar without manually saving first. | Auto-save fires (one POST per dirty file), then execution starts. |
| 3.4 | Observe Output panel. | stdout contains `RUN-TRUTH-M1` — i.e. the NEW code ran. |
| 3.5 | After exit, reload the page and reopen `main.py`. | New code persisted; tabs show clean. |

Pass criteria: step 3.4 shows the new output. Old-bug failure signature: run
executes the OLD source while the editor showed the new one.

Edge case (regression guard added in M1): if a dirty-file POST fails (e.g.
stop the backend before Run), that file's dirty flag must REMAIN set — only
successfully saved files are marked clean.

---

## Target 4 — Multiplayer Non-Interference

**Verifies:** a peer's save can never clobber another collaborator's live
edits (the Yjs room clobber half of BUG-1).

| Step | Action | Expected |
|---|---|---|
| 4.1 | A shares project with B (editor role). Both open the same file `collab.py`. Both see identical content. | Avatar stack shows both users; cursors visible. |
| 4.2 | B types continuously (several characters per second, do not stop). | Edits appear in A's editor in real time. |
| 4.3 | While B keeps typing, A presses `Ctrl+S` twice, ~2 s apart. | Two POSTs from A. Neither triggers any visible change/revert in B's or A's editors beyond B's own typing. |
| 4.4 | Both stop. Wait ~3 s (room flush debounce), then reload BOTH clients and reopen the file. | Both clients and disk show the union of edits — identical on both sides and on disk. No reverted/stale region from A's save. |
| 4.5 | Reverse roles: B saves continuously while A types. Repeat 4.3–4.4. | Same non-interference result. |

Pass criteria: no client ever displays content that undoes the other peer's
typing as a result of a SAVE action. (Concurrent conflicting keystrokes merge
per CRDT semantics — that is expected behavior, distinct from a save-induced
reversion.)

Note: A saving while B types may legitimately persist a mid-typing snapshot;
that snapshot must equal what was rendered in SOME client at that instant and
must be superseded by subsequent typing — it must never roll the doc backward.

---

## Target 5 — Format-on-Save

**Verifies:** formatting operates on live content and the formatted result is
what reaches disk AND stays visible in the editor (both solo and collab).

Pre-step: enable Format on Save via status bar toggle (`Format: Off → On`).

| Step | Action | Expected |
|---|---|---|
| 5.1 | Solo mode. In `messy.js` type badly-formatted code, e.g. `const x   =   1;function f( ){return   x}` (no trailing newline). | Dirty tab. |
| 5.2 | `Ctrl+S` inside the editor. | One format POST + one file POST. Persisted bytes are formatted (prettier/normalizer output), not the raw messy buffer. |
| 5.3 | Observe editor after save completes (~1 render cycle). | Editor shows the FORMATTED text (external-sync effect applies it once clean). |
| 5.4 | Reload, reopen `messy.js`. | Formatted content persists; matches step 5.3. |
| 5.5 | Standalone Format Document (`Shift+Alt+F`) on an unformatted buffer WITHOUT saving. | Editor visibly reformats immediately (model-first apply); peers see the reformat in real time when collab-bound. |
| 5.6 | Collab mode: repeat 5.1–5.4 with B observing A's window during 5.2–5.3. | B sees A's buffer converge to the formatted text via Yjs within ~1 s; disk matches both clients. |

Pass criteria: saved bytes == formatted live content == post-reload content ==
editor display in both modes.

Known acceptable nuance: standalone Format Document on a background (non-
rendered) file falls back to state-only update when no live model exists —
identical to pre-M1 behavior; the active-file path always has a model.

---

## Automated coverage added

- `backend/test/api.test.ts` → `describe("save-truthfulness backend contract (M1)")`
  - byte-exact write/read round-trip (unicode, no trailing newline)
  - CRLF preservation (no normalization)
  - idempotent identical overwrite
  - full replacement on second save (no append/merge artifacts)

Run: `npm test -w @cloud-ide/backend`

## Regression guards & notes for reviewers

- cc55a1a's perf property MUST survive: keystrokes still do NOT rebuild
  `openFiles` array contents (dirty-flag only). Verify via React DevTools
  profiler: typing causes Editor-local updates only, no IDE-wide content churn.
- Lazy chunking MUST survive: `IDE.tsx` imports only `import type` from
  `../Editor/Editor`; runtime access flows through `liveApiRef`. Confirm the
  entry bundle does not include monaco-editor (check build stats).
- Known adjacent issue (pre-existing, OUT OF SCOPE here): open tabs are not
  cleared on project switch and paths are project-relative, so switching
  projects can surface a previous project's same-named tab/model. Flagged for
  a follow-up milestone; do not "fix" opportunistically in M1.
- Error UX remains `alert()` per existing style; replacement toasts are
  deferred to the QOL backlog (M19).

## Sign-off checklist

- [ ] T1 Solo Dirty Save
- [ ] T2 Defocused Save
- [ ] T3 Auto-Save on Run (+ failed-save dirty retention)
- [ ] T4 Multiplayer Non-Interference (A→B and B→A)
- [ ] T5 Format-on-Save (solo + collab + standalone format)
- [ ] Backend suite green incl. 4 new contract tests
- [ ] Frontend typecheck + production build green
