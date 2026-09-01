import { describe, it, expect } from "vitest";
import {
  deriveFocusState,
  latestAttentionFrom,
  buildFocusContext,
  FOLLOW_ABSENCE_GRACE_MS,
  FOLLOW_LEFT_NOTICE_MS,
} from "../src/collab/focus";
import type { CollaboratorPresence } from "../src/collab/presence";
import type { AttentionEvent } from "../src/collab/attention";
import {
  anchorFilePresent,
  anchorFileBasename,
  type FollowAnchor,
} from "../src/collab/followAnchor";

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

describe("M59 — constants", () => {
  it("pins the grace + notice windows", () => {
    expect(FOLLOW_ABSENCE_GRACE_MS).toBe(6_000);
    expect(FOLLOW_LEFT_NOTICE_MS).toBe(8_000);
  });
});

describe("M59 — deriveFocusState", () => {
  it("following wins over everything", () => {
    expect(deriveFocusState(user({ status: "away" }), evt({}), true)).toBe(
      "following",
    );
  });
  it("focused when there is a live attention event", () => {
    expect(deriveFocusState(user(), evt({}), false)).toBe("focused");
  });
  it("viewing when online + active and no attention", () => {
    expect(
      deriveFocusState(
        user({ activity: { type: "editing", timestamp: 0 } }),
        null,
        false,
      ),
    ).toBe("viewing");
  });
  it("idle when away/idle or no signal", () => {
    expect(deriveFocusState(user({ status: "idle" }), null, false)).toBe("idle");
    expect(deriveFocusState(user({ status: "away" }), null, false)).toBe("idle");
  });
});

describe("M59 — latestAttentionFrom", () => {
  it("picks the newest event from that author targeted at me or broadcast", () => {
    const list = [
      evt({ id: "old", createdAt: 100 }),
      evt({ id: "new", createdAt: 300, targetUserId: 9 }),
      evt({ id: "mine", createdAt: 200, targetUserId: 9 }),
    ];
    expect(latestAttentionFrom(list, 2, 9)!.id).toBe("new");
  });
  it("ignores events authored by someone else or targeted at another user", () => {
    const list = [
      evt({
        id: "other-author",
        author: { userId: 5, username: "P", color: "#1" },
        createdAt: 400,
      }),
      evt({ id: "other-target", createdAt: 500, targetUserId: 999 }),
    ];
    expect(latestAttentionFrom(list, 2, 9)).toBeNull();
  });
});

describe("M59 — buildFocusContext", () => {
  it("assembles file/range/state from presence + attention", () => {
    const fc = buildFocusContext(
      user({
        activeFile: "auth/session.ts",
        activity: { type: "editing", timestamp: 0 },
      }),
      [evt({ message: "race is here", createdAt: 300 })],
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
    expect(fc.attention?.message).toBe("race is here");
    expect(fc.isFollowing).toBe(false);
    expect(fc.timestamp).toBe(300);
  });
  it("falls back to presence.activeFile and null range when no attention", () => {
    const fc = buildFocusContext(user({ activeFile: "a.ts" }), [], 9, null);
    expect(fc.file).toBe("a.ts");
    expect(fc.range).toBeNull();
    expect(fc.attention).toBeNull();
  });
  it("state is following when followedUserId matches", () => {
    expect(buildFocusContext(user({ userId: 2 }), [], 9, 2).state).toBe(
      "following",
    );
    expect(buildFocusContext(user({ userId: 2 }), [], 9, 2).isFollowing).toBe(
      true,
    );
  });
});

const anchor = (p: string): FollowAnchor => ({
  filePath: p,
  viewState: { __vs: true },
  cursor: { line: 5, column: 1 },
  capturedAt: 1,
});

describe("M59 — followAnchor", () => {
  it("anchorFilePresent checks membership", () => {
    expect(anchorFilePresent(anchor("src/a.ts"), ["src/a.ts", "src/b.ts"])).toBe(
      true,
    );
    expect(anchorFilePresent(anchor("src/gone.ts"), ["src/a.ts"])).toBe(false);
  });
  it("anchorFileBasename returns the last path segment", () => {
    expect(anchorFileBasename(anchor("src/deep/Editor.tsx"))).toBe("Editor.tsx");
    expect(anchorFileBasename(anchor("main.py"))).toBe("main.py");
  });
});
