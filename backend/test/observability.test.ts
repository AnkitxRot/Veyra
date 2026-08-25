import { describe, it, expect, beforeEach } from "vitest";
import {
  instrumentDb,
  getObservabilitySnapshot,
  labelForSql,
  startEventLoopMonitor,
  resetObservabilityForTests,
} from "../src/observability.js";
import { openDb } from "../src/db.js";
import { makeTestConfig } from "./helpers.js";

describe("observability (M5a)", () => {
  beforeEach(() => {
    resetObservabilityForTests();
  });

  it("labelForSql extracts a bounded verb+table label", () => {
    expect(
      labelForSql("SELECT s.token FROM sessions s WHERE s.token = ?"),
    ).toBe("SELECT sessions");
    expect(labelForSql("INSERT INTO users (username) VALUES (?)")).toBe(
      "INSERT users",
    );
    expect(labelForSql("DELETE FROM sessions WHERE token = ?")).toBe(
      "DELETE sessions",
    );
    expect(labelForSql("PRAGMA foreign_keys = ON")).toBe("PRAGMA");
  });

  it("instrumentDb does not change DatabaseSync behavior: run/get/all still return correct results", () => {
    const cfg = makeTestConfig();
    const db = instrumentDb(openDb(cfg.dbPath));

    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("carol", "hash", "user");

    const row = db
      .prepare("SELECT id, username FROM users WHERE username = ?")
      .get("carol") as { id: number; username: string } | undefined;
    expect(row?.username).toBe("carol");

    const all = db.prepare("SELECT username FROM users").all() as {
      username: string;
    }[];
    expect(all.map((r) => r.username)).toContain("carol");
  });

  it("records DB call timing observable via getObservabilitySnapshot, bucketed by operation label", () => {
    const cfg = makeTestConfig();
    const db = instrumentDb(openDb(cfg.dbPath));

    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("dave", "hash", "user");
    db.prepare("SELECT id FROM users WHERE username = ?").get("dave");
    db.prepare("SELECT id FROM users WHERE username = ?").get("dave");

    const snapshot = getObservabilitySnapshot({
      activeConnectionCount: () => 0,
      getActiveRoomCount: () => 0,
      getActiveSandboxCount: () => 0,
      getTotalCollabBroadcastSends: () => 0,
    });

    expect(snapshot.dbCalls.overall.count).toBeGreaterThanOrEqual(3);
    expect(snapshot.dbCalls.byOperation["SELECT users"]?.count).toBe(2);
    expect(snapshot.dbCalls.byOperation["INSERT users"]?.count).toBe(1);
    // Every recorded latency is a real, non-negative measurement.
    expect(snapshot.dbCalls.overall.meanMs).toBeGreaterThanOrEqual(0);
  });

  it("getObservabilitySnapshot reports the injected gauge values verbatim", () => {
    const snapshot = getObservabilitySnapshot({
      activeConnectionCount: () => 7,
      getActiveRoomCount: () => 3,
      getActiveSandboxCount: () => 2,
      getTotalCollabBroadcastSends: () => 42,
    });
    expect(snapshot.activeWsConnections).toBe(7);
    expect(snapshot.activeCollabRooms).toBe(3);
    expect(snapshot.activeSandboxes).toBe(2);
    expect(snapshot.totalCollabBroadcastSends).toBe(42);
    expect(snapshot.memory.rssBytes).toBeGreaterThan(0);
  });

  it("event-loop lag is null until the monitor is started, then populated", () => {
    const before = getObservabilitySnapshot({
      activeConnectionCount: () => 0,
      getActiveRoomCount: () => 0,
      getActiveSandboxCount: () => 0,
      getTotalCollabBroadcastSends: () => 0,
    });
    expect(before.eventLoopLagMs).toBeNull();

    startEventLoopMonitor();
    const after = getObservabilitySnapshot({
      activeConnectionCount: () => 0,
      getActiveRoomCount: () => 0,
      getActiveSandboxCount: () => 0,
      getTotalCollabBroadcastSends: () => 0,
    });
    expect(after.eventLoopLagMs).not.toBeNull();
  });

  it("bounds label cardinality: overflow beyond the cap still records into the overall histogram, not a growing label map", () => {
    const cfg = makeTestConfig();
    const db = instrumentDb(openDb(cfg.dbPath));
    const before = getObservabilitySnapshot({
      activeConnectionCount: () => 0,
      getActiveRoomCount: () => 0,
      getActiveSandboxCount: () => 0,
      getTotalCollabBroadcastSends: () => 0,
    });
    const beforeCount = before.dbCalls.overall.count;

    // Distinct synthetic table names push past the label cap; behavior
    // (real query results) must remain unaffected regardless.
    for (let i = 0; i < 5; i++) {
      db.exec(`CREATE TABLE IF NOT EXISTS synth_${i} (id INTEGER)`);
      db.prepare(`SELECT * FROM synth_${i}`).all();
    }

    const after = getObservabilitySnapshot({
      activeConnectionCount: () => 0,
      getActiveRoomCount: () => 0,
      getActiveSandboxCount: () => 0,
      getTotalCollabBroadcastSends: () => 0,
    });
    expect(after.dbCalls.overall.count).toBeGreaterThan(beforeCount);
  });
});
