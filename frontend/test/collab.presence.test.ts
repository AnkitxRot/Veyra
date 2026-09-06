import { describe, it, expect } from "vitest";
import {
  readPresenceState,
  deriveWorkingFolder,
  formatRelativeTime,
  collaboratorsInFile,
  collaboratorsInFolder,
  groupCollaboratorsByFolder,
  getUserColor,
  displayLabel,
  secondaryHandle,
  type CollaboratorPresence,
} from "../src/collab/presence";

describe("M62 — displayLabel / secondaryHandle", () => {
  it("displayLabel: displayName when non-blank, else username", () => {
    expect(displayLabel({ name: "ada99", displayName: "Ada L." })).toBe("Ada L.");
    expect(displayLabel({ name: "ada99", displayName: "  " })).toBe("ada99");
    expect(displayLabel({ name: "ada99", displayName: null })).toBe("ada99");
    expect(displayLabel({ name: "ada99" })).toBe("ada99");
  });
  it("secondaryHandle: @username only when the label differs", () => {
    expect(secondaryHandle({ name: "ada99", displayName: "Ada L." })).toBe("@ada99");
    expect(secondaryHandle({ name: "ada99", displayName: "ada99" })).toBeNull();
    expect(secondaryHandle({ name: "ada99" })).toBeNull();
  });
  it("neither helper mutates identity or colour", () => {
    // pure string in, pure string out — no userId, no colour involvement
    expect(getUserColor(42)).toBe(getUserColor(42));
  });
});

describe("deriveWorkingFolder", () => {
  it("returns the parent dir", () =>
    expect(deriveWorkingFolder("src/auth/service.ts")).toBe("src/auth"));
  it("returns null for a root-level file", () =>
    expect(deriveWorkingFolder("main.py")).toBeNull());
  it("returns null for null / empty", () => {
    expect(deriveWorkingFolder(null)).toBeNull();
    expect(deriveWorkingFolder(undefined)).toBeNull();
    expect(deriveWorkingFolder("")).toBeNull();
  });
  it("normalizes backslashes", () =>
    expect(deriveWorkingFolder("src\\a\\b.ts")).toBe("src/a"));
  it("handles deep nesting", () =>
    expect(deriveWorkingFolder("a/b/c/d/e.ts")).toBe("a/b/c/d"));
});

describe("formatRelativeTime", () => {
  const now = 1_000_000;
  it("'Active now' under 10s", () =>
    expect(formatRelativeTime(now - 4000, now)).toBe("Active now"));
  it("seconds", () =>
    expect(formatRelativeTime(now - 20_000, now)).toBe("20s ago"));
  it("minutes", () =>
    expect(formatRelativeTime(now - 125_000, now)).toBe("2m ago"));
  it("hours", () =>
    expect(formatRelativeTime(now - 7_200_000, now)).toBe("2h ago"));
  it("never negative", () =>
    expect(formatRelativeTime(now + 5000, now)).toBe("Active now"));
});

