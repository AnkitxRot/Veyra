import React from "react";
import { useOptionalDebugSession } from "../../hooks/useDebugger";
import {
  IconPlay,
  IconStop,
  IconChevronRight,
  IconAlertTriangle,
} from "../common/Icons";

function stateLabel(state: string): string {
  switch (state) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "paused":
      return "Paused";
    case "stopping":
      return "Stopping";
    case "failed":
      return "Failed";
    case "unavailable":
      return "Unavailable";
    case "terminated":
      return "Stopped";
    default:
      return "Idle";
  }
}

export default function DebugPanel() {
  const dbg = useOptionalDebugSession();
  if (!dbg) {
    return (
      <div className="debug-panel" data-testid="debug-panel">
        <p className="debug-muted">Open a project to debug.</p>
      </div>
    );
  }
  const paused = dbg.state === "paused";
  const running = dbg.state === "running";
  const starting = dbg.state === "starting";
  const stopping = dbg.state === "stopping";
  const live = starting || running || paused || stopping;

  return (
    <div className="debug-panel" data-testid="debug-panel">
      <div className="debug-toolbar" role="toolbar" aria-label="Debugger">
        <span
          className={`debug-state debug-state-${dbg.state}`}
          data-testid="debug-status"
        >
          {stateLabel(dbg.state)}
        </span>
        <button
          type="button"
          className="glass-btn"
          data-testid="debug-continue"
          disabled={!paused}
          onClick={dbg.continueRun}
          title="Continue"
        >
          <IconPlay size={12} />
          <span>Continue</span>
        </button>
        <button
          type="button"
          className="glass-btn"
          data-testid="debug-pause"
          disabled={!running}
          onClick={dbg.pause}
          title="Pause"
        >
          <span>Pause</span>
        </button>
        <button
          type="button"
          className="glass-btn"
          disabled={!paused}
          onClick={dbg.stepOver}
          title="Step Over"
          data-testid="debug-step-over"
        >
          <span>Over</span>
        </button>
        <button
          type="button"
          className="glass-btn"
          disabled={!paused}
          onClick={dbg.stepIn}
          title="Step Into"
          data-testid="debug-step-into"
        >
          <span>Into</span>
        </button>
        <button
          type="button"
          className="glass-btn"
          disabled={!paused}
          onClick={dbg.stepOut}
          title="Step Out"
          data-testid="debug-step-out"
        >
          <span>Out</span>
        </button>
        <button
          type="button"
          className="glass-btn btn-stop"
          disabled={!live}
          onClick={dbg.stop}
          title="Stop"
          data-testid="debug-stop"
        >
          <IconStop size={12} />
          <span>Stop</span>
        </button>
      </div>
      {dbg.message && (
        <div className="debug-message" data-testid="debug-message">
          {dbg.message}
        </div>
      )}
      {dbg.sourceMismatch && (
        <div className="debug-mismatch" role="status">
          <IconAlertTriangle size={12} />
          The paused file has unsaved edits. The debuggee is still running the
          snapshot from launch.
        </div>
      )}
      <div className="debug-columns">
        <section className="debug-stack" aria-label="Call stack" data-testid="debug-stack">
          <h3>Call stack</h3>
          {dbg.frames.length === 0 && (
            <p className="debug-muted">No stack — start debugging to pause.</p>
          )}
          <ul>
            {dbg.frames.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  className={`debug-frame ${
                    dbg.pausedLine === f.line && dbg.pausedPath === f.path
                      ? "active"
                      : ""
                  }`}
                  onClick={() => dbg.selectFrame(f)}
                >
                  <IconChevronRight size={10} />
                  <span>
                    {f.name}
                    {f.path ? ` — ${f.path}:${f.line}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="debug-vars" aria-label="Variables" data-testid="debug-variables">
          <h3>Variables</h3>
          {dbg.scopes.map((scope) => (
            <div key={scope.variablesReference} className="debug-scope">
              <div className="debug-scope-name">{scope.name}</div>
              <ul>
                {(dbg.variables[scope.variablesReference] ?? []).map((v) => (
                  <li key={v.name}>
                    <button
                      type="button"
                      className="debug-var"
                      disabled={v.variablesReference <= 0}
                      onClick={() =>
                        v.variablesReference > 0 &&
                        dbg.expandVariables(v.variablesReference)
                      }
                    >
                      <span className="debug-var-name">{v.name}</span>
                      <span className="debug-var-value">{v.value}</span>
                    </button>
                    {v.variablesReference > 0 &&
                      (dbg.variables[v.variablesReference] ?? []).map((c) => (
                        <div key={c.name} className="debug-var nested">
                          <span className="debug-var-name">{c.name}</span>
                          <span className="debug-var-value">{c.value}</span>
                        </div>
                      ))}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      </div>
      {dbg.output.length > 0 && (
        <pre className="debug-output" data-testid="debug-output">
          {dbg.output.map((l) => l.text).join("")}
        </pre>
      )}
    </div>
  );
}
