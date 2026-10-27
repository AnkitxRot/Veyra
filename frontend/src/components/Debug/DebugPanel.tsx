import React from "react";
import { useOptionalDebugSession } from "../../hooks/useDebugger";
import { IconPlay, IconStop, IconChevronRight, IconAlertTriangle } from "../common/Icons";

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

function AddRow({
  placeholder,
  testId,
  onSubmit,
}: {
  placeholder: string;
  testId: string;
  onSubmit: (v: string) => void;
}) {
  const [v, setV] = React.useState("");
  return (
    <form
      className="debug-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (!v.trim()) return;
        onSubmit(v);
        setV("");
      }}
    >
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        data-testid={testId}
        maxLength={1024}
        spellCheck={false}
      />
    </form>
  );
}

function BreakpointRow({
  path,
  line,
  spec,
  onChange,
  onRemove,
}: {
  path: string;
  line: number;
  spec: { condition?: string; hitCondition?: string; logMessage?: string };
  onChange: (patch: { condition?: string; hitCondition?: string; logMessage?: string }) => void;
  onRemove: () => void;
}) {
  const field = (key: "condition" | "hitCondition" | "logMessage", label: string) => (
    <input
      defaultValue={spec[key] ?? ""}
      placeholder={label}
      aria-label={`${label} for ${path}:${line}`}
      maxLength={512}
      spellCheck={false}
      onBlur={(e) => {
        if (e.target.value !== (spec[key] ?? "")) onChange({ [key]: e.target.value });
      }}
    />
  );
  return (
    <li className="debug-bp" data-testid="debug-bp-row">
      <span className="debug-bp-loc">
        {path}:{line}
      </span>
      {field("condition", "Condition")}
      {field("hitCondition", "Hit count")}
      {field("logMessage", "Log message")}
      <button type="button" className="glass-btn" onClick={onRemove} title="Remove breakpoint">
        ×
      </button>
    </li>
  );
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
        <span className={`debug-state debug-state-${dbg.state}`} data-testid="debug-status">
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
          The paused file has unsaved edits. The debuggee is still running the snapshot from launch.
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
                    dbg.pausedLine === f.line && dbg.pausedPath === f.path ? "active" : ""
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
                        v.variablesReference > 0 && dbg.expandVariables(v.variablesReference)
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
      <div className="debug-columns">
        <section className="debug-watch" aria-label="Watch" data-testid="debug-watch">
          <h3>Watch</h3>
          <ul>
            {dbg.watches.map((w) => {
              const r = dbg.watchResults[w];
              return (
                <li key={w} className="debug-watch-row">
                  <span className="debug-var-name">{w}</span>
                  <span className={r?.error ? "debug-var-value debug-err" : "debug-var-value"}>
                    {paused ? (r ? (r.error ?? r.result) : "…") : "—"}
                  </span>
                  <button
                    type="button"
                    className="glass-btn"
                    onClick={() => dbg.removeWatchExpr(w)}
                    title="Remove watch"
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
          <AddRow placeholder="Add watch expression" testId="debug-watch-add" onSubmit={dbg.addWatchExpr} />
        </section>
        <section className="debug-bps" aria-label="Breakpoints" data-testid="debug-breakpoints">
          <h3>Breakpoints</h3>
          {Object.keys(dbg.breakpoints).length === 0 && (
            <p className="debug-muted">Click the editor gutter to add a breakpoint.</p>
          )}
          <ul>
            {Object.entries(dbg.breakpoints).flatMap(([path, lines]) =>
              lines.map((line) => (
                <BreakpointRow
                  key={`${path}:${line}:${JSON.stringify(dbg.specs[path]?.[String(line)] ?? {})}`}
                  path={path}
                  line={line}
                  spec={dbg.specs[path]?.[String(line)] ?? {}}
                  onChange={(patch) => dbg.setBreakpointSpec(path, line, patch)}
                  onRemove={() => dbg.toggleBreakpoint(path, line)}
                />
              )),
            )}
          </ul>
        </section>
      </div>
      <section className="debug-console" aria-label="Debug console" data-testid="debug-console">
        <h3>Debug console</h3>
        <ul>
          {dbg.consoleLog.map((c, i) => (
            <li key={i}>
              <span className="debug-var-name">&gt; {c.expression}</span>
              <span className={c.error ? "debug-var-value debug-err" : "debug-var-value"}>
                {c.error ?? c.result}
              </span>
            </li>
          ))}
        </ul>
        <AddRow
          placeholder={paused ? "Evaluate expression" : "Pause to evaluate"}
          testId="debug-console-input"
          onSubmit={dbg.evaluateInConsole}
        />
      </section>
      {dbg.output.length > 0 && (
        <pre className="debug-output" data-testid="debug-output">
          {dbg.output.map((l) => l.text).join("")}
        </pre>
      )}
    </div>
  );
}
