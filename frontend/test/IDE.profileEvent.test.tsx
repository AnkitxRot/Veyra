import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  join(here, "../src/components/IDE/IDE.tsx"),
  "utf-8",
);

/**
 * M62-5 — IDE wiring for `profile_event`. Source-string guards (rendering the
 * 2600-line component in unit tests is not the house style). The behaviour
 * under test: a `profile_event` ping invalidates the comment roster and
 * triggers ONE coalesced REST refetch — never a per-render fetch, never a
 * poll, never a fetch of a name from the packet itself.
 */
describe("M62-5 — IDE.tsx profile_event wiring", () => {
  it("subscribes to profile_event on the collaboration client", () => {
    expect(src).toMatch(/client\.on\(\s*["']profile_event["']/);
  });

  it("coalesces a burst of events into one refetch via a single pending timer", () => {
    const at = src.indexOf('"profile_event",');
    const sub = src.slice(at, at + 600);
    expect(sub).toContain("if (profileEventTimerRef.current != null) return;");
    expect(sub).toContain("profileEventTimerRef.current = window.setTimeout(");
    expect(sub).toContain("loadCommentRoster();");
  });

  it("M73: a self profile_event also re-syncs this client's own awareness identity", () => {
    const at = src.indexOf('"profile_event",');
    const sub = src.slice(at, at + 600);
    expect(sub).toContain("ev.userId === user.id");
    expect(sub).toContain("syncSelfIdentity()");
    // syncSelfIdentity fetches the self profile and folds it into awareness —
    // no reconnect, no new socket
    const sync = src.slice(
      src.indexOf("const syncSelfIdentity = () => {"),
      src.indexOf("const syncSelfIdentity = () => {") + 600,
    );
    expect(sync).toContain("getProfile()");
    expect(sync).toContain("updateLocalIdentity({");
    expect(sync).not.toContain("new CollaborationClient");
    expect(sync).not.toContain(".connect(");
  });

  it("does the initial roster load and fetches /collaborators", () => {
    expect(src).toContain("const loadCommentRoster = () => {");
    expect(src).toContain(
      "`/api/projects/${project.id}/collaborators`",
    );
    // called once outside the event handler for the initial populate
    const loadDef = src.indexOf("const loadCommentRoster = () => {");
    // window widened in M68: the fn body gained a notifying `.catch`
    const afterDef = src.slice(loadDef, loadDef + 1500);
    expect(afterDef).toContain("loadCommentRoster();");
  });

  it("treats the event as invalidation-only — the handler ignores the payload", () => {
    expect(src).toMatch(
      /"profile_event",\s*\r?\n\s*\(ev: ProfileEventWire\) =>/,
    );
    // the handler may key off ev.userId (self-detection, M73) but never reads
    // a name / displayName / pronouns / profile bundle off the wire event
    const at = src.indexOf('"profile_event",');
    const sub = src.slice(at, at + 600);
    expect(sub).not.toMatch(/ev\.(displayName|name|username|pronouns|profile)/);
  });

  it("tears down the subscription and cancels the pending refetch", () => {
    const teardown = src.slice(
      src.indexOf("cancelled = true;"),
      src.indexOf("cancelled = true;") + 2200,
    );
    expect(teardown).toContain("unsubProfileEvent?.();");
    expect(teardown).toContain(
      "window.clearTimeout(profileEventTimerRef.current)",
    );
    expect(teardown).toContain("setCommentRoster(new Map())");
  });

  it("commentMembers merges the REST roster with live presence, keyed by userId", () => {
    const block = src.slice(
      src.indexOf("const commentMembers = useMemo(() => {"),
      src.indexOf("const commentMembers = useMemo(() => {") + 2400,
    );
    expect(block).toContain("for (const [uid, info] of commentRoster)");
    expect(block).toContain("username: info.username");
    expect(block).toContain("displayName: info.displayName");
    // M72: the roster's avatarVersion is threaded through too
    expect(block).toContain("avatarVersion: info.avatarVersion");
    // still includes the local user
    expect(block).toContain("if (user) {");
  });

  it("does not poll — the only timer is the single coalesce setTimeout", () => {
    // no setInterval tied to the roster/profile path
    const region = src.slice(
      src.indexOf("const loadCommentRoster"),
      src.indexOf("const loadCommentRoster") + 900,
    );
    expect(region).not.toContain("setInterval");
  });
});
