import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import * as React from "react";
import type { Project, User } from "../src/types";

const apiMock = vi.fn();
vi.mock("../src/api", () => ({
  api: (...args: any[]) => apiMock(...args),
}));

import Sidebar from "../src/components/Sidebar/Sidebar";

function baseProps(
  overrides: Partial<React.ComponentProps<typeof Sidebar>> = {},
) {
  const user: User = { id: 1, username: "alice" };
  const project: Project = { id: "proj-1", name: "My Project" };
  return {
    user,
    projects: [project],
    project,
    onSelectProject: vi.fn(),
    onCreateProject: vi.fn(),
    tree: [],
    onOpenFile: vi.fn(),
    activeFile: null,
    onLogout: vi.fn(),
    refreshTree: vi.fn(),
    ...overrides,
  };
}

describe("Sidebar — Milestone 28 Fork Project UI", () => {
  beforeEach(() => {
    apiMock.mockReset();
    vi.spyOn(window, "alert").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows a Fork Project action when a project is selected", () => {
    const props = baseProps();
    const { getByTitle } = render(React.createElement(Sidebar, props as any));
    expect(getByTitle("Fork Project")).toBeTruthy();
  });

  it("clicking Fork Project opens a name prompt pre-filled with a suggested fork name", () => {
    const props = baseProps();
    const { getByTitle, getByDisplayValue } = render(
      React.createElement(Sidebar, props as any),
    );
    fireEvent.click(getByTitle("Fork Project"));
    expect(getByDisplayValue("My Project (Fork)")).toBeTruthy();
  });

  it("success path: confirming posts to the fork endpoint, refreshes the project list, and selects the new project", async () => {
    const forkedProject: Project = { id: "proj-2", name: "Custom Fork Name" };
    apiMock.mockResolvedValueOnce({
      project: forkedProject,
      fileCount: 3,
      totalBytes: 42,
    });

    const props = baseProps();
    const { getByTitle, getByDisplayValue, getByText } = render(
      React.createElement(Sidebar, props as any),
    );
    fireEvent.click(getByTitle("Fork Project"));

    const input = getByDisplayValue("My Project (Fork)") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Custom Fork Name" } });
    fireEvent.click(getByText("Fork"));

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    expect(apiMock).toHaveBeenCalledWith(
      "/api/projects/proj-1/fork",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Custom Fork Name" }),
      }),
    );

    await waitFor(() => expect(props.onCreateProject).toHaveBeenCalledTimes(1));
    expect(props.onSelectProject).toHaveBeenCalledWith(forkedProject);
  });

  it("error path: a failed fork surfaces an error and does not refresh the project list", async () => {
    apiMock.mockRejectedValueOnce(new Error("workspace too large"));

    const props = baseProps();
    const { getByTitle, getByText } = render(
      React.createElement(Sidebar, props as any),
    );
    fireEvent.click(getByTitle("Fork Project"));
    fireEvent.click(getByText("Fork"));

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    expect(window.alert).toHaveBeenCalledWith(
      expect.stringContaining("workspace too large"),
    );
    expect(props.onCreateProject).not.toHaveBeenCalled();
  });

  it("does not fire a duplicate fork request on a rapid double confirm", async () => {
    let resolveFork: (v: any) => void = () => {};
    apiMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFork = resolve;
        }),
    );

    const props = baseProps();
    const { getByTitle, getByText } = render(
      React.createElement(Sidebar, props as any),
    );
    fireEvent.click(getByTitle("Fork Project"));
    // Same button node clicked twice before the request resolves — the
    // `isForking` guard in handleForkProject must make the second click a
    // no-op. (The button's own label flips to "Forking…" after the first
    // click, which is itself the visible loading-state proof.)
    const forkButton = getByText("Fork");
    fireEvent.click(forkButton);
    fireEvent.click(forkButton);

    resolveFork({
      project: { id: "proj-3", name: "x" },
      fileCount: 0,
      totalBytes: 0,
    });
    await waitFor(() => expect(props.onCreateProject).toHaveBeenCalledTimes(1));
    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});
