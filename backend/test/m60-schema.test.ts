import { describe, it, expect } from "vitest";
import { openDb, getSchemaVersion } from "../src/db.js";
import { resolveConfig } from "../src/config.js";

describe("M60 schema + config", () => {
  it("creates collaboration_changes and collab_last_seen at v11", () => {
    const db = openDb(":memory:");
    expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(11);

    const cols = (
      db.prepare("PRAGMA table_info(collaboration_changes)").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "author_user_id",
        "file_path",
        "kind",
        "started_at",
        "ended_at",
        "update_count",
        "lines_added",
        "lines_removed",
        "start_line",
        "end_line",
        "detail",
        "created_at",
      ]),
    );

    const ls = (
      db.prepare("PRAGMA table_info(collab_last_seen)").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(ls).toEqual(
      expect.arrayContaining(["project_id", "user_id", "last_seen_at"]),
    );

    const fks = db
      .prepare("PRAGMA foreign_key_list(collaboration_changes)")
      .all() as { from: string; on_delete: string }[];
    expect(fks.find((f) => f.from === "project_id")?.on_delete).toBe("CASCADE");
    expect(fks.find((f) => f.from === "author_user_id")?.on_delete).toBe(
      "CASCADE",
    );

    const idx = (
      db.prepare("PRAGMA index_list(collaboration_changes)").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(idx).toEqual(
      expect.arrayContaining(["idx_collab_changes_project_ended"]),
    );
  });

  it("exposes M60 config knobs with defaults", () => {
    const cfg = resolveConfig();
    expect(cfg.collabBurstIdleMs).toBe(15000);
    expect(cfg.collabBurstMaxMs).toBe(300000);
    expect(cfg.collabBurstSweepMs).toBe(5000);
    expect(cfg.collabHistoryFlushIntervalMs).toBe(5000);
    expect(cfg.collabHistoryRetentionDays).toBe(14);
    expect(cfg.collabHistoryMaxPerProject).toBe(2000);
    expect(cfg.collabAwayThresholdMs).toBe(180000);
    expect(cfg.collabAwayMaxLookbackMs).toBe(86400000);
    expect(cfg.collabAwayMaxEvents).toBe(50);
    expect(cfg.collabAwayNoticeMs).toBe(20000);
    expect(cfg.collabOpenBurstsMax).toBe(5000);
  });

  it("rejects NaN / infinity / negative env values, falling back to defaults", () => {
    const prev = { ...process.env };
    try {
      process.env.COLLAB_BURST_IDLE_MS = "not-a-number";
      process.env.COLLAB_HISTORY_RETENTION_DAYS = "-3";
      process.env.COLLAB_BURST_MAX_MS = "Infinity";
      process.env.COLLAB_HISTORY_MAX_PER_PROJECT = "0";
      const cfg = resolveConfig();
      expect(cfg.collabBurstIdleMs).toBe(15000);
      expect(cfg.collabHistoryRetentionDays).toBe(14);
      expect(cfg.collabBurstMaxMs).toBe(300000);
      expect(cfg.collabHistoryMaxPerProject).toBe(2000);
    } finally {
      process.env = prev;
    }
  });

  it("honours a valid override", () => {
    expect(resolveConfig({ collabBurstIdleMs: 9000 }).collabBurstIdleMs).toBe(
      9000,
    );
  });
});
