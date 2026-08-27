import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import * as React from "react";
import type { Project } from "../src/types";

import Toolbar from "../src/components/Toolbar/Toolbar";

function baseProps(
  overrides: Partial<React.ComponentProps<typeof Toolbar>> = {},
) {
  const project: Project = { id: "proj-1", name: "My Project" };
  return {
    project,
    activeFile: "main.py",
    capabilities: {
      docker: true,
      runnerImage: true,
      languages: {
        python: true,
        node: true,
        typescript: true,
        c: true,
        cpp: true,
        java: true,
      },
    },
    ...overrides,
  };
}

describe("Toolbar — Milestone 43 Install action", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders an Install button", () => {
    const { getByText } = render(
      React.createElement(Toolbar, baseProps() as any),
    );
    expect(getByText("Install")).toBeTruthy();
  });

  it("clicking Install dispatches an ide-install event", () => {
    const listener = vi.fn();
    document.addEventListener("ide-install", listener);

    const { getByText } = render(
      React.createElement(Toolbar, baseProps() as any),
    );
    fireEvent.click(getByText("Install"));

    expect(listener).toHaveBeenCalledTimes(1);
    document.removeEventListener("ide-install", listener);
  });

  it("7. Run is disabled while an install is in progress", () => {
    const { getByText } = render(
      React.createElement(Toolbar, baseProps() as any),
    );

    fireEvent(document, new Event("install-started"));

    const runButton = getByText("Run Python").closest(
      "button",
    ) as HTMLButtonElement;
    expect(runButton.disabled).toBe(true);
  });

  it("7b. Ctrl+Enter does not start a run while an install is in progress", () => {
    const listener = vi.fn();
    document.addEventListener("ide-run", listener);

    render(React.createElement(Toolbar, baseProps() as any));
    fireEvent(document, new Event("install-started"));

    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });

    expect(listener).not.toHaveBeenCalled();
    document.removeEventListener("ide-run", listener);
  });

  it("8. Install is disabled while a run is in progress", () => {
    const { getByText } = render(
      React.createElement(Toolbar, baseProps() as any),
    );

    fireEvent(document, new Event("run-started"));

    const installButton = getByText("Install").closest(
      "button",
    ) as HTMLButtonElement;
    expect(installButton.disabled).toBe(true);
  });

  it("8b. clicking Install while a run is in progress does not dispatch ide-install", () => {
    const listener = vi.fn();
    document.addEventListener("ide-install", listener);

    const { getByText } = render(
      React.createElement(Toolbar, baseProps() as any),
    );
    fireEvent(document, new Event("run-started"));
    fireEvent.click(getByText("Install"));

    expect(listener).not.toHaveBeenCalled();
    document.removeEventListener("ide-install", listener);
  });

  it("9. two rapid Install clicks dispatch only one ide-install event", () => {
    const listener = vi.fn();
    document.addEventListener("ide-install", listener);

    const { getByText } = render(
      React.createElement(Toolbar, baseProps() as any),
    );
    const installButton = getByText("Install");
    // Fired before React has a chance to re-render with isInstalling=true —
    // the synchronous installInFlightRef guard in handleInstall must still
    // catch this, not just the (delayed) disabled-attribute re-render.
    fireEvent.click(installButton);
    fireEvent.click(installButton);

    expect(listener).toHaveBeenCalledTimes(1);
    document.removeEventListener("ide-install", listener);
  });

  it("install-stopped clears the busy state and re-enables both actions", () => {
    const { getByText } = render(
      React.createElement(Toolbar, baseProps() as any),
    );

    fireEvent(document, new Event("install-started"));
    fireEvent(document, new Event("install-stopped"));

    const runButton = getByText("Run Python").closest(
      "button",
    ) as HTMLButtonElement;
    const installButton = getByText("Install").closest(
      "button",
    ) as HTMLButtonElement;
    expect(runButton.disabled).toBe(false);
    expect(installButton.disabled).toBe(false);
  });

  it("10. existing Run behavior is unchanged: clicking Run dispatches ide-run with language details", () => {
    const listener = vi.fn();
    document.addEventListener("ide-run", listener);

    const { getByText } = render(
      React.createElement(Toolbar, baseProps() as any),
    );
    fireEvent.click(getByText("Run Python"));

    expect(listener).toHaveBeenCalledTimes(1);
    const detail = listener.mock.calls[0][0].detail;
    expect(detail.activeFile).toBe("main.py");
    document.removeEventListener("ide-run", listener);
  });

  it("10b. existing Stop behavior is unchanged: Stop renders and dispatches ide-stop while running", () => {
    const listener = vi.fn();
    document.addEventListener("ide-stop", listener);

    const { getByText } = render(
      React.createElement(Toolbar, baseProps() as any),
    );
    fireEvent(document, new Event("run-started"));
    fireEvent.click(getByText("Stop"));

    expect(listener).toHaveBeenCalledTimes(1);
    document.removeEventListener("ide-stop", listener);
  });
});
