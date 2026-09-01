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
 * M60 — IDE wiring. The strongest low-cost guards for a 2500-line component:
 * the live event is merged (not replaced), the initial page is fetched exactly
 * once on first TeamPanel open, the while-away flow acks, and every timeline
 * navigation routes through the canonical open-then-reveal primitive.
 */
describe("M60 — IDE.tsx timeline wiring", () => {
  it("subscribes to collab_change and merges it into a bounded timeline", () => {
    expect(src).toMatch(/client\.on\(\s*["']collab_change["']/);
    expect(src).toContain("mergeTimeline(prev, [wireToTimelineEvent(w)], 200)");
  });

  it("subscribes to reconnected_after_gap and gates on COLLAB_AWAY_THRESHOLD_MS", () => {
    expect(src).toMatch(/client\.on\(\s*["']reconnected_after_gap["']/);
    expect(src).toContain("info.offlineMs < COLLAB_AWAY_THRESHOLD_MS");
    expect(src).toContain("fetchWhileAway(project.id)");
  });

  it("fetches the initial timeline page once, on first TeamPanel open", () => {
    const block = src.slice(
      src.indexOf("fetch the initial timeline page"),
      src.indexOf("fetch the initial timeline page") + 500,
    );
    expect(block).toContain("!teamPanelOpen || timelineLoaded");
    expect(block).toContain("setTimelineLoaded(true)");
    expect(block).toContain("fetchCollabTimeline(pid, { limit: 40 })");
  });

  it("timeline navigation routes through openAndRevealLocation (open before reveal), file-only without a range", () => {
    const nav = src.slice(
      src.indexOf("const handleTimelineNavigate"),
      src.indexOf("const handleTimelineNavigate") + 360,
    );
    expect(nav).toContain("if (!ev.navigable || !ev.filePath) return;");
    expect(nav).toContain("openAndRevealLocation(handleOpenFile");
    expect(nav).toContain("ev.lineRange?.startLine ?? 1");
  });

  it("dismissing While-You-Were-Away acks with the newest shown event's timestamp", () => {
    const d = src.slice(
      src.indexOf("const handleWhileAwayDismiss"),
      src.indexOf("const handleWhileAwayDismiss") + 500,
    );
    expect(d).toContain("ackWhileAway(pid, newest.at)");
    expect(d).toContain("setWhileAwayGroups(null)");
  });

  it("passes the timeline + handlers into TeamPanel and renders WhileYouWereAway", () => {
    expect(src).toContain("timeline={timeline}");
    expect(src).toContain("onTimelineNavigate={handleTimelineNavigate}");
    expect(src).toContain("<WhileYouWereAway");
  });

  it("collab_change / reconnected_after_gap are unsubscribed on teardown", () => {
    expect(src).toContain("unsubCollabChange?.();");
    expect(src).toContain("unsubReconnGap?.();");
    expect(src).toContain("setTimeline([]);");
  });
});
