import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import * as React from "react";
import type { Project } from "../src/types";
import Toolbar from "../src/components/Toolbar/Toolbar";

function caps(overrides: Record<string, unknown> = {}) {
  return {
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
    debugger: { python: true, node: true },
    ...overrides,
  };
}

function baseProps(
  overrides: Partial<React.ComponentProps<typeof Toolbar>> = {},
) {
  const project: Project = { id: "proj-1", name: "My Project" };
  return {
    project,
    activeFile: "main.py",
    capabilities: caps(),
    ...overrides,
  };
}

describe("Toolbar — Debug action", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("dispatches ide-debug for a Python file", () => {
    const listener = vi.fn();
    document.addEventListener("ide-debug", listener);
    const { getByTestId } = render(
      React.createElement(Toolbar, baseProps() as any),
    );
    fireEvent.click(getByTestId("debug-start"));
    expect(listener).toHaveBeenCalledTimes(1);
    document.removeEventListener("ide-debug", listener);
  });

  it("disables Debug when Docker is unavailable", () => {
    const { getByTestId } = render(
      React.createElement(
        Toolbar,
        baseProps({ capabilities: caps({ docker: false }) }) as any,
      ),
    );
    expect((getByTestId("debug-start") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("disables Debug for C files (not in M83)", () => {
    const { getByTestId } = render(
      React.createElement(Toolbar, baseProps({ activeFile: "main.c" }) as any),
    );
    expect((getByTestId("debug-start") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("disables Debug and Run while a debug session is live", () => {
    const { getByTestId, getByText } = render(
      React.createElement(Toolbar, baseProps() as any),
    );
    fireEvent(document, new Event("debug-started"));
    expect((getByTestId("debug-start") as HTMLButtonElement).disabled).toBe(
      true,
    );
    const runButton = getByText("Run Python").closest(
      "button",
    ) as HTMLButtonElement;
    expect(runButton.disabled).toBe(true);
  });

  it("does not dispatch ide-debug while a run is in progress", () => {
    const listener = vi.fn();
    document.addEventListener("ide-debug", listener);
    const { getByTestId } = render(
      React.createElement(Toolbar, baseProps() as any),
    );
    fireEvent(document, new Event("run-started"));
    fireEvent.click(getByTestId("debug-start"));
    expect(listener).not.toHaveBeenCalled();
    document.removeEventListener("ide-debug", listener);
  });
});
