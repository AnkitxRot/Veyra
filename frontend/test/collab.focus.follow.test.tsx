import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildFocusContext,
  deriveFocusState,
  latestAttentionFrom,
  FOLLOW_ABSENCE_GRACE_MS,
  FOLLOW_LEFT_NOTICE_MS,
} from "../src/collab/focus";
import {
  anchorFilePresent,
  anchorFileBasename,
  type FollowAnchor,
} from "../src/collab/followAnchor";
import type { CollaboratorPresence } from "../src/collab/presence";
import type { AttentionEvent } from "../src/collab/attention";

/**
 * M59 — Collaborative Focus & Context Handoff.
 *
 * The IDE focus controller (`focusOn`, the anchor, the userId-keyed absence
 * grace) lives deep inside IDE.tsx's effect graph; the repo convention for
 * that surface (see IDE.attention.test.tsx / sessionRestore.test.tsx) is a
 * source-contract guard plus direct behavioural tests of the pure modules it
 * is built on. This file does both — every assertion below fails if the
 * corresponding behaviour is reverted.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ideSrc = readFileSync(
  join(here, "../src/components/IDE/IDE.tsx"),
  "utf-8",
);
const editorSrc = readFileSync(
  join(here, "../src/components/Editor/Editor.tsx"),
  "utf-8",
);
const bannerSrc = readFileSync(
  join(here, "../src/components/Collab/FollowBanner.tsx"),
  "utf-8",
);
const traySrc = readFileSync(
  join(here, "../src/components/Collab/AttentionTray.tsx"),
  "utf-8",
);

function block(src: string, anchor: string, len = 900): string {
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error(`anchor not found: ${anchor}`);
  return src.slice(i, i + len);
}

const user = (o: Partial<CollaboratorPresence> = {}): CollaboratorPresence => ({
  clientId: 1,
  userId: 2,
  name: "Rahul",
  role: "editor",
  color: "#89b4fa",
  status: "online",
  activity: { type: "viewing", timestamp: 0 },
  lastActive: 100,
  ...o,
});
const evt = (o: Partial<AttentionEvent>): AttentionEvent => ({
  id: o.id ?? "a",
  kind: o.kind ?? "callout",
  author: o.author ?? { userId: 2, username: "Rahul", color: "#89b4fa" },
  file: o.file ?? "auth/session.ts",
  range: o.range ?? { startLine: 40, startColumn: 1, endLine: 52, endColumn: 1 },
  message: o.message,
  targetUserId: o.targetUserId,
  createdAt: o.createdAt ?? 200,
  expiresAt: (o.createdAt ?? 200) + 90_000,
});

// ---------------------------------------------------------------------------
// Pure module behaviour (the controller's foundation)
// ---------------------------------------------------------------------------

describe("M59 — FocusContext derivation", () => {
  it("following wins over attention wins over activity", () => {
    expect(deriveFocusState(user(), evt({}), true)).toBe("following");
    expect(deriveFocusState(user(), evt({}), false)).toBe("focused");
    expect(
      deriveFocusState(
        user({ activity: { type: "editing", timestamp: 0 } }),
        null,
        false,
      ),
    ).toBe("viewing");
    expect(deriveFocusState(user({ status: "away" }), null, false)).toBe("idle");
  });

  it("latestAttentionFrom respects author + targeted-or-broadcast filter", () => {
    const list = [
      evt({ id: "old", createdAt: 100 }),
      evt({ id: "new", createdAt: 300, targetUserId: 9 }),
      evt({
        id: "other",
        author: { userId: 5, username: "P", color: "#1" },
        createdAt: 400,
      }),
      evt({ id: "notme", createdAt: 500, targetUserId: 123 }),
    ];
    expect(latestAttentionFrom(list, 2, 9)!.id).toBe("new");
  });

  it("buildFocusContext assembles file/range/state and is followedUserId-keyed", () => {
    const fc = buildFocusContext(
      user({ activeFile: "auth/session.ts" }),
      [evt({ message: "race here", createdAt: 300 })],
      9,
      null,
    );
    expect(fc.file).toBe("auth/session.ts");
    expect(fc.range).toEqual({
      startLine: 40,
      startColumn: 1,
      endLine: 52,
      endColumn: 1,
    });
    expect(fc.state).toBe("focused");
    expect(fc.attention?.message).toBe("race here");
    expect(buildFocusContext(user({ userId: 2 }), [], 9, 2).state).toBe(
      "following",
    );
  });
});

describe("M59 — FollowAnchor helpers", () => {
  const anchor = (p: string): FollowAnchor => ({
    filePath: p,
    viewState: { __vs: true },
    cursor: { line: 5, column: 1 },
    capturedAt: 1,
  });
  it("anchorFilePresent = membership over fileIndex ∪ openFiles", () => {
    expect(anchorFilePresent(anchor("src/a.ts"), ["src/a.ts", "src/b.ts"])).toBe(
      true,
    );
    expect(anchorFilePresent(anchor("src/gone.ts"), ["src/a.ts"])).toBe(false);
  });
  it("anchorFileBasename is the last path segment (missing-file toast text)", () => {
    expect(anchorFileBasename(anchor("src/deep/Editor.tsx"))).toBe("Editor.tsx");
  });
});

describe("M59 — constants pinned", () => {
  it("grace ≈ 6s, left-notice ≈ 8s", () => {
    expect(FOLLOW_ABSENCE_GRACE_MS).toBe(6_000);
    expect(FOLLOW_LEFT_NOTICE_MS).toBe(8_000);
  });
});

// ---------------------------------------------------------------------------
// IDE focus controller — source contract (Decisions 1–14 + adversarial review)
// ---------------------------------------------------------------------------

describe("M59 — one Follow target, one controller (Decisions 1, 2)", () => {
  it("exactly one focusOn helper and a single followedUserId state", () => {
    expect(ideSrc.match(/const focusOn = useCallback/g)?.length).toBe(1);
    expect(ideSrc.match(/setFollowedUserId\(/g)!.length).toBeGreaterThan(0);
    // no second follow array / multi-follow set
    expect(ideSrc).not.toMatch(/followedUserIds|followTargets/);
  });

  it("focusOn ends a DIFFERENT current follow before acting", () => {
    const blk = block(ideSrc, "const focusOn = useCallback");
    expect(blk).toMatch(/cur !== null && cur !== userId/);
    const switchBranch = blk.slice(
      blk.indexOf("cur !== null"),
      blk.indexOf("if (opts.follow)"),
    );
    expect(switchBranch).toContain("setFollowedUserId(null)");
  });
});

describe("M59 — anchor captured once, preserved on switch (Decisions 3, 4, 5)", () => {
  it("captureAnchor is null-guarded", () => {
    expect(block(ideSrc, "const captureAnchor = useCallback", 300)).toMatch(
      /if \(followAnchorRef\.current\)\s*return/,
    );
  });

  it("the focusOn target-switch branch never captures or clears the anchor", () => {
    const blk = block(ideSrc, "const focusOn = useCallback");
    const switchBranch = blk.slice(
      blk.indexOf("cur !== null"),
      blk.indexOf("if (opts.follow)"),
    );
    expect(switchBranch).not.toContain("captureAnchor");
    expect(switchBranch).not.toContain("followAnchorRef.current = null");
  });

  it("only follow:true captures an anchor — one-shot Go there does not", () => {
    const blk = block(ideSrc, "const focusOn = useCallback");
    const followBranch = blk.slice(blk.indexOf("if (opts.follow)"));
    expect(followBranch).toContain("captureAnchor()");
    // Jump / Go there call focusOn with { follow: false }
    expect(ideSrc).toContain("focusOn(c.userId, { follow: false })");
    expect(ideSrc).toContain("focusOn(evt.author.userId, { follow: false })");
  });
});

describe("M59 — Stop vs Return (Decisions 6, 7)", () => {
  it("Stop discards the anchor and clears timers, stays put (no navigation)", () => {
    const blk = block(ideSrc, "const handleStopFollowing = useCallback");
    expect(blk).toContain("clearFollowAbsenceTimer()");
    expect(blk).toContain("followAnchorRef.current = null");
    expect(blk).toContain("setFollowedUserId(null)");
    expect(blk).not.toContain("handleOpenFile");
    expect(blk).not.toContain("ide-restore-view-state");
  });

  it("Return restores the anchor via ide-restore-view-state, then discards it", () => {
    const blk = block(ideSrc, "const handleReturnToMyLocation = useCallback", 1200);
    expect(blk).toContain("setFollowedUserId(null)");
    expect(blk).toContain("followAnchorRef.current = null");
    expect(blk).toContain("anchorFilePresent");
    expect(blk).toContain("await handleOpenFile(anchor.filePath)");
    expect(blk).toContain('"ide-restore-view-state"');
    // missing file → lightweight notice (M64: the shared reconcile slot),
    // no throw, no open
    expect(blk).toContain('dedupeKey: "reconcile"');
    expect(blk).toMatch(/if \(!anchorFilePresent[\s\S]{0,340}return;/);
  });
});

describe("M59 — userId-keyed absence grace (Decisions 8, 9, 10)", () => {
  const graceBlk = block(ideSrc, "if (!followedUser) {", 2400);

  it("absence does NOT clear Follow synchronously — only inside the timeout", () => {
    const beforeTimeout = graceBlk.slice(0, graceBlk.indexOf("setTimeout"));
    expect(beforeTimeout).not.toContain("setFollowedUserId(null)");
    expect(graceBlk).toContain("FOLLOW_ABSENCE_GRACE_MS");
  });

  it("the timer is created once (null-guard) and re-checks by userId", () => {
    expect(graceBlk).toContain("followAbsenceTimerRef.current === null");
    expect(graceBlk).toMatch(/c\.userId === targetId|c\.userId === followedUserIdRef\.current/);
  });

  it("a present followedUser kills any pending absence timer (seamless resume)", () => {
    const resumeBlk = ideSrc.slice(
      ideSrc.indexOf("seamless resume"),
      ideSrc.indexOf("seamless resume") + 200,
    );
    expect(resumeBlk).toContain("clearFollowAbsenceTimer()");
  });

  it("the tracking effect has NO cleanup that clears the absence timer", () => {
    // it must survive `collaborators` churn (effect re-runs on awareness change)
    const effectTail = graceBlk;
    expect(ideSrc).toContain(
      "no cleanup that clears followAbsenceTimerRef",
    );
    expect(effectTail).not.toMatch(/return \(\) => \{[\s\S]*clearFollowAbsenceTimer/);
  });

  it("after the grace the 'left' notice shows and the anchor is PRESERVED", () => {
    // M64: the notice is the editor-surface "follow-left" entry in useNotices.
    expect(graceBlk).toContain('dedupeKey: "follow-left"');
    const notice = graceBlk.slice(graceBlk.indexOf("notify({"));
    expect(notice).toContain('surface: "editor"');
    expect(notice).toContain("ttl: FOLLOW_LEFT_NOTICE_MS");
    // the anchor is discarded ONLY on TTL expiry (the "Stay here" default),
    // via onExpire — never synchronously when the notice is raised
    const beforeNotify = graceBlk.slice(0, graceBlk.indexOf("notify({"));
    expect(beforeNotify).not.toContain("followAnchorRef.current = null");
    const onExpire = notice.slice(
      notice.indexOf("onExpire:"),
      notice.indexOf("actions:"),
    );
    expect(onExpire).toContain("followAnchorRef.current = null");
  });

  it("no auto-refollow: re-adding the user later never calls focusOn from awareness", () => {
    // focusOn is only ever invoked from explicit user gestures / event listeners
    const calls = ideSrc.match(/focusOn\(/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(ideSrc).not.toMatch(/awareness_change[\s\S]{0,400}focusOn\(/);
  });
});

describe("M59 — lifecycle resets (Decision 11)", () => {
  it("collab-effect teardown runs the full follow reset", () => {
    const cancelledAt = ideSrc.indexOf("cancelled = true;");
    const teardown = ideSrc.slice(cancelledAt, cancelledAt + 1600);
    expect(teardown).toContain("resetFollowStateRef.current()");
    expect(teardown).toContain("client?.dispose()");
  });

  it("connection_change 'forbidden' clears Follow", () => {
    expect(ideSrc).toMatch(
      /status === "forbidden"\)\s*resetFollowStateRef\.current\(\)/,
    );
  });

  it("resetFollowState clears target + anchor + absence timer + notice", () => {
    const blk = block(ideSrc, "const resetFollowState = useCallback");
    expect(blk).toContain("clearFollowAbsenceTimer()");
    expect(blk).toContain("followAnchorRef.current = null");
    expect(blk).toContain("setFollowedUserId(null)");
    // M64: explicit dismissal (no onExpire → the anchor null above stands)
    expect(blk).toContain('dismissNoticeKey("follow-left")');
  });
});

describe("M59 — dirty safety & navigation primitive (Decisions 12, 13)", () => {
  it("Return never mutates content — no setValue / applyLiveContent / liveApi", () => {
    const blk = block(ideSrc, "const handleReturnToMyLocation = useCallback", 1200);
    expect(blk).not.toContain("setValue");
    expect(blk).not.toContain("applyLiveContent");
    expect(blk).not.toContain("liveApiRef");
  });

  it("follow tracking pauses on a dirty local file rather than clobbering it", () => {
    const blk = block(ideSrc, "followedUser is present", 900);
    expect(blk).toMatch(/isCurrentFileDirty/);
    expect(blk).toContain("setFollowPaused(true)");
  });

  it("all follow/jump/attention navigation routes through openAndRevealLocation", () => {
    expect(block(ideSrc, "const handleJumpToCollaborator", 900)).toContain(
      "openAndRevealLocation(handleOpenFile",
    );
    expect(block(ideSrc, "const handleAttentionNavigate", 400)).toContain(
      "openAndRevealLocation(handleOpenFile",
    );
  });

  it("attention TTL expiry never touches Follow (Follow tracks presence)", () => {
    // the tracking effect depends on followedUser (presence), not on `attention`
    const deps = ideSrc.slice(
      ideSrc.indexOf("}, [followedUser, activeFile, openFiles, followedUserId"),
      ideSrc.indexOf("}, [followedUser, activeFile, openFiles, followedUserId") +
        160,
    );
    expect(deps).not.toContain("attention,");
  });
});

describe("M59 — attention → focus handoff (Decision: acting ends current follow)", () => {
  it("tray Go there ends a different follow (follow:false) before navigating", () => {
    const blk = block(ideSrc, "const handleAttentionGoThere = useCallback", 400);
    expect(blk).toContain("focusOn(evt.author.userId, { follow: false })");
    expect(blk).toContain("handleAttentionNavigate(evt)");
  });

  it("tray Follow navigates then follows the author iff still connected", () => {
    const blk = block(ideSrc, "const handleAttentionFollow = useCallback", 500);
    expect(blk).toContain("handleAttentionNavigate(evt)");
    expect(blk).toMatch(/collaboratorsRef\.current\.some\([\s\S]{0,80}evt\.author\.userId/);
    expect(blk).toContain("focusOn(evt.author.userId, { follow: true })");
  });

  it("AttentionTray exposes onFollow and IDE dismisses(acted) after following", () => {
    expect(traySrc).toContain("onFollow?");
    expect(traySrc).toContain("attention-tray-follow");
    const render = block(ideSrc, "<AttentionTray", 400);
    expect(render).toContain("onFollow=");
    expect(render).toContain("handleAttentionDismiss(e.id, true)");
    expect(render).toContain("onNavigate={handleAttentionGoThere}");
  });

  it("editor callout/point clicks feed ide-attention-activate / -follow", () => {
    expect(editorSrc).toContain('"ide-attention-activate"');
    expect(editorSrc).toContain('"ide-attention-follow"');
    // bubble body click is suppressed for button targets
    expect(editorSrc).toMatch(/closest\("button"\)\)\s*return/);
    // the Follow + × buttons stop propagation
    const followBtn = block(editorSrc, "follow.onclick", 200);
    expect(followBtn).toContain("stopPropagation");
    const xBtn = block(editorSrc, "x.onclick", 200);
    expect(xBtn).toContain("stopPropagation");
  });

  it("IDE resolves the clicked id against the live attention list", () => {
    const blk = block(ideSrc, 'document.addEventListener("ide-attention-activate"', 60);
    expect(ideSrc).toContain("attentionRef.current.find");
  });
});

// ---------------------------------------------------------------------------
// Editor model-safe restore (Decision: real Monaco view-state primitive)
// ---------------------------------------------------------------------------

describe("M59 — Editor view-state restore is model-safe", () => {
  it("restore() refuses unless the active model's path === filePath", () => {
    const blk = block(editorSrc, "restore: (filePath, viewState) =>", 500);
    expect(blk).toContain("if (active !== filePath) return false");
    expect(blk).toContain("viewState == null");
  });

  it("the ide-restore-view-state handler defers — never restores synchronously", () => {
    const blk = block(editorSrc, "const onRestore = (e: Event)", 500);
    expect(blk).toContain("restorePendingRef.current = {");
    // it calls tryConsumeRestoreRef (guarded) rather than restoreViewState directly
    expect(blk).toContain("tryConsumeRestoreRef.current()");
    expect(blk).not.toContain("restoreViewState");
  });

  it("the consume guard checks active file AND attached model, else cursor fallback", () => {
    const blk = block(editorSrc, "tryConsumeRestoreRef.current = () =>", 900);
    expect(blk).toContain("activeFileRef.current !== pending.filePath");
    expect(blk).toContain("normalizeModelKey(m.uri.path) !== pending.filePath");
    expect(blk).toContain("revealPositionInCenter");
    expect(blk).not.toContain("setValue");
  });
});

// ---------------------------------------------------------------------------
// FollowBanner / notice rendering
// ---------------------------------------------------------------------------

describe("M59 — FollowBanner + 'left' notice", () => {
  it("FollowBanner shows [Return to my location] only with an anchor", () => {
    expect(bannerSrc).toMatch(/hasAnchor && onReturnToLocation &&/);
    expect(bannerSrc).toContain("follow-return-btn");
    expect(bannerSrc).toMatch(/Lines \$\{followedRange\.startLine\}/);
  });

  it("IDE derives hasAnchor (following or just-left) — no ref read in render", () => {
    const render = block(ideSrc, "<FollowBanner", 400);
    expect(render).toContain(
      'hasAnchor={followedUserId != null || hasNotice("follow-left")}',
    );
    expect(render).toContain("onReturnToLocation={handleReturnToMyLocation}");
  });

  it("the 'left' notice is rendered in the editor region with its actions", () => {
    // render site: still the .follow-left-notice element, driven by the
    // editor-surface notice slice
    const render = block(ideSrc, "surface === \"editor\"", 400);
    expect(render).toContain('className="follow-left-notice"');
    expect(render).toContain("n.actions?.map");
  });

  it("the 'left' notice offers Return / Stay here (Stay discards the anchor)", () => {
    // action wiring lives on the notice entry (useNotices), not the render
    const blk = block(ideSrc, 'dedupeKey: "follow-left"', 900);
    expect(blk).toContain("Return to your location");
    expect(blk).toContain("Stay here");
    const stay = blk.slice(blk.indexOf('"Stay here"'));
    expect(stay).toContain('dismissNoticeKey("follow-left")');
    expect(stay).toContain("followAnchorRef.current = null");
  });
});

// ---------------------------------------------------------------------------
// Non-goals / no new machinery (Decision 14 + spec §12)
// ---------------------------------------------------------------------------

describe("M59 — no new transport / store / Yjs / awareness write", () => {
  it("focus.ts is pure — no React, no store, no wire type", () => {
    const focusSrc = readFileSync(
      join(here, "../src/collab/focus.ts"),
      "utf-8",
    );
    expect(focusSrc).not.toMatch(/from "react"/);
    expect(focusSrc).not.toContain("useState");
    expect(focusSrc).not.toContain("setLocalStateField");
  });

  it("no new MESSAGE_CUSTOM type or awareness field added for M59", () => {
    expect(ideSrc).not.toMatch(/setLocalStateField\([^)]*focus/i);
    expect(ideSrc).not.toMatch(/MESSAGE_CUSTOM/);
  });

  it("FocusState is UI-only — not exported from any wire/presence module", () => {
    const presenceSrc = readFileSync(
      join(here, "../src/collab/presence.ts"),
      "utf-8",
    );
    expect(presenceSrc).not.toContain("FocusState");
  });
});
