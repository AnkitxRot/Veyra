import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../src/db.js";
import {
  touchLastSeen,
  getLastSeen,
  insertLastSeenIfAbsent,
} from "../src/collab/lastSeen.js";

function seed(db: Db) {
  db.prepare(
    "INSERT INTO users (id, username, password_hash) VALUES (1,'u','h')",
  ).run();
  db.prepare(
    "INSERT INTO projects (id, owner_id, name) VALUES ('p',1,'P')",
  ).run();
}

describe("collab_last_seen helpers", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
    seed(db);
  });

  it("getLastSeen is null before any write", () => {
    expect(getLastSeen(db, "p", 1)).toBeNull();
  });

  it("insertLastSeenIfAbsent inserts once, then is a no-op", () => {
    insertLastSeenIfAbsent(db, "p", 1);
    const first = getLastSeen(db, "p", 1);
    expect(first).not.toBeNull();
    insertLastSeenIfAbsent(db, "p", 1);
    expect(getLastSeen(db, "p", 1)).toBe(first);
  });

  it("touchLastSeen never moves the timestamp backwards", () => {
    touchLastSeen(db, "p", 1, "2026-08-31T12:00:00.000Z");
    touchLastSeen(db, "p", 1, "2026-08-31T11:00:00.000Z");
    expect(getLastSeen(db, "p", 1)).toBe("2026-08-31T12:00:00.000Z");
    touchLastSeen(db, "p", 1, "2026-08-31T13:00:00.000Z");
    expect(getLastSeen(db, "p", 1)).toBe("2026-08-31T13:00:00.000Z");
  });

  it("touchLastSeen upserts a fresh row when absent", () => {
    touchLastSeen(db, "p", 1, "2026-08-31T09:00:00.000Z");
    expect(getLastSeen(db, "p", 1)).toBe("2026-08-31T09:00:00.000Z");
  });
});
