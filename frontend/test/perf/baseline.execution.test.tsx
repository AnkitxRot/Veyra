/**
 * M71 Phase 0 — BASELINE B: execution-log stream.
 *
 * Spec target #2: "does useExecutionSession context propagation during
 * streamed output re-render controls-only consumers for every log batch?"
 *
 * DISCOVERY FACT: the only consumer of `useExecutionSession()` in the whole
 * codebase is <Output> (grep). Toolbar mirrors run state via `document`
 * events, not the context. So a "controls-only consumer" is hypothetical.
 *
 * This test measures:
 *  1. the rAF batching guarantee — many stdout frames collapse to few commits
 *  2. what a hypothetical controls-only consumer WOULD cost (to classify)
 *  3. the real <Output> consumer's commit count
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";
import * as React from "react";
import { RenderRecorder, Probe, summarize } from "./harness";

const apiMock = vi.fn();
vi.mock("../../src/api", () => ({
  api: (...a: any[]) => apiMock(...a),
  getWebSocketUrl: (p: string, id: string) => `ws://test${p}?projectId=${id}`,
}));

import Output from "../../src/components/Output/Output";
import {
  ExecutionSessionProvider,
  useExecutionSession,
} from "../../src/hooks/useExecutionSession";

Element.prototype.scrollIntoView =
  Element.prototype.scrollIntoView || (() => {});

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  msg(o: unknown) {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
  static latest() {
    return this.instances[this.instances.length - 1];
  }
}

const project = { id: "proj-1", name: "P" };

/** Reads ONLY controls — the hypothetical consumer the spec asks about. */
function ControlsOnlyProbe() {
  const { isRunning, run, stop } = useExecutionSession();
  void run;
  void stop;
  return <div data-testid="controls">{isRunning ? "run" : "idle"}</div>;
}

function Host({
  recorder,
  showOutput,
}: {
  recorder: RenderRecorder;
  showOutput: boolean;
}) {
  return (
    <ExecutionSessionProvider projectId={project.id}>
      <Probe id="controls-only" recorder={recorder}>
        <ControlsOnlyProbe />
      </Probe>
      {showOutput && (
        <Probe id="output" recorder={recorder}>
          <Output project={project} onRefreshTree={() => {}} />
        </Probe>
      )}
    </ExecutionSessionProvider>
  );
}

beforeEach(() => {
  apiMock.mockReset();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LINES = 500;
const REPEATS = 3;

describe("M71 BASELINE B — execution-log stream", () => {
  it("records commit counts for a 500-line streamed run", async () => {
    const controlsRuns: number[] = [];
    const outputRuns: number[] = [];
    const commitPerLine: number[] = [];

    for (let r = 0; r < REPEATS; r++) {
      const recorder = new RenderRecorder();
      const view = render(<Host recorder={recorder} showOutput={true} />);

      document.dispatchEvent(
        new CustomEvent("ide-run-confirmed", {
          detail: { language: "python", activeFile: "m.py", langDisplay: "Python" },
        }),
      );
      await waitFor(() =>
        expect(FakeWebSocket.instances.length).toBeGreaterThan(0),
      );
      const ws = FakeWebSocket.latest();
      act(() => ws.open());

      recorder.reset(); // measure only the streaming phase

      // Stream LINES stdout frames in bursts, letting rAF flush between bursts.
      for (let i = 0; i < LINES; i += 25) {
        act(() => {
          for (let j = 0; j < 25 && i + j < LINES; j++) {
            ws.msg({ type: "stdout", data: `line ${i + j}\n` });
          }
        });
        // allow the rAF-batched flush to commit
        await act(async () => {
          await new Promise((res) => setTimeout(res, 20));
        });
      }
      await act(async () => {
        await new Promise((res) => setTimeout(res, 30));
      });

      controlsRuns.push(recorder.count("controls-only"));
      outputRuns.push(recorder.count("output"));
      commitPerLine.push(
        Math.round((recorder.count("output") / LINES) * 1000) / 1000,
      );

      act(() => view.unmount());
    }

    const results = {
      streamedLines: LINES,
      controlsOnlyConsumerCommits: summarize(controlsRuns),
      outputConsumerCommits: summarize(outputRuns),
      outputCommitsPerStdoutFrame: summarize(commitPerLine),
      note: "Only <Output> consumes useExecutionSession() in the real app; the controls-only consumer is hypothetical (see file header).",
    };
    console.log(
      `\n=== M71 BASELINE B: execution-log stream (${LINES} lines, ${REPEATS} repeats) ===\n` +
        JSON.stringify(results, null, 2),
    );

    // Deterministic invariant: rAF batching means commits are FAR fewer than
    // streamed frames — the log path is already batched.
    expect(summarize(outputRuns).max).toBeLessThan(LINES / 2);
    // The controls-only consumer re-renders in lockstep with Output because the
    // context value is a single object. Documented; classified in STATUS.
    expect(summarize(controlsRuns).max).toBeGreaterThan(0);
  });
});
