import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import * as React from "react";

const runWorkflow = vi.fn();
const stop = vi.fn();
const exec = {
  logs: [],
  status: { text: "Idle", type: "idle" as const },
  isRunning: false,
  isInstalling: false,
  executionId: null,
  missingDependencyHint: null,
  workflowTasks: [
    { id: "npm:test", name: "test", kind: "test" as const, origin: "package.json" as const },
    { id: "npm:build", name: "build", kind: "build" as const, origin: "package.json" as const },
  ],
  testResults: [
    {
      name: "adds",
      status: "passed" as const,
      file: "tests/add.test.js",
      line: 3,
    },
    {
      name: "fails",
      status: "failed" as const,
      file: "tests/add.test.js",
      line: 8,
      message: "expected 3",
    },
  ],
  lastWorkflowTaskId: "npm:test",
  lastWorkflowKind: "test" as const,
  run: vi.fn(),
  runWorkflow,
  refreshWorkflow: vi.fn(),
  stop,
  sendStdin: vi.fn(),
  clearLogs: vi.fn(),
  install: vi.fn(),
};

vi.mock("../src/hooks/useExecutionSession", () => ({
  useExecutionSession: () => exec,
}));
vi.mock("../src/hooks/useDebugger", () => ({
  useOptionalDebugSession: () => null,
}));

import TestExplorer from "../src/components/Workflow/TestExplorer";

describe("TestExplorer", () => {
  afterEach(() => {
    cleanup();
    runWorkflow.mockClear();
    stop.mockClear();
  });

  it("lists discovered tasks and results", () => {
    const { getByTestId, getAllByTestId } = render(
      <TestExplorer projectRole="owner" />,
    );
    expect(getByTestId("workflow-task-npm:test")).toBeTruthy();
    expect(getByTestId("workflow-task-npm:build")).toBeTruthy();
    expect(getAllByTestId("workflow-result")).toHaveLength(2);
  });

  it("run all sends the discovered test task", () => {
    const { getByTestId } = render(<TestExplorer projectRole="owner" />);
    fireEvent.click(getByTestId("workflow-run-all"));
    expect(runWorkflow).toHaveBeenCalledWith({ taskId: "npm:test" });
  });

  it("clicking a failure location opens the editor", () => {
    const opened: unknown[] = [];
    const onReveal = (e: Event) => opened.push((e as CustomEvent).detail);
    document.addEventListener("ide-open-and-reveal", onReveal);
    const { getAllByTestId } = render(<TestExplorer projectRole="owner" />);
    fireEvent.click(getAllByTestId("workflow-result-loc")[1]);
    expect(opened).toEqual([
      { filePath: "tests/add.test.js", line: 8, column: 1 },
    ]);
    document.removeEventListener("ide-open-and-reveal", onReveal);
  });

  it("viewers cannot run tasks", () => {
    const { getByTestId } = render(<TestExplorer projectRole="viewer" />);
    expect((getByTestId("workflow-run-all") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("refresh rediscovers tasks", () => {
    const { getByTestId } = render(<TestExplorer projectRole="owner" />);
    fireEvent.click(getByTestId("workflow-refresh"));
    expect(exec.refreshWorkflow).toHaveBeenCalled();
  });
});
