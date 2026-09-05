import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { getProfile, updateProfile, getDisplayName } from "../src/profile/store.js";

function seed(): Db {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO users (id,username,password_hash) VALUES (1,'alice','h'),(2,'bob','h')",
  ).run();
  return db;
}

function rawRow(db: Db, userId: number): any {
  return db
    .prepare("SELECT * FROM user_profiles WHERE user_id = ?")
    .get(userId);
}

describe("M62-2 profile store", () => {
  let db: Db;
  beforeEach(() => {
    db = seed();
  });

  it("1. missing row -> all-null defaults", () => {
    expect(getProfile(db, 1)).toEqual({
      displayName: null,
      pronouns: null,
      bio: null,
      updatedAt: null,
    });
    // and no row was created by a read
    expect(rawRow(db, 1)).toBeUndefined();
  });

  it("2. initial UPSERT creates the row at version 1", () => {
    const { profile, changedFields } = updateProfile(db, 1, {
      displayName: "Alice",
    });
    expect(profile.displayName).toBe("Alice");
    expect(changedFields).toEqual(["displayName"]);
    const row = rawRow(db, 1);
    expect(row.version).toBe(1);
    expect(row.display_name).toBe("Alice");
    expect(typeof row.updated_at).toBe("string");
  });

  it("3. successful round-trip through getProfile", () => {
    updateProfile(db, 1, {
      displayName: "Alice A.",
      pronouns: "she/her",
      bio: "Line one\n\nLine two",
    });
    const p = getProfile(db, 1);
    expect(p.displayName).toBe("Alice A.");
    expect(p.pronouns).toBe("she/her");
    expect(p.bio).toBe("Line one\n\nLine two");
    expect(p.updatedAt).toBeTypeOf("string");
  });

  it("4. version increments on each PUT (== number of writes)", () => {
    updateProfile(db, 1, { displayName: "A" });
    expect(rawRow(db, 1).version).toBe(1);
    updateProfile(db, 1, { pronouns: "they/them" });
    expect(rawRow(db, 1).version).toBe(2);
    updateProfile(db, 1, { bio: "hi" });
    expect(rawRow(db, 1).version).toBe(3);
  });

  it("5. partial patch preserves unspecified fields", () => {
    updateProfile(db, 1, {
      displayName: "Alice",
      pronouns: "she/her",
      bio: "original bio",
    });
    updateProfile(db, 1, { displayName: "Alice Renamed" });
    const p = getProfile(db, 1);
    expect(p.displayName).toBe("Alice Renamed");
    expect(p.pronouns).toBe("she/her"); // untouched
    expect(p.bio).toBe("original bio"); // untouched
  });

  it("6. null clears displayName without disturbing other fields", () => {
    updateProfile(db, 1, { displayName: "Alice", bio: "keep me" });
    updateProfile(db, 1, { displayName: null });
    const p = getProfile(db, 1);
    expect(p.displayName).toBeNull();
    expect(p.bio).toBe("keep me");
  });

  it("7. updated_at is (re)written on every PUT and moves forward", async () => {
    updateProfile(db, 1, { displayName: "A" });
    const first = getProfile(db, 1).updatedAt;
    // ISO-ms timestamp; a >5ms gap guarantees a strictly greater value
    await new Promise((r) => setTimeout(r, 8));
    updateProfile(db, 1, { displayName: "B" });
    const second = getProfile(db, 1).updatedAt;
    expect(first).toBeTypeOf("string");
    expect(second).toBeTypeOf("string");
    expect(second! > first!).toBe(true);
  });

  it("isolates profiles per user_id", () => {
    updateProfile(db, 1, { displayName: "Alice" });
    expect(getProfile(db, 2)).toEqual({
      displayName: null,
      pronouns: null,
      bio: null,
      updatedAt: null,
    });
  });

  it("getDisplayName returns the raw column (null when no row / cleared)", () => {
    expect(getDisplayName(db, 1)).toBeNull(); // no row
    updateProfile(db, 1, { pronouns: "she/her" });
    expect(getDisplayName(db, 1)).toBeNull(); // row, no display name
    updateProfile(db, 1, { displayName: "Alice" });
    expect(getDisplayName(db, 1)).toBe("Alice");
    updateProfile(db, 1, { displayName: null });
    expect(getDisplayName(db, 1)).toBeNull(); // cleared
  });

  it("never selects or exposes dormant profile columns", () => {
    updateProfile(db, 1, { displayName: "Alice" });
    // dormant columns keep their schema defaults, and getProfile's shape is
    // exactly the four identity fields.
    expect(Object.keys(getProfile(db, 1)).sort()).toEqual(
      ["bio", "displayName", "pronouns", "updatedAt"].sort(),
    );
    const row = rawRow(db, 1);
    expect(row.avatar_media_id).toBeNull();
    expect(row.profile_visibility).toBe("collaborators");
    expect(row.banner_kind).toBe("none");
  });
});
