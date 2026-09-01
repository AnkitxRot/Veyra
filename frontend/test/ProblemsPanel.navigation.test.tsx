import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import * as React from "react";
import ProblemsPanel from "../src/components/Output/ProblemsPanel";
import { openAndRevealLocation } from "../src/utils/revealLocation";
import type { Diagnostic } from "../src/utils/diagnostics";

// Reproduces IDE.tsx's ProblemsPanel wiring: onSelectDiagnostic routes
// through openAndRevealLocation so a diagnostic for a file with no open tab
// opens the tab before the editor reveal is dispatched. Pre-fix the handler
// dispatched ide-reveal-location directly and the click was a silent no-op
// for any closed file.

const diag: Diagnostic = {
  id: "d1",
  severity: "error",
  message: "NameError: name 'x' is not defined",
  filePath: "src/nested/util.py",
  line: 9,
  column: 4,
  source: "python",
};

describe("ProblemsPanel navigation — opens a closed file before reveal", () => {
  afterEach(() => cleanup());

  it("clicking a diagnostic opens its file, then dispatches the reveal", async () => {
    const order: string[] = [];
    const openFile = vi.fn(async (p: string) => {
      order.push(`open:${p}`);
    });
    const onReveal = vi.fn((e: Event) => {
      order.push("reveal");
      return (e as CustomEvent).detail;
    });
    document.addEventListener("ide-reveal-location", onReveal);

    const { getByTitle } = render(
      React.createElement(ProblemsPanel, {
        diagnostics: [diag],
        onSelectDiagnostic: (filePath, line, column) =>
          openAndRevealLocation(openFile, { filePath, line, column }),
        onClearDiagnostics: vi.fn(),
      }),
    );

    fireEvent.click(getByTitle("Click to jump to src/nested/util.py:9:4"));

    await waitFor(() => expect(onReveal).toHaveBeenCalledTimes(1));
    expect(openFile).toHaveBeenCalledWith("src/nested/util.py");
    expect(order).toEqual(["open:src/nested/util.py", "reveal"]);
    expect(onReveal.mock.results[0].value).toMatchObject({
      filePath: "src/nested/util.py",
      line: 9,
      column: 4,
    });

    document.removeEventListener("ide-reveal-location", onReveal);
  });
});
