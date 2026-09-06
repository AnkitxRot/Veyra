import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as React from "react";
import SharedRunOutputPanel from "../src/components/Output/SharedRunOutputPanel";
import type { RunStatusEntry, SharedRunOutput } from "../src/types";

afterEach(cleanup);

const status = (over: Partial<RunStatusEntry> = {}): RunStatusEntry => ({
  executionId: "e1",
  userId: 2,
  username: "Bob",
  state: "running",
  file: "src/app.py",
  language: "python",
  startedAt: Date.now(),
  endedAt: null,
  exitCode: null,
  ...over,
});

const output = (over: Partial<SharedRunOutput> = {}): SharedRunOutput => ({
  executionId: "e1",
  truncated: false,
  chunks: [
    { stream: "stdout", data: "compiling...\n" },
    { stream: "stderr", data: "warning: unused var\n" },
  ],
  ...over,
});

describe("SharedRunOutputPanel", () => {
  it("names the collaborator running and the file, and shows the output", () => {
    render(
      <SharedRunOutputPanel
        output={output()}
        status={status()}
        connected
      />,
    );
    expect(screen.getByText(/Bob/)).toBeTruthy();
    expect(screen.getByText(/src\/app\.py/)).toBeTruthy();
    expect(screen.getByText(/compiling\.\.\./)).toBeTruthy();
    expect(screen.getByText(/warning: unused var/)).toBeTruthy();
  });

  it("distinguishes running / completed / failed states", () => {
    const { rerender } = render(
      <SharedRunOutputPanel output={output()} status={status()} connected />,
    );
    expect(screen.getAllByText(/running/i).length).toBeGreaterThan(0);

    rerender(
      <SharedRunOutputPanel
        output={output()}
        status={status({ state: "success", exitCode: 0, endedAt: Date.now() })}
        connected
      />,
    );
    expect(
      screen.getAllByText(/completed|success|exited/i).length,
    ).toBeGreaterThan(0);

    rerender(
      <SharedRunOutputPanel
        output={output()}
        status={status({ state: "failed", exitCode: 1, endedAt: Date.now() })}
        connected
      />,
    );
    expect(screen.getAllByText(/failed/i).length).toBeGreaterThan(0);
  });

  it("shows a truncation marker when output was dropped", () => {
    render(
      <SharedRunOutputPanel
        output={output({ truncated: true })}
        status={status()}
        connected
      />,
    );
    expect(screen.getByText(/earlier output.*truncated|truncated/i)).toBeTruthy();
  });

  it("shows an unavailable notice when the collaboration link is down", () => {
    render(
      <SharedRunOutputPanel
        output={output()}
        status={status()}
        connected={false}
      />,
    );
    expect(screen.getByText(/unavailable|reconnect/i)).toBeTruthy();
  });

  it("is read-only: no stdin field and no stop control", () => {
    render(
      <SharedRunOutputPanel output={output()} status={status()} connected />,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /stop|kill|send/i })).toBeNull();
  });

  it("still renders output with no matching status entry (status lingered out)", () => {
    render(
      <SharedRunOutputPanel
        output={output()}
        status={undefined}
        connected
      />,
    );
    expect(screen.getByText(/compiling\.\.\./)).toBeTruthy();
  });
});
