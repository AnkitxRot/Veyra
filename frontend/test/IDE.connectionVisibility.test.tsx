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
 * M63 — IDE wiring for the editor-region connection banner. Source-string
 * guards (rendering the 3600-line component in unit tests is not the house
 * style — see IDE.profileEvent.test.tsx). The banner component itself is
 * behaviour-tested in CollabConnectionBanner.test.tsx; the client state
 * machine in collab.connectionState / collab.reconnect.
 */
describe("M63 — IDE.tsx connection-banner wiring", () => {
  it("mounts CollabConnectionBanner inside the editor region", () => {
    expect(src).toContain(
      'import CollabConnectionBanner from "../Collab/CollabConnectionBanner"',
    );
    const area = src.indexOf('className="ide-editor-area"');
    const followBanner = src.indexOf("<FollowBanner", area);
    const connBanner = src.indexOf("<CollabConnectionBanner", area);
    expect(connBanner).toBeGreaterThan(-1);
    // rendered within the editor area, before the follow banner
    expect(connBanner).toBeLessThan(followBanner);
  });

  it("feeds the banner the live status, pending count, exhausted flag and a retry", () => {
    const at = src.indexOf("<CollabConnectionBanner");
    const jsx = src.slice(at, at + 320);
    expect(jsx).toContain("status={collabStatus}");
    expect(jsx).toContain("pendingLocalUpdates={pendingCollabUpdates}");
    expect(jsx).toContain("reconnectExhausted={collabReconnectExhausted}");
    expect(jsx).toMatch(/onRetry=\{\(\) => collabClientRef\.current\?\.retry\(\)\}/);
  });

  it("subscribes to pending_updates_change and reconnect_exhausted", () => {
    expect(src).toMatch(
      /client\.on\(\s*["']pending_updates_change["'],\s*\(n: number\) => setPendingCollabUpdates\(n\)/,
    );
    expect(src).toMatch(
      /client\.on\(\s*["']reconnect_exhausted["'],\s*\(\) =>\s*setCollabReconnectExhausted\(true\)/,
    );
  });

  it("clears the terminal 'gave up' flag on any forward connection motion", () => {
    const at = src.indexOf('"connection_change"');
    const handler = src.slice(at, at + 900);
    expect(handler).toContain('status !== "disconnected" && status !== "forbidden"');
    expect(handler).toContain("setCollabReconnectExhausted(false)");
  });

  it("tears down both subscriptions and resets the state on project switch", () => {
    const teardown = src.slice(
      src.indexOf("cancelled = true;"),
      src.indexOf("cancelled = true;") + 1200,
    );
    expect(teardown).toContain("unsubPendingUpdates?.();");
    expect(teardown).toContain("unsubReconnectExhausted?.();");
    expect(teardown).toContain("setPendingCollabUpdates(0);");
    expect(teardown).toContain("setCollabReconnectExhausted(false);");
  });
});
