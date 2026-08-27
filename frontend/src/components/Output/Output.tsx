import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  Suspense,
} from "react";
import { getWebSocketUrl, api } from "../../api";
import {
  IconTrash,
  IconCheck,
  IconClose,
  IconRefresh,
  IconDownload,
} from "../common/Icons";
import { getLanguageIcon } from "../common/iconUtils";
import { RunRecord, SnapshotRecord } from "../../types";
import { PromptModal, ConfirmModal } from "../common/Modal";
import {
  detectMissingDependency,
  MissingDependencyMatch,
} from "../../utils/missingDependency";
const ExecutionTelemetryModal = React.lazy(
  () => import("./ExecutionTelemetryModal"),
);

type LogLine = {
  type: "stdout" | "stderr" | "system" | "error";
  text: string;
  time: string;
};

export default function Output({ project, onRefreshTree }: any) {
  const [activeTab, setActiveTab] = useState<
    "console" | "history" | "snapshots"
  >("console");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  // M43: the install effect below needs the *current* isRunning value at the
  // moment ide-install-confirmed fires, as a defense-in-depth check backing
  // Toolbar's own disabled-button enforcement. Reading `isRunning` directly
  // from that effect's closure would capture a stale snapshot (the effect's
  // own deps are just [project]), so a ref mirrors it instead.
  const isRunningRef = useRef(false);
  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);
  const [statusBadge, setStatusBadge] = useState<{
    text: string;
    type: "idle" | "running" | "success" | "error";
  }>({
    text: "Idle",
    type: "idle",
  });
  // M44: set only from the just-finished run's own exit handler, cleared at
  // the start of every new run and the moment an install begins — belongs
  // exclusively to "the current run's own failure", never carried over.
  const [missingDependencyHint, setMissingDependencyHint] =
    useState<MissingDependencyMatch | null>(null);
  // M44: drives the inline hint's own disabled state. Set directly by the
  // M43 install effect below (not derived from the install-started/-stopped
  // document events it itself dispatches, to avoid listening for its own
  // broadcast).
  const [isInstalling, setIsInstalling] = useState(false);

  // History state
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [selectedRunForTelemetry, setSelectedRunForTelemetry] =
    useState<RunRecord | null>(null);

  // Snapshots state
  const [snapshots, setSnapshots] = useState<SnapshotRecord[]>([]);
  const [loadingSnapshots, setLoadingSnapshots] = useState(false);
  const [modalState, setModalState] = useState<{
    type: "new_snapshot" | "restore_snapshot" | "delete_snapshot" | null;
    snapshot?: SnapshotRecord;
  }>({ type: null });

  const scrollToBottom = () => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    if (activeTab === "console") scrollToBottom();
  }, [logs, activeTab]);

  const loadRuns = useCallback(async () => {
    if (!project) return;
    setLoadingRuns(true);
    try {
      const res = await api<{ runs: RunRecord[] }>(
        `/api/projects/${project.id}/runs?limit=25`,
      );
      setRuns(res.runs || []);
    } catch {
      // ignore fetch errors
    } finally {
      setLoadingRuns(false);
    }
  }, [project]);

  const loadSnapshots = useCallback(async () => {
    if (!project) return;
    setLoadingSnapshots(true);
    try {
      const res = await api<{ snapshots: SnapshotRecord[] }>(
        `/api/projects/${project.id}/snapshots`,
      );
      setSnapshots(res.snapshots || []);
    } catch {
      // ignore fetch errors
    } finally {
      setLoadingSnapshots(false);
    }
  }, [project]);

  useEffect(() => {
    if (activeTab === "history") loadRuns();
    if (activeTab === "snapshots") loadSnapshots();
  }, [activeTab, project, loadRuns, loadSnapshots]);

  useEffect(() => {
    // M45: mirrors M43's installInFlight — tracked at the effect's own
    // scope (not inside handleRun's per-invocation closure) specifically
    // so the cleanup function below can see whether a run is still active
    // when this effect tears down, e.g. the user switches away from the
    // Output tab mid-run. Set true when a run starts, false the moment any
    // of the three normal completion paths (exit message, onclose,
    // onerror) has already handled it — so the cleanup's own dispatch only
    // ever fires for the genuinely-new case none of those three reached.
    let runInFlight = false;

    const handleRun = (e: Event) => {
      const { language, activeFile, langDisplay } = (e as CustomEvent).detail;
      if (!project) return;

      setActiveTab("console");
      const time = new Date().toLocaleTimeString();
      setLogs([
        {
          type: "system",
          text: `Starting execution (${activeFile ? `${activeFile} → ` : ""}${langDisplay || language})...`,
          time,
        },
      ]);
      // M44: a new run starts with a clean slate — any missing-dependency
      // hint belongs to the run that produced it, never to this new one.
      setMissingDependencyHint(null);
      runInFlight = true;
      setIsRunning(true);
      setStatusBadge({ text: "Running", type: "running" });
      document.dispatchEvent(new Event("run-started"));

      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        wsRef.current.close();
      }

      const ws = new WebSocket(getWebSocketUrl("/ws/execute", project.id));
      wsRef.current = ws;
      let exitedNormally = false;
      let accStdout = "";
      let accStderr = "";
      let logBuffer: LogLine[] = [];
      let rafId: number | null = null;

      const flushLogs = () => {
        if (logBuffer.length === 0) return;
        const toAppend = logBuffer;
        logBuffer = [];
        setLogs((prev) => {
          const next = [...prev, ...toAppend];
          return next.length > 2000 ? next.slice(next.length - 2000) : next;
        });
      };

      const appendLog = (logLine: Omit<LogLine, "time">) => {
        const now = new Date().toLocaleTimeString();
        logBuffer.push({ ...logLine, time: now });
        if (rafId === null) {
          rafId = requestAnimationFrame(() => {
            rafId = null;
            flushLogs();
          });
        }
      };

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "start", language, activeFile }));
      };

      ws.onmessage = (msg) => {
        try {
          const parsed = JSON.parse(msg.data);

          if (parsed.type === "stdout") {
            accStdout += parsed.data;
            appendLog({ type: "stdout", text: parsed.data });
          } else if (parsed.type === "stderr") {
            accStderr += parsed.data;
            appendLog({ type: "stderr", text: parsed.data });
          } else if (parsed.type === "status") {
            appendLog({ type: "system", text: parsed.data });
          } else if (parsed.type === "error") {
            accStderr += parsed.data;
            appendLog({ type: "error", text: parsed.data });
            setStatusBadge({ text: "Error", type: "error" });
          } else if (parsed.type === "exit") {
            exitedNormally = true;
            const { exitCode, signal, timedOut, oom } = parsed.result;
            let status = `Process exited with code ${exitCode}`;
            if (signal) status += ` (signal: ${signal})`;
            if (timedOut) status = "Process timed out";
            if (oom) status = "Process ran out of memory (OOM)";
            appendLog({ type: "system", text: status });

            if (parsed.telemetrySummary) {
              const peakMb = (
                parsed.telemetrySummary.peakMemoryBytes /
                (1024 * 1024)
              ).toFixed(1);
              appendLog({
                type: "system",
                text: `Resource Profile — Peak CPU: ${parsed.telemetrySummary.peakCpuPercent}% | Peak Memory: ${peakMb} MB | PIDs: ${parsed.telemetrySummary.peakPids || 1}`,
              });
            }

            if (rafId !== null) {
              cancelAnimationFrame(rafId);
              rafId = null;
            }
            flushLogs();

            runInFlight = false;
            setIsRunning(false);
            setStatusBadge({
              text: exitCode === 0 ? "Exited (0)" : `Exited (${exitCode})`,
              type: exitCode === 0 ? "success" : "error",
            });
            // M44: only a failing run's own stderr is ever inspected — a
            // successful run (exitCode 0) can't be a missing-dependency
            // failure, so detection is skipped entirely rather than relying
            // on the pattern simply not matching clean output.
            setMissingDependencyHint(
              exitCode !== 0 ? detectMissingDependency(accStderr) : null,
            );
            document.dispatchEvent(new Event("run-stopped"));

            // Dispatch execution result for diagnostics / problems parser
            document.dispatchEvent(
              new CustomEvent("ide-execution-result", {
                detail: {
                  result: {
                    ...parsed.result,
                    stdout: accStdout || parsed.result?.stdout || "",
                    stderr: accStderr || parsed.result?.stderr || "",
                  },
                  activeFile,
                  language,
                },
              }),
            );

            loadRuns();
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onclose = () => {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        flushLogs();

        if (!exitedNormally) {
          setLogs((prev) => [
            ...prev,
            {
              type: "system",
              text: "Execution stream closed",
              time: new Date().toLocaleTimeString(),
            },
          ]);
          setStatusBadge({ text: "Stopped", type: "idle" });
        }
        runInFlight = false;
        setIsRunning(false);
        document.dispatchEvent(new Event("run-stopped"));
      };

      ws.onerror = () => {
        setLogs((prev) => [
          ...prev,
          {
            type: "error",
            text: "WebSocket connection error",
            time: new Date().toLocaleTimeString(),
          },
        ]);
        runInFlight = false;
        setIsRunning(false);
        setStatusBadge({ text: "Connection Error", type: "error" });
        document.dispatchEvent(new Event("run-stopped"));
      };
    };

    const handleStop = () => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "stop" }));
        setLogs((prev) => [
          ...prev,
          {
            type: "system",
            text: "Stopping execution process...",
            time: new Date().toLocaleTimeString(),
          },
        ]);
      }
    };

    document.addEventListener("ide-run-confirmed", handleRun);
    document.addEventListener("ide-stop", handleStop);

    return () => {
      document.removeEventListener("ide-run-confirmed", handleRun);
      document.removeEventListener("ide-stop", handleStop);
      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        wsRef.current.close();
      }
      // M45: mirrors M43's installInFlight cleanup dispatch. onclose was
      // just nulled above (deliberately, to avoid a post-unmount setState)
      // — so if a run was still active when this effect tore down (e.g.
      // the user switched away from the Output tab mid-run), neither the
      // exit handler nor onclose will ever get to dispatch run-stopped for
      // it, and Toolbar's isRunning would stay stuck true forever with no
      // way back to Run short of a page reload. runInFlight is already
      // false by the time any of the three normal completion paths (exit
      // message, onclose, onerror) has run, so this can only ever fire for
      // the genuinely-new unmount-while-active case, never as a duplicate.
      if (runInFlight) {
        document.dispatchEvent(new Event("run-stopped"));
      }
    };
  }, [project, loadRuns]);

  // M43: dedicated effect for the dependency-install stream. This is a
  // separate request/response shape from the run WebSocket above (chunked
  // plain-text HTTP, not JSON-framed WS messages), so it gets its own
  // effect rather than being folded into the one above. Reuses the same
  // LogLine/appendLog/rAF-batching approach and the same statusBadge as the
  // single "what is this console currently doing" indicator — Run and
  // Install are mutually exclusive (enforced in Toolbar, and defensively
  // re-checked here), so there is never a genuine ambiguity in sharing it.
  useEffect(() => {
    let isUnmounted = false;
    let installInFlight = false;
    let installReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const installAbortController = new AbortController();
    let installRafId: number | null = null;
    let installLogBuffer: LogLine[] = [];

    const flushInstallLogs = () => {
      if (installLogBuffer.length === 0) return;
      const toAppend = installLogBuffer;
      installLogBuffer = [];
      setLogs((prev) => {
        const next = [...prev, ...toAppend];
        return next.length > 2000 ? next.slice(next.length - 2000) : next;
      });
    };

    const appendInstallLog = (logLine: Omit<LogLine, "time">) => {
      const now = new Date().toLocaleTimeString();
      installLogBuffer.push({ ...logLine, time: now });
      if (installRafId === null) {
        installRafId = requestAnimationFrame(() => {
          installRafId = null;
          flushInstallLogs();
        });
      }
    };

    const handleInstall = async () => {
      if (!project || installInFlight || isRunningRef.current) return;
      installInFlight = true;

      setActiveTab("console");
      setLogs([
        {
          type: "system",
          text: "Installing dependencies...",
          time: new Date().toLocaleTimeString(),
        },
      ]);
      // M44: an install starting — whether from Toolbar's button or the
      // inline missing-dependency hint dispatching the same ide-install
      // event — means any hint from a prior run's failure no longer
      // applies to what's on screen now.
      setMissingDependencyHint(null);
      setIsInstalling(true);
      setStatusBadge({ text: "Installing", type: "running" });
      document.dispatchEvent(new Event("install-started"));

      try {
        const res = await fetch(`/api/projects/${project.id}/install`, {
          method: "POST",
          credentials: "include",
          signal: installAbortController.signal,
        });
        if (isUnmounted) return;

        if (!res.ok) {
          let errText = `Install request failed (${res.status})`;
          try {
            const body = await res.text();
            if (body) errText = body;
          } catch {
            // fall back to the generic status-based message above
          }
          if (isUnmounted) return;
          appendInstallLog({ type: "error", text: errText });
          setStatusBadge({ text: "Install Failed", type: "error" });
          return;
        }

        if (!res.body) {
          appendInstallLog({
            type: "error",
            text: "Install response had no readable body",
          });
          setStatusBadge({ text: "Install Failed", type: "error" });
          return;
        }

        const reader = res.body.getReader();
        installReader = reader;
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (isUnmounted) return;
          if (done) {
            // Flush any buffered partial multibyte sequence held by the
            // decoder so a final split character isn't silently dropped.
            const tail = decoder.decode();
            if (tail) appendInstallLog({ type: "system", text: tail });
            break;
          }
          const chunk = decoder.decode(value, { stream: true });
          if (chunk) appendInstallLog({ type: "system", text: chunk });
        }

        if (installRafId !== null) {
          cancelAnimationFrame(installRafId);
          installRafId = null;
        }
        flushInstallLogs();
        if (isUnmounted) return;
        setStatusBadge({ text: "Install Complete", type: "success" });
      } catch (err: any) {
        if (isUnmounted || err?.name === "AbortError") {
          // Unmount cleanup below already tore this down; don't touch state.
          return;
        }
        if (installRafId !== null) {
          cancelAnimationFrame(installRafId);
          installRafId = null;
        }
        flushInstallLogs();
        appendInstallLog({
          type: "error",
          text: `Install error: ${err?.message || String(err)}`,
        });
        setStatusBadge({ text: "Install Failed", type: "error" });
      } finally {
        installReader = null;
        installInFlight = false;
        if (!isUnmounted) {
          setIsInstalling(false);
          document.dispatchEvent(new Event("install-stopped"));
        }
      }
    };

    document.addEventListener("ide-install-confirmed", handleInstall);

    return () => {
      isUnmounted = true;
      document.removeEventListener("ide-install-confirmed", handleInstall);
      if (installRafId !== null) {
        cancelAnimationFrame(installRafId);
        installRafId = null;
      }
      if (installReader) {
        installReader.cancel().catch(() => {});
      }
      installAbortController.abort();
      // handleInstall's own finally intentionally skips its dispatch once
      // isUnmounted is true (it must not touch React state post-unmount) —
      // so if a fetch/stream was actually in flight when we unmounted, this
      // is the only place left to reset Toolbar's mirrored busy state.
      // Without it, switching away from the Output tab mid-install would
      // leave Run and Install permanently disabled.
      if (installInFlight) {
        document.dispatchEvent(new Event("install-stopped"));
      }
    };
  }, [project]);

  // M44: the inline missing-dependency hint dispatches the exact same event
  // Toolbar's own Install button does — Output's M43 install effect above
  // is the single owner of everything that happens next (fetch, stream,
  // state); this never duplicates any part of that pipeline. Its own
  // `installInFlight`/isRunningRef guards make an extra dispatch here a
  // harmless no-op in any state where it shouldn't start, so no additional
  // guard is needed beyond the `disabled={isInstalling}` on the button.
  const handleInstallHintClick = () => {
    document.dispatchEvent(new Event("ide-install"));
  };

  const handleInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && input) {
      wsRef.current.send(JSON.stringify({ type: "stdin", data: input + "\n" }));
      setLogs((prev) => [
        ...prev,
        {
          type: "stdout",
          text: input + "\n",
          time: new Date().toLocaleTimeString(),
        },
      ]);
      setInput("");
    }
  };

  const handleCreateSnapshot = async (name: string) => {
    if (!project) return;
    try {
      await api(`/api/projects/${project.id}/snapshots`, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      loadSnapshots();
    } catch (err: any) {
      alert(`Error creating snapshot: ${err.message}`);
    } finally {
      setModalState({ type: null });
    }
  };

  const handleRestoreSnapshot = async () => {
    if (!project || !modalState.snapshot) return;
    try {
      await api(
        `/api/projects/${project.id}/snapshots/${modalState.snapshot.id}/restore`,
        {
          method: "POST",
        },
      );
      if (onRefreshTree) onRefreshTree();
      alert("Snapshot restored successfully!");
    } catch (err: any) {
      alert(`Error restoring snapshot: ${err.message}`);
    } finally {
      setModalState({ type: null });
    }
  };

  const handleDeleteSnapshot = async () => {
    if (!project || !modalState.snapshot) return;
    try {
      await api(
        `/api/projects/${project.id}/snapshots/${modalState.snapshot.id}`,
        {
          method: "DELETE",
        },
      );
      loadSnapshots();
    } catch (err: any) {
      alert(`Error deleting snapshot: ${err.message}`);
    } finally {
      setModalState({ type: null });
    }
  };

  return (
    <div
      className="panel-content"
      style={{ display: "flex", flexDirection: "column", height: "100%" }}
    >
      {/* Sub-Tabs Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 12px",
          background: "var(--glass-surface-2)",
          borderBottom: "1px solid var(--glass-border)",
          fontSize: "var(--text-xs)",
        }}
      >
        {/* Navigation Tabs */}
        <div
          className="glass-tabs-container"
          style={{ padding: "2px", background: "rgba(0,0,0,0.2)" }}
        >
          <button
            className={`glass-tab ${activeTab === "console" ? "active" : ""}`}
            onClick={() => setActiveTab("console")}
            style={{ padding: "3px 10px", fontSize: "11px" }}
          >
            Output Console
          </button>
          <button
            className={`glass-tab ${activeTab === "history" ? "active" : ""}`}
            onClick={() => setActiveTab("history")}
            style={{ padding: "3px 10px", fontSize: "11px" }}
          >
            Job History {runs.length > 0 && `(${runs.length})`}
          </button>
          <button
            className={`glass-tab ${activeTab === "snapshots" ? "active" : ""}`}
            onClick={() => setActiveTab("snapshots")}
            style={{ padding: "3px 10px", fontSize: "11px" }}
          >
            Snapshots {snapshots.length > 0 && `(${snapshots.length})`}
          </button>
        </div>

        {/* Tab-Specific Actions */}
        {activeTab === "console" && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span
              className={`glass-badge glass-badge-${statusBadge.type === "running" ? "accent" : statusBadge.type === "success" ? "success" : statusBadge.type === "error" ? "error" : "warning"}`}
            >
              {statusBadge.type === "running" && (
                <span className="capability-dot ready" />
              )}
              {statusBadge.type === "success" && <IconCheck size={10} />}
              {statusBadge.type === "error" && <IconClose size={10} />}
              <span>{statusBadge.text}</span>
            </span>
            <button
              className="glass-btn glass-btn-icon"
              onClick={() => setLogs([])}
              title="Clear Output"
              aria-label="Clear Output"
            >
              <IconTrash size={12} />
            </button>
          </div>
        )}

        {activeTab === "history" && (
          <button
            className="glass-btn glass-btn-icon"
            onClick={loadRuns}
            title="Refresh History"
          >
            <IconRefresh size={12} />
          </button>
        )}

        {activeTab === "snapshots" && (
          <button
            className="glass-btn glass-btn-primary"
            style={{ padding: "3px 8px", fontSize: "11px" }}
            onClick={() => setModalState({ type: "new_snapshot" })}
          >
            + Create Snapshot
          </button>
        )}
      </div>

      {/* Tab 1: Live Output Console */}
      {activeTab === "console" && (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <div className="output-log-container" style={{ flex: 1 }}>
            {logs.length === 0 ? (
              <div
                style={{
                  color: "var(--fg-muted)",
                  fontStyle: "italic",
                  padding: "12px 0",
                }}
              >
                Program output and container execution logs will appear here.
              </div>
            ) : (
              logs.map((log, i) => (
                <span key={i} className={`log-line log-${log.type}`}>
                  {log.text}
                </span>
              ))
            )}
            {/* M44: inline missing-dependency hint — appears directly
                beneath the failing run's own output, never replaces or
                alters it. Reuses the exact M43 ide-install event; Output's
                own install effect owns everything after the click. */}
            {missingDependencyHint && (
              <div
                className="output-missing-dependency-hint"
                style={{ padding: "6px 0 2px" }}
              >
                <button
                  type="button"
                  className="glass-btn glass-btn-primary"
                  onClick={handleInstallHintClick}
                  disabled={isInstalling}
                  style={{ fontSize: "11px", padding: "4px 10px" }}
                  title={`Missing ${missingDependencyHint.kind === "python" ? "Python package" : "Node module"}: ${missingDependencyHint.moduleName}`}
                >
                  <IconDownload size={12} />
                  <span>Install Dependencies</span>
                </button>
              </div>
            )}
            <div ref={logsEndRef} />
          </div>

          {/* Interactive Stdin Form */}
          {isRunning && (
            <form className="output-stdin-form" onSubmit={handleInputSubmit}>
              <span className="stdin-prompt">&gt;</span>
              <input
                className="stdin-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type standard input and press Enter..."
                autoFocus
              />
              <button
                type="submit"
                className="glass-btn"
                style={{ padding: "2px 8px", fontSize: "11px" }}
              >
                Send
              </button>
            </form>
          )}
        </div>
      )}

      {/* Tab 2: Execution / Job History */}
      {activeTab === "history" && (
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px" }}>
          {loadingRuns ? (
            <div
              style={{
                padding: "20px",
                textAlign: "center",
                color: "var(--fg-muted)",
              }}
            >
              Loading history...
            </div>
          ) : runs.length === 0 ? (
            <div
              style={{
                padding: "24px",
                textAlign: "center",
                color: "var(--fg-muted)",
                fontStyle: "italic",
              }}
            >
              No execution records found. Run a file to record job telemetry!
            </div>
          ) : (
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "var(--text-xs)",
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: "1px solid var(--glass-border)",
                    color: "var(--fg-muted)",
                    textAlign: "left",
                  }}
                >
                  <th style={{ padding: "6px 8px" }}>File / Language</th>
                  <th style={{ padding: "6px 8px" }}>Status</th>
                  <th style={{ padding: "6px 8px" }}>Duration</th>
                  <th style={{ padding: "6px 8px" }}>Peak RAM</th>
                  <th style={{ padding: "6px 8px" }}>Exit Code</th>
                  <th style={{ padding: "6px 8px" }}>Timestamp</th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>
                    Profile
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const peakMb = r.peak_memory_bytes
                    ? `${(r.peak_memory_bytes / (1024 * 1024)).toFixed(1)} MB`
                    : "-";
                  return (
                    <tr
                      key={r.id}
                      style={{
                        borderBottom: "1px solid rgba(255,255,255,0.03)",
                      }}
                    >
                      <td
                        style={{
                          padding: "8px",
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                        }}
                      >
                        {getLanguageIcon(r.file_path, 13)}
                        <span>{r.file_path}</span>
                        <span
                          className="glass-badge"
                          style={{ fontSize: "9px", padding: "0 4px" }}
                        >
                          {r.language}
                        </span>
                      </td>
                      <td style={{ padding: "8px" }}>
                        <span
                          className={`glass-badge glass-badge-${r.status === "success" ? "success" : "error"}`}
                          style={{ fontSize: "10px" }}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td
                        style={{ padding: "8px", color: "var(--fg-secondary)" }}
                      >
                        {r.duration_ms} ms
                      </td>
                      <td
                        style={{
                          padding: "8px",
                          color: "#a6e3a1",
                          fontWeight: 600,
                        }}
                      >
                        {peakMb}
                      </td>
                      <td
                        style={{
                          padding: "8px",
                          color:
                            r.exit_code === 0
                              ? "var(--accent-green)"
                              : "var(--accent-red)",
                        }}
                      >
                        {r.exit_code ?? "-"}
                      </td>
                      <td style={{ padding: "8px", color: "var(--fg-muted)" }}>
                        {new Date(r.created_at).toLocaleTimeString()}
                      </td>
                      <td style={{ padding: "8px", textAlign: "right" }}>
                        <button
                          className="glass-btn glass-btn-ghost"
                          onClick={() => setSelectedRunForTelemetry(r)}
                          style={{ fontSize: "10.5px", padding: "2px 7px" }}
                          title="View Execution Resource Profile & Time Series"
                        >
                          Graph
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Tab 3: Workspace Snapshots */}
      {activeTab === "snapshots" && (
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px" }}>
          {loadingSnapshots ? (
            <div
              style={{
                padding: "20px",
                textAlign: "center",
                color: "var(--fg-muted)",
              }}
            >
              Loading snapshots...
            </div>
          ) : snapshots.length === 0 ? (
            <div
              style={{
                padding: "24px",
                textAlign: "center",
                color: "var(--fg-muted)",
                fontStyle: "italic",
              }}
            >
              No snapshots created yet. Create a snapshot to preserve this
              workspace state!
            </div>
          ) : (
            <div
              style={{ display: "flex", flexDirection: "column", gap: "8px" }}
            >
              {snapshots.map((s) => (
                <div
                  key={s.id}
                  className="glass-card"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "8px 12px",
                    borderRadius: "var(--radius-sm)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "2px",
                    }}
                  >
                    <span
                      style={{ fontWeight: 600, color: "var(--fg-primary)" }}
                    >
                      {s.name}
                    </span>
                    <span
                      style={{ fontSize: "10px", color: "var(--fg-muted)" }}
                    >
                      Size: {Math.round(s.size_bytes / 1024)} KB • Created:{" "}
                      {new Date(s.created_at).toLocaleString()}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <button
                      className="glass-btn glass-btn-primary"
                      style={{ fontSize: "11px", padding: "3px 8px" }}
                      onClick={() =>
                        setModalState({ type: "restore_snapshot", snapshot: s })
                      }
                    >
                      Restore
                    </button>
                    <button
                      className="glass-btn glass-btn-icon"
                      style={{ color: "var(--accent-red)" }}
                      onClick={() =>
                        setModalState({ type: "delete_snapshot", snapshot: s })
                      }
                      title="Delete Snapshot"
                    >
                      <IconTrash size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Snapshot Modals */}
      <PromptModal
        isOpen={modalState.type === "new_snapshot"}
        title="Create Workspace Snapshot"
        placeholder="e.g. Before Refactoring"
        confirmLabel="Save Snapshot"
        onConfirm={handleCreateSnapshot}
        onCancel={() => setModalState({ type: null })}
      />

      <ConfirmModal
        isOpen={modalState.type === "restore_snapshot"}
        title="Restore Workspace"
        message={`Are you sure you want to restore "${modalState.snapshot?.name}"? Current workspace files will be overwritten with the snapshot state.`}
        confirmLabel="Restore Snapshot"
        isDestructive={false}
        onConfirm={handleRestoreSnapshot}
        onCancel={() => setModalState({ type: null })}
      />

      <ConfirmModal
        isOpen={modalState.type === "delete_snapshot"}
        title="Delete Snapshot"
        message={`Are you sure you want to delete snapshot "${modalState.snapshot?.name}"?`}
        confirmLabel="Delete"
        isDestructive={true}
        onConfirm={handleDeleteSnapshot}
        onCancel={() => setModalState({ type: null })}
      />

      {/* Execution Resource Inspector Modal */}
      {selectedRunForTelemetry && (
        <Suspense fallback={null}>
          <ExecutionTelemetryModal
            isOpen={!!selectedRunForTelemetry}
            onClose={() => setSelectedRunForTelemetry(null)}
            projectId={project?.id}
            run={selectedRunForTelemetry}
          />
        </Suspense>
      )}
    </div>
  );
}
