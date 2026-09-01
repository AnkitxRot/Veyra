import { describe, it, expect, vi, afterEach } from "vitest";
import { openAndRevealLocation } from "../src/utils/revealLocation";

// Regression coverage for the shared "open the file, then reveal" primitive
// used by both the Problems panel (onSelectDiagnostic) and Workspace Search
// (onSelectResult). The Editor's ide-reveal-location handler only switches
// among already-open tabs, so the open must complete first — otherwise a
// click on a result/diagnostic for a closed file is silently dropped.

function captureReveal() {
  const events: any[] = [];
  const handler = (e: Event) => events.push((e as CustomEvent).detail);
  document.addEventListener("ide-reveal-location", handler);
  return {
    events,
    dispose: () => document.removeEventListener("ide-reveal-location", handler),
  };
}

describe("openAndRevealLocation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens the file before dispatching the reveal event", async () => {
    const order: string[] = [];
    const openFile = vi.fn(async (path: string) => {
      order.push(`open:${path}`);
    });
    const cap = captureReveal();
    document.addEventListener("ide-reveal-location", () =>
      order.push("reveal"),
    );

    await openAndRevealLocation(openFile, {
      filePath: "src/deep/closed.py",
      line: 12,
      column: 3,
    });

    expect(openFile).toHaveBeenCalledWith("src/deep/closed.py");
    expect(order).toEqual(["open:src/deep/closed.py", "reveal"]);
    expect(cap.events).toEqual([
      {
        filePath: "src/deep/closed.py",
        line: 12,
        column: 3,
        matchLength: undefined,
      },
    ]);
    cap.dispose();
  });

  it("forwards matchLength when provided (search-hit selection)", async () => {
    const cap = captureReveal();
    await openAndRevealLocation(vi.fn(), {
      filePath: "a.ts",
      line: 5,
      column: 2,
      matchLength: 7,
    });
    expect(cap.events[0]).toMatchObject({ matchLength: 7 });
    cap.dispose();
  });

  it("does not dispatch the reveal if opening the file fails", async () => {
    const cap = captureReveal();
    const openFile = vi.fn(async () => {
      throw new Error("no such file");
    });

    await expect(
      openAndRevealLocation(openFile, { filePath: "gone.py", line: 1 }),
    ).rejects.toThrow("no such file");

    expect(cap.events).toEqual([]);
    cap.dispose();
  });

  it("waits for an async open to resolve before revealing", async () => {
    let resolved = false;
    const openFile = vi.fn(
      () =>
        new Promise<void>((r) =>
          setTimeout(() => {
            resolved = true;
            r();
          }, 10),
        ),
    );
    const cap = captureReveal();
    document.addEventListener("ide-reveal-location", () =>
      expect(resolved).toBe(true),
    );

    await openAndRevealLocation(openFile, { filePath: "slow.py", line: 1 });
    expect(cap.events).toHaveLength(1);
    cap.dispose();
  });
});