describe("readPresenceState", () => {
  it("parses a full state including workingFolder + intent", () => {
    const p = readPresenceState(7, {
      user: { id: 3, name: "Rahul", role: "editor", color: "#89b4fa" },
      status: "away",
      activity: { type: "editing", detail: "src/a.ts", timestamp: 5 },
      activeFile: "src/auth/service.ts",
      workingFolder: "src/auth",
      cursor: { line: 42, column: 3 },
      selection: { startLine: 1, startColumn: 1, endLine: 2, endColumn: 2 },
      intent: { text: "JWT refresh", updatedAt: 9 },
      lastActive: 100,
      activeFileDirty: true,
    })!;
    expect(p.userId).toBe(3);
    expect(p.name).toBe("Rahul");
    expect(p.status).toBe("away");
    expect(p.activity.type).toBe("editing");
    expect(p.activeFile).toBe("src/auth/service.ts");
    expect(p.workingFolder).toBe("src/auth");
    expect(p.cursor).toEqual({ line: 42, column: 3 });
    expect(p.selection).toEqual({
      startLine: 1,
      startColumn: 1,
      endLine: 2,
      endColumn: 2,
    });
    expect(p.intent).toEqual({ text: "JWT refresh", updatedAt: 9 });
    expect(p.activeFileDirty).toBe(true);
  });

  it("parses a positive integer avatarVersion, floors anything else to 0", () => {
    expect(
      readPresenceState(1, {
        user: { id: 1, name: "x", avatarVersion: 5 },
      })!.avatarVersion,
    ).toBe(5);
    expect(
      readPresenceState(1, {
        user: { id: 1, name: "x", avatarVersion: 3.9 },
      })!.avatarVersion,
    ).toBe(3);
    for (const bad of [0, -2, NaN, "7", null, undefined]) {
      expect(
        readPresenceState(1, {
          user: { id: 1, name: "x", avatarVersion: bad },
        })!.avatarVersion,
      ).toBe(0);
    }
  });

  it("returns null without a user", () =>
    expect(readPresenceState(1, { status: "online" })).toBeNull());

  it("returns null for a non-object", () =>
    expect(readPresenceState(1, null)).toBeNull());

  it("coerces an unknown availability to 'online'", () => {
    const p = readPresenceState(1, { user: { id: 1, name: "x" }, status: "wat" })!;
    expect(p.status).toBe("online");
  });

  it("accepts 'away'", () => {
    const p = readPresenceState(1, { user: { id: 1, name: "x" }, status: "away" })!;
    expect(p.status).toBe("away");
  });

  it("drops a malformed intent (missing updatedAt)", () => {
    const p = readPresenceState(1, {
      user: { id: 1, name: "x" },
      intent: { text: "hi" },
    })!;
    expect(p.intent).toBeUndefined();
  });

  it("falls back to a getUserColor when no color is present", () => {
    const p = readPresenceState(1, { user: { id: 5, name: "x" } })!;
    expect(p.color).toBe(getUserColor(5));
  });

  // --- M62: effective display name ---------------------------------------
  it("parses user.displayName when present, keeping name = username", () => {
    const p = readPresenceState(7, {
      user: { id: 3, name: "ada99", displayName: "Ada L.", role: "editor" },
      status: "online",
    })!;
    expect(p.name).toBe("ada99");
    expect(p.displayName).toBe("Ada L.");
  });

  it("stays compatible with an older peer that sends no displayName", () => {
    const p = readPresenceState(7, {
      user: { id: 3, name: "ada99" },
      status: "online",
    })!;
    expect(p.name).toBe("ada99");
    expect(p.displayName).toBeUndefined();
  });

  it("ignores a non-string displayName", () => {
    const p = readPresenceState(7, {
      user: { id: 3, name: "ada99", displayName: 42 },
    })!;
    expect(p.displayName).toBeUndefined();
  });

  it("defaults activity to 'viewing' when absent", () => {
    const p = readPresenceState(1, {
      user: { id: 1, name: "x" },
      activeFile: "a.ts",
    })!;
    expect(p.activity.type).toBe("viewing");
    expect(p.activity.detail).toBe("a.ts");
  });
});

describe("who's-working-here selectors", () => {
  const mk = (o: Partial<CollaboratorPresence>): CollaboratorPresence => ({
    clientId: o.clientId ?? Math.random(),
    userId: o.userId ?? 1,
    name: o.name ?? "X",
    role: "editor",
    color: "#1",
    status: "online",
    activity: { type: "editing", timestamp: 0 },
    lastActive: 0,
    ...o,
  });
  const list = [
    mk({ clientId: 1, userId: 10, name: "Rahul", activeFile: "src/auth/service.ts", workingFolder: "src/auth" }),
    mk({ clientId: 2, userId: 11, name: "Priya", activeFile: "src/components/Login.tsx", workingFolder: "src/components" }),
    mk({ clientId: 3, userId: 10, name: "Rahul", activeFile: "src/auth/session.ts", workingFolder: "src/auth" }),
  ];

  it("collaboratorsInFile matches the exact path", () => {
    expect(collaboratorsInFile(list, "src/auth/service.ts").map((c) => c.userId)).toEqual([10]);
  });
  it("collaboratorsInFile can exclude a user", () => {
    expect(collaboratorsInFile(list, "src/auth/service.ts", 10)).toEqual([]);
  });
  it("collaboratorsInFolder matches by prefix", () => {
    expect(collaboratorsInFolder(list, "src/auth").map((c) => c.clientId).sort()).toEqual([1, 3]);
  });
  it("collaboratorsInFolder matches a bare workingFolder with no activeFile", () => {
    const l2 = [mk({ clientId: 9, userId: 20, workingFolder: "src/auth", activeFile: null })];
    expect(collaboratorsInFolder(l2, "src/auth").map((c) => c.clientId)).toEqual([9]);
  });
  it("groupCollaboratorsByFolder groups and de-dupes by userId", () => {
    const g = groupCollaboratorsByFolder(list);
    expect([...g.keys()].sort()).toEqual(["src/auth", "src/components"]);
    expect(g.get("src/auth")!.length).toBe(1); // Rahul once, not twice
  });
  it("groupCollaboratorsByFolder can exclude the current user", () => {
    const g = groupCollaboratorsByFolder(list, 10);
    expect([...g.keys()]).toEqual(["src/components"]);
  });
});

describe("getUserColor", () => {
  it("is deterministic per userId", () => {
    expect(getUserColor(5)).toBe(getUserColor(5));
    expect(getUserColor(-5)).toBe(getUserColor(5));
  });
});
