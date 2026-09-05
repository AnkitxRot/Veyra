import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  Suspense,
} from "react";
import { api } from "../../api";
import {
  IconTrash,
  IconCheck,
  IconClose,
  IconRefresh,
  IconDownload,
} from "../common/Icons";
import { getLanguageIcon } from "../common/iconUtils";
import {
  RunRecord,
  RunStatusEntry,
  SharedRunOutput,
  SnapshotRecord,
} from "../../types";
import { PromptModal, ConfirmModal } from "../common/Modal";
import { useExecutionSession } from "../../hooks/useExecutionSession";
import { bulkConflictSummary } from "../../utils/collabConflict";
import SharedRunOutputPanel from "./SharedRunOutputPanel";
const ExecutionTelemetryModal = React.lazy(
  () => import("./ExecutionTelemetryModal"),
);

export interface OutputProps {
  project: any;
  onRefreshTree?: () => void;
  /** M65: other collaborators' bounded, read-only run output (owner/editor). */
  sharedRunOutputs?: SharedRunOutput[];
  runStatuses?: RunStatusEntry[];
  currentUserId?: number;
  collabConnected?: boolean;
}

export default function Output({
  project,
  onRefreshTree,
  sharedRunOutputs = [],
  runStatuses = [],
  currentUserId,
  collabConnected = false,
}: OutputProps) {
  const [activeTab, setActiveTab] = useState<
    "console" | "history" | "snapshots"
  >("console");
  const logsEndRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");

  // M53: the run/install lifecycle, its WebSocket, log buffer and status all
  // live in the project-scoped ExecutionSessionProvider now — this component is
  // a pure view of it. Unmounting Output (bottom-tab switch / collapse) no
  // longer closes the socket or kills the running program.
  const {
    logs,
    status: statusBadge,
    isRunning,
    isInstalling,
    missingDependencyHint,
    sendStdin,
    clearLogs,
  } = useExecutionSession();

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

  // M65: another collaborator's run output — shown read-only above the local
  // console. Never your own run (you see that live), and only when a matching
  // run status confirms who is (was) running.
  const foreignRunOutputs = sharedRunOutputs
    .map((o) => ({
      output: o,
      status: runStatuses.find((s) => s.executionId === o.executionId),
    }))
    .filter(
      ({ status }) => status != null && status.userId !== currentUserId,
    );

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

  // A finished run records a new row in history — refresh the History tab if
  // it is the one being viewed. (The run lifecycle itself is owned by the
  // execution session; this component just reacts to its completion event.)
  useEffect(() => {
    const onRunStopped = () => {
      if (activeTab === "history") loadRuns();
    };
    document.addEventListener("run-stopped", onRunStopped);
    return () => document.removeEventListener("run-stopped", onRunStopped);
  }, [activeTab, loadRuns]);

  // M44: the inline missing-dependency hint dispatches the exact same event
  // Toolbar's own Install button does — IDE's ide-install listener switches
  // bottomTab back to "output" and re-dispatches ide-install-confirmed, which
  // the execution session owns. This never duplicates any part of that flow.
  const handleInstallHintClick = () => {
    document.dispatchEvent(new Event("ide-install"));
  };

  const handleInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input) {
      sendStdin(input + "\n");
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
      const res = await api<{ ok: true; conflictedPaths?: string[] }>(
        `/api/projects/${project.id}/snapshots/${modalState.snapshot.id}/restore`,
        {
          method: "POST",
        },
      );
      if (onRefreshTree) onRefreshTree();
      const conflictNote = bulkConflictSummary(
        res.conflictedPaths,
        "Snapshot restore",
      );
      alert(conflictNote ?? "Snapshot restored successfully!");
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
              onClick={() => clearLogs()}
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
          {foreignRunOutputs.length > 0 && (
            <div className="shared-run-output-list">
              {foreignRunOutputs.map(({ output, status }) => (
                <SharedRunOutputPanel
                  key={output.executionId}
                  output={output}
                  status={status}
                  connected={collabConnected}
                />
              ))}
            </div>
          )}

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
                alters it. Reuses the exact M43 ide-install event; the
                execution session owns everything after the click. */}
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
