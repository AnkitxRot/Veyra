import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/components/IDE/IDE.tsx"), "utf-8");

/**
 * M64 — IDE.tsx wiring for the unified notice system. Source-string guards:
 * rendering the ~3600-line component in unit tests is not the house style
 * (see IDE.connectionVisibility.test.tsx). Behaviour of the pieces is tested
 * directly — useNotices.test.tsx, NoticeStack.test.tsx, ideSaveConflict
 * .test.tsx, collab.focus.follow.test.tsx.
 */
describe("M64 — IDE.tsx notice wiring", () => {
  it("instantiates the unified notice hook once", () => {
    expect(src).toContain('import { useNotices } from "../../hooks/useNotices"');
    expect(src.match(/useNotices\(\)/g) ?? []).toHaveLength(1);
  });

  it("mounts a single NoticeStack fed the surface:'stack' slice", () => {
    expect(src).toContain('import NoticeStack from "../common/NoticeStack"');
    expect(src.match(/<NoticeStack/g) ?? []).toHaveLength(1);
    const at = src.indexOf("<NoticeStack");
    const jsx = src.slice(at, at + 200);
    expect(jsx).toMatch(/notices=\{activeNotices\.filter\(\(n\) => n\.surface === "stack"\)\}/);
    expect(jsx).toContain("onDismiss={dismissNotice}");
  });

  it("the ide-save listener contains no alert() call", () => {
    const start = src.indexOf('const handleSave = async');
    const end = src.indexOf('document.addEventListener("ide-save"', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).not.toContain("alert(");
  });

  it("a real save failure is a persistent per-path error notice", () => {
    const at = src.indexOf("onFailure: (message) => {");
    const block = src.slice(at, at + 260);
    expect(block).toContain('kind: "error"');
    expect(block).toContain("ttl: null");
    expect(block).toContain("dedupeKey: `save-fail:${path}`");
  });

  it("a successful save clears the standing save-failure notice for that path", () => {
    expect(src).toContain("dismissNoticeKey(`save-fail:${path}`)");
  });

  it("the collab save-conflict uses the shared single 'ext-mutation' slot, 8s ttl", () => {
    const at = src.indexOf("onCollabConflict: (message) => {");
    const block = src.slice(at, at + 240);
    expect(block).toContain('dedupeKey: "ext-mutation"');
    expect(block).toContain("ttl: 8000");
  });

  it("the M56 external_mutation_notice ping shares the same 'ext-mutation' slot", () => {
    const at = src.indexOf('"external_mutation_notice"');
    const block = src.slice(at, at + 1300);
    expect(block).toContain('dedupeKey: "ext-mutation"');
    expect(block).toContain("ttl: 8000");
  });

  it("the save/format status badge reads from the statusbar-surface notice", () => {
    expect(src).toContain(
      'activeNotices.find((n) => n.surface === "statusbar")?.text ?? null',
    );
    expect(src).toContain("{statusbarNotice && (");
    // still rendered inside the status bar footer, not the stack
    const badgeAt = src.indexOf("{statusbarNotice && (");
    const footerAt = src.lastIndexOf('className="ide-statusbar-section"', badgeAt);
    expect(footerAt).toBeGreaterThan(-1);
    expect(footerAt).toBeLessThan(badgeAt);
  });

  it("the invalid-route notice is persistent (ttl:null) and deduped", () => {
    const at = src.indexOf('dedupeKey: "invalid-route"');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at - 320, at + 120);
    expect(block).toContain("ttl: null");
    expect(block).toContain('role: "alert"');
    // cleared explicitly when a project is picked / the route resolves
    expect(src.match(/dismissNoticeKey\("invalid-route"\)/g) ?? []).toHaveLength(2);
  });

  it("the reconcile notice is persistent (ttl:null), deduped, cleared on project switch", () => {
    expect(src.match(/dedupeKey: "reconcile"/g) ?? []).toHaveLength(2);
    const at = src.indexOf('dedupeKey: "reconcile"');
    expect(src.slice(at - 260, at)).toContain("ttl: null");
    expect(src).toContain('dismissNoticeKey("reconcile")');
  });

  it("the follow-left notice is an editor-surface entry with a TTL side effect", () => {
    const at = src.indexOf('dedupeKey: "follow-left"');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at - 200, at + 700);
    expect(block).toContain('surface: "editor"');
    expect(block).toContain("ttl: FOLLOW_LEFT_NOTICE_MS");
    // expiry discards the follow anchor ("Stay here" default)
    const onExpire = block.slice(block.indexOf("onExpire:"), block.indexOf("actions:"));
    expect(onExpire).toContain("followAnchorRef.current = null");
    // Return / Stay actions preserved
    expect(block).toContain("Return to your location");
    expect(block).toContain("Stay here");
  });

  it("follow-left is rendered in the editor region, not the stack", () => {
    const editorArea = src.indexOf('className="ide-editor-area"');
    const editorNotice = src.indexOf('n.surface === "editor"', editorArea);
    const errorBoundary = src.indexOf('<ErrorBoundary label="Editor">', editorArea);
    expect(editorNotice).toBeGreaterThan(editorArea);
    expect(editorNotice).toBeLessThan(errorBoundary);
    // FollowBanner.hasAnchor still reflects a live follow-left notice
    expect(src).toContain(
      'hasAnchor={followedUserId != null || hasNotice("follow-left")}',
    );
  });

  it("drops the removed transient-notice state and timer refs", () => {
    for (const gone of [
      "saveToast",
      "setSaveToast",
      "externalMutationNotice",
      "setExternalMutationNotice",
      "externalMutationTimerRef",
      "replaceReconcileNotice",
      "setReplaceReconcileNotice",
      "invalidRouteNotice",
      "setInvalidRouteNotice",
      "followLeftNotice",
      "setFollowLeftNotice",
      "followLeftTimerRef",
      "clearFollowLeftTimer",
    ]) {
      expect(src).not.toContain(gone);
    }
  });


  it("still contains only out-of-scope alert() calls (open-file + AI), none in save paths", () => {
    const alerts = src.match(/\balert\(/g) ?? [];
    // open-file (1) + AI action/patch (4) = 5; save paths migrated to notices
    expect(alerts).toHaveLength(5);
  });
});
