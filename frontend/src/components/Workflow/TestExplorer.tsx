import React, { useMemo, useState } from "react";
import { useExecutionSession } from "../../hooks/useExecutionSession";
import { useOptionalDebugSession } from "../../hooks/useDebugger";
import type { ProjectRole } from "../../hooks/useProjectRole";
import type { WorkflowTestResult } from "../../api";
import { IconPlay, IconStop, IconCheck } from "../common/Icons";

function mark(status: WorkflowTestResult["status"]): string {
  switch (status) {
    case "passed":
      return "✓";
    case "failed":
    case "error":
      return "✗";
    case "skipped":
      return "○";
    default:
      return "·";
  }
}

function locOf(t: WorkflowTestResult): string | null {
  if (!t.file) return null;
  return typeof t.line === "number" && t.line > 0
    ? `${t.file}:${t.line}`
    : t.file;
}

export default function TestExplorer({
  projectRole = "viewer",
}: {
  projectRole?: ProjectRole;
}) {
  const exec = useExecutionSession();
  const dbg = useOptionalDebugSession();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const debugging = Boolean(
    dbg &&
      (dbg.state === "starting" ||
        dbg.state === "running" ||
        dbg.state === "paused" ||
        dbg.state === "stopping"),
  );
  const canRun = projectRole !== "viewer" && !exec.isRunning && !exec.isInstalling && !debugging;
  const testTasks = exec.workflowTasks.filter((t) => t.kind === "test");
  const buildTasks = exec.workflowTasks.filter((t) => t.kind === "build");
  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) return exec.testResults;
    return exec.testResults.filter((t) => {
      const hay = `${t.name} ${t.file ?? ""} ${t.message ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [exec.testResults, q]);
  const selectedResult = results.find((t) => t.name === selected) ?? null;
  const failed = exec.testResults.filter(
    (t) => t.status === "failed" || t.status === "error",
  );
  const defaultTest = testTasks[0];

  const runTask = (taskId: string, targetPath?: string) => {
    exec.runWorkflow({ taskId, targetPath });
  };

  const runAll = () => {
    if (defaultTest) runTask(defaultTest.id);
  };

  const runSelected = () => {
    if (!defaultTest) return;
    if (selectedResult?.file) runTask(defaultTest.id, selectedResult.file);
    else runAll();
  };

  const runFailed = () => {
    if (!defaultTest) return;
    const files = [...new Set(failed.map((t) => t.file).filter(Boolean))] as string[];
    if (files.length === 1) runTask(defaultTest.id, files[0]);
    else runTask(defaultTest.id);
  };

  const openLoc = (t: WorkflowTestResult) => {
    if (!t.file) return;
    document.dispatchEvent(
      new CustomEvent("ide-open-and-reveal", {
        detail: { filePath: t.file, line: t.line || 1, column: 1 },
      }),
    );
  };

  return (
    <div className="workflow-panel" data-testid="test-explorer">
      <div className="workflow-toolbar" role="toolbar" aria-label="Tests">
        <span
          className={`workflow-state workflow-state-${
            exec.isRunning
              ? "running"
              : exec.status.type === "error"
                ? "failed"
                : exec.status.type === "success"
                  ? "passed"
                  : "idle"
          }`}
          data-testid="workflow-status"
        >
          {exec.isRunning ? "Running" : exec.status.text}
        </span>
        <button
          type="button"
          className="glass-btn"
          data-testid="workflow-run-all"
          disabled={!canRun || !defaultTest}
          onClick={runAll}
          title="Run all discovered tests"
        >
          <IconPlay size={12} />
          <span>Run all</span>
        </button>
        <button
          type="button"
          className="glass-btn"
          data-testid="workflow-run-selected"
          disabled={!canRun || !defaultTest}
          onClick={runSelected}
        >
          Run selected
        </button>
        <button
          type="button"
          className="glass-btn"
          data-testid="workflow-run-failed"
          disabled={!canRun || !defaultTest || failed.length === 0}
          onClick={runFailed}
        >
          Run failed
        </button>
        <button
          type="button"
          className="glass-btn"
          data-testid="workflow-stop"
          disabled={!exec.isRunning}
          onClick={exec.stop}
        >
          <IconStop size={12} />
          <span>Stop</span>
        </button>
        <input
          className="workflow-search"
          data-testid="workflow-search"
          placeholder="Search tests"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {debugging && (
        <p className="workflow-muted">
          Stop the debugger before running tests or builds.
        </p>
      )}
      {projectRole === "viewer" && (
        <p className="workflow-muted">Viewers can inspect results but cannot run tasks.</p>
      )}

      <div className="workflow-section">
        <h3>Tests</h3>
        {testTasks.length === 0 && (
          <p className="workflow-muted" data-testid="workflow-empty">
            No test tasks discovered. Add a package.json script named{" "}
            <code>test</code> or <code>test:*</code>, or a pytest project.
          </p>
        )}
        {testTasks.length > 0 && (
          <div className="workflow-tasks" data-testid="workflow-test-tasks">
            {testTasks.map((t) => (
              <button
                key={t.id}
                type="button"
                className="glass-btn"
                data-testid={`workflow-task-${t.id}`}
                disabled={!canRun}
                onClick={() => runTask(t.id)}
                title={`${t.origin} · ${t.id}`}
              >
                <IconCheck size={12} />
                <span>{t.name}</span>
              </button>
            ))}
          </div>
        )}
        {results.length > 0 && (
          <ul className="workflow-list" data-testid="workflow-results">
            {results.map((t) => {
              const loc = locOf(t);
              const key = `${t.name}:${t.file ?? ""}:${t.line ?? ""}`;
              return (
                <li
                  key={key}
                  className={`workflow-item ${selected === t.name ? "selected" : ""}`}
                  data-testid="workflow-result"
                  data-status={t.status}
                  onClick={() => setSelected(t.name)}
                >
                  <span className={`workflow-mark workflow-mark-${t.status}`}>
                    {mark(t.status)}
                  </span>
                  <div className="workflow-item-body">
                    <div className="workflow-item-name">{t.name}</div>
                    {loc && (
                      <button
                        type="button"
                        className="link"
                        data-testid="workflow-result-loc"
                        onClick={(e) => {
                          e.stopPropagation();
                          openLoc(t);
                        }}
                      >
                        {loc}
                      </button>
                    )}
                    {t.message && selected === t.name && (
                      <pre className="workflow-detail">{t.message}</pre>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="workflow-section" style={{ flex: "0 0 auto", maxHeight: 140 }}>
        <h3>Tasks &amp; builds</h3>
        {buildTasks.length === 0 && (
          <p className="workflow-muted" data-testid="workflow-build-empty">
            No build tasks. Add a package.json script named <code>build</code>{" "}
            or <code>build:*</code>.
          </p>
        )}
        {buildTasks.length > 0 && (
          <div className="workflow-tasks" data-testid="workflow-build-tasks">
            {buildTasks.map((t) => (
              <button
                key={t.id}
                type="button"
                className="glass-btn"
                data-testid={`workflow-task-${t.id}`}
                disabled={!canRun}
                onClick={() => runTask(t.id)}
              >
                <IconPlay size={12} />
                <span>{t.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
