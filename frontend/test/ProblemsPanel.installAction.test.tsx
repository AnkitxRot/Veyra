import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import * as React from "react";
import ProblemsPanel from "../src/components/Output/ProblemsPanel";
import type { Diagnostic } from "../src/utils/diagnostics";

// M44: Output's console (where the missing-dependency hint was originally
// built) is unmounted the instant a failing run's diagnostics auto-switch
// the bottom panel to Problems — the pane the user actually lands on and
// the only place this action is reliably seen in practice. See STATUS.md
// M44 section for the full discovery.

function makeDiagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    id: "diag-1",
    severity: "error",
    message: "ModuleNotFoundError: No module named 'requests'",
    filePath: "main.py",
    line: 1,
    source: "python",
    ...overrides,
  };
}

function baseProps(
  overrides: Partial<React.ComponentProps<typeof ProblemsPanel>> = {},
) {
  return {
    diagnostics: [makeDiagnostic()],
    onSelectDiagnostic: vi.fn(),
    onClearDiagnostics: vi.fn(),
    ...overrides,
  };
}

describe("ProblemsPanel — Milestone 44 inline Install Dependencies action", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders an Install Dependencies action for a missing-dependency diagnostic", () => {
    const onInstallDependency = vi.fn();
    const { getByText } = render(
      React.createElement(ProblemsPanel, baseProps({ onInstallDependency })),
    );
    expect(getByText("Install Dependencies")).toBeTruthy();
  });

  it("clicking it calls onInstallDependency with the diagnostic", () => {
    const onInstallDependency = vi.fn();
    const diag = makeDiagnostic();
    const { getByText } = render(
      React.createElement(
        ProblemsPanel,
        baseProps({ diagnostics: [diag], onInstallDependency }),
      ),
    );
    fireEvent.click(getByText("Install Dependencies"));
    expect(onInstallDependency).toHaveBeenCalledTimes(1);
    expect(onInstallDependency).toHaveBeenCalledWith(diag);
  });

  it("does not render the action for an unrelated diagnostic", () => {
    const onInstallDependency = vi.fn();
    const diag = makeDiagnostic({
      message: "ZeroDivisionError: division by zero",
    });
    const { queryByText } = render(
      React.createElement(
        ProblemsPanel,
        baseProps({ diagnostics: [diag], onInstallDependency }),
      ),
    );
    expect(queryByText("Install Dependencies")).toBeNull();
  });

  it("does not render the action at all when onInstallDependency is not provided", () => {
    const { queryByText } = render(
      React.createElement(ProblemsPanel, baseProps()),
    );
    expect(queryByText("Install Dependencies")).toBeNull();
  });

  it("still renders Explain/Fix for a missing-dependency diagnostic unchanged", () => {
    const { getByText } = render(
      React.createElement(
        ProblemsPanel,
        baseProps({
          onExplainDiagnostic: vi.fn(),
          onFixDiagnostic: vi.fn(),
          onInstallDependency: vi.fn(),
        }),
      ),
    );
    expect(getByText("Explain")).toBeTruthy();
    expect(getByText("Fix")).toBeTruthy();
    expect(getByText("Install Dependencies")).toBeTruthy();
  });
});
