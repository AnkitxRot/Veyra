import React from "react";
import { getLanguageInfo } from "../../utils/language";
import { IS_MAC } from "../../hooks/useKeyboardShortcuts";
import {
  IconPlay,
  IconStop,
  IconLayers,
  IconChevronRight,
  IconActivity,
  IconShield,
  IconDownload,
} from "../common/Icons";
import { getLanguageIcon } from "../common/iconUtils";
import { Project, ContainerStats, User, RunStatusEntry } from "../../types";
import CollaboratorAvatarStack from "../Collab/CollaboratorAvatarStack";
import type {
  CollaboratorPresence,
  CollabConnectionStatus,
} from "../../collab/client";
import type { AttentionEvent } from "../../collab/attention";
import type { LspStatus } from "../../lsp/types";
import { PYTHON_LSP, TYPESCRIPT_LSP } from "../../lsp/languages";
import { canDebugPath } from "../../debug/languages";
import { useOptionalDebugSession } from "../../hooks/useDebugger";

interface ToolbarProps {
  project: Project | null;
  activeFile: string | null;
  capabilities: any;
  stats?: ContainerStats | null;
  user?: User;
  onSwitchToAdmin?: () => void;
  onOpenQuickOpen?: () => void;
  onOpenCommandPalette?: () => void;
  onOpenHealthModal?: () => void;
  collaborators?: CollaboratorPresence[];
  runStatuses?: RunStatusEntry[];
  collabStatus?: CollabConnectionStatus;
  isDnd?: boolean;
  followingUserId?: number | null;
  onToggleDnd?: (dnd: boolean) => void;
  onFollowCollaborator?: (c: CollaboratorPresence) => void;
  onJumpToCollaborator?: (c: CollaboratorPresence) => void;
  onOpenShareModal?: () => void;
  onOpenSecretsModal?: () => void;
  onOpenTeamPanel?: () => void;
  /** M58: count of actionable incoming targeted attention requests. */
  incomingRequestCount?: number;
  /** M59: full attention list, threaded to the collaborator popover focus block. */
  attention?: AttentionEvent[];
  /** M82: live language-server statuses for the active project. */
  lspStatuses?: LspStatus[];
}

export default function Toolbar({
  project,
  activeFile,
  capabilities,
  stats,
  user,
  onSwitchToAdmin,
  onOpenQuickOpen,
  onOpenCommandPalette: _onOpenCommandPalette,
  onOpenHealthModal,
  collaborators = [],
  runStatuses = [],
  collabStatus = "disconnected",
  isDnd = false,
  followingUserId = null,
  onToggleDnd,
  onFollowCollaborator,
  onJumpToCollaborator,
  onOpenShareModal,
  onOpenSecretsModal,
  onOpenTeamPanel,
  incomingRequestCount,
  attention = [],
  lspStatuses = [],
}: ToolbarProps) {
  const [isRunning, setIsRunning] = React.useState(false);
  // M43: mirrors the isRunning/run-started/run-stopped pattern above.
  // Output.tsx owns the actual install request/stream and is the single
  // source of truth for when it starts/stops; Toolbar only mirrors that
  // state via document events to drive its own disabled/label logic.
  const [isInstalling, setIsInstalling] = React.useState(false);
  const [isDebugging, setIsDebugging] = React.useState(false);
  const dbg = useOptionalDebugSession();
  // Synchronous (non-React-state) guard against a rapid double-click firing
  // two `ide-install` dispatches before the install-started event round-trip
  // has had a chance to re-render this component with isInstalling=true.
  const installInFlightRef = React.useRef(false);
  React.useEffect(() => {
    const onStart = () => setIsDebugging(true);
    const onStop = () => setIsDebugging(false);
    document.addEventListener("debug-started", onStart);
    document.addEventListener("debug-stopped", onStop);
    return () => {
      document.removeEventListener("debug-started", onStart);
      document.removeEventListener("debug-stopped", onStop);
    };
  }, []);

  React.useEffect(() => {
    const onStart = () => setIsRunning(true);
    const onStop = () => setIsRunning(false);
    document.addEventListener("run-started", onStart);
    document.addEventListener("run-stopped", onStop);
    return () => {
      document.removeEventListener("run-started", onStart);
      document.removeEventListener("run-stopped", onStop);
    };
  }, []);

  React.useEffect(() => {
    const onInstallStart = () => {
      installInFlightRef.current = true;
      setIsInstalling(true);
    };
    const onInstallStop = () => {
      installInFlightRef.current = false;
      setIsInstalling(false);
    };
    document.addEventListener("install-started", onInstallStart);
    document.addEventListener("install-stopped", onInstallStop);
    return () => {
      document.removeEventListener("install-started", onInstallStart);
      document.removeEventListener("install-stopped", onInstallStop);
    };
  }, []);

  const langInfo = getLanguageInfo(activeFile);
  const langDisplay = langInfo.name;
  const runnable = langInfo.runnable;
  const langId = langInfo.id;
  const debugging =
    dbg != null
      ? dbg.state === "starting" ||
        dbg.state === "running" ||
        dbg.state === "paused"
      : isDebugging;
  const isBusy = isRunning || isInstalling || debugging;
  const canDebug = !!project && canDebugPath(activeFile, capabilities);

  const handleDebug = () => {
    if (project && canDebug && !isRunning && !isInstalling && !debugging) {
      document.dispatchEvent(
        new CustomEvent("ide-debug", { detail: { activeFile } }),
      );
    }
  };

  const handleRun = () => {
    if (project && !isBusy && activeFile) {
      document.dispatchEvent(
        new CustomEvent("ide-run", {
          detail: {
            language: langId,
            activeFile,
            langDisplay,
          },
        }),
      );
    }
  };

  const handleStop = () => {
    if (isRunning) {
      document.dispatchEvent(new Event("ide-stop"));
    }
  };

  const handleInstall = () => {
    if (!project || isBusy || installInFlightRef.current) return;
    // Set synchronously, before dispatch — a second click landing before
    // React re-renders with isInstalling=true must still be rejected here.
    installInFlightRef.current = true;
    document.dispatchEvent(new Event("ide-install"));
  };

  let toolchainAvailable = true;
  let notRunnableTitle = activeFile
    ? `Files of type ${langDisplay} cannot be executed directly.`
    : "Open a file to run";

  if (runnable && capabilities) {
    if (!capabilities.docker) {
      toolchainAvailable = false;
      notRunnableTitle =
        "Docker Sandbox unavailable. CloudeeeIDE requires Docker Desktop.";
    } else if (!capabilities.runnerImage) {
      toolchainAvailable = false;
      notRunnableTitle =
        "Runner Image unavailable. Please build cloudeeeide-runner:latest.";
    } else if (langId === "python" && !capabilities.languages.python)
      toolchainAvailable = false;
    else if (langId === "node" && !capabilities.languages.node)
      toolchainAvailable = false;
    else if (langId === "typescript" && !capabilities.languages.typescript)
      toolchainAvailable = false;
    else if (langId === "c" && !capabilities.languages.c)
      toolchainAvailable = false;
    else if (langId === "cpp" && !capabilities.languages.cpp)
      toolchainAvailable = false;
    else if (langId === "java" && !capabilities.languages.java)
      toolchainAvailable = false;

    if (runnable && !toolchainAvailable && notRunnableTitle === "") {
      notRunnableTitle = `Required toolchain for ${langDisplay} is unavailable in runner image.`;
    }
  }

  const runLabel = langDisplay && runnable ? `Run ${langDisplay}` : "Run";
  const canRun = runnable && toolchainAvailable;

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        if (canRun && !isBusy) handleRun();
        else if (isRunning) handleStop();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canRun, isRunning, isBusy, project, activeFile, langId, langDisplay]);

  const memMb = stats ? Math.round(stats.memoryUsageBytes / (1024 * 1024)) : 0;
  const cpuVal = stats ? stats.cpuPercent.toFixed(1) : "0.0";

  return (
    <header className="toolbar" aria-label="Editor Toolbar">
      {/* Breadcrumb Section */}
      <div className="toolbar-breadcrumbs">
        <span className="breadcrumb-project">
          <IconLayers size={14} color="var(--accent)" />
          <span>{project ? project.name : "No Project"}</span>
        </span>
        {activeFile && (
          <>
            <span className="breadcrumb-separator">
              <IconChevronRight size={12} />
            </span>
            <span className="breadcrumb-file">
              {getLanguageIcon(activeFile, 13)}
              <span>{activeFile}</span>
            </span>
          </>
        )}
      </div>

      {/* Center Search / Command Palette Quick Button */}
      {onOpenQuickOpen && (
        <button
          type="button"
          className="toolbar-search-btn"
          onClick={onOpenQuickOpen}
          title="Quick Open File (Ctrl+P / Cmd+P) or Command Palette (Ctrl+Shift+P)"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            background: "rgba(255, 255, 255, 0.04)",
            border: "1px solid var(--glass-border-subtle)",
            borderRadius: "var(--radius-sm)",
            padding: "4px 12px",
            fontSize: "12px",
            color: "var(--fg-muted)",
            cursor: "pointer",
            transition: "all 120ms ease",
          }}
        >
          <span style={{ fontSize: "11px", color: "var(--fg-secondary)" }}>
            Search files or type &gt;
          </span>
          <span
            className="shortcut-hint"
            style={{
              fontSize: "10px",
              padding: "1px 5px",
              fontFamily: "var(--font-mono)",
              background: "rgba(0,0,0,0.3)",
              borderRadius: "3px",
              border: "1px solid var(--glass-border-subtle)",
            }}
          >
            {IS_MAC ? "⌘P" : "Ctrl+P"}
          </span>
        </button>
      )}

      {/* Live Resource Telemetry HUD */}
      {stats && stats.running && (
        <div
          className="capability-hud"
          style={{
            background: "rgba(255, 255, 255, 0.03)",
            border: "1px solid rgba(137, 180, 250, 0.2)",
          }}
          title="Real-Time Container Resource Telemetry (cgroups)"
          role="status"
          aria-live="polite"
        >
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: "5px",
              fontSize: "11px",
              color: "var(--fg-secondary)",
            }}
          >
            <IconActivity size={12} color="var(--accent)" />
            <span>
              CPU: <strong>{cpuVal}%</strong>
            </span>
          </span>

          <span style={{ color: "var(--glass-border-light)" }}>|</span>

          <span style={{ fontSize: "11px", color: "var(--fg-secondary)" }}>
            RAM: <strong>{memMb}MB</strong>{" "}
            <span style={{ opacity: 0.6 }}>/ 512MB</span>
          </span>

          {stats.pids > 0 && (
            <>
              <span style={{ color: "var(--glass-border-light)" }}>|</span>
              <span style={{ fontSize: "11px", color: "var(--fg-muted)" }}>
                PIDs: <strong>{stats.pids}</strong>
              </span>
            </>
          )}
        </div>
      )}

      {/* Capability Environment Capsule */}
      {capabilities && !stats?.running && (
        <div className="capability-hud" title="Docker Sandbox Capability HUD">
          <span
            style={{
              fontWeight: 600,
              color: "var(--fg-secondary)",
              display: "flex",
              alignItems: "center",
              gap: "4px",
            }}
          >
            <span>Docker</span>
            <span
              className={`capability-dot ${capabilities.docker && capabilities.runnerImage ? "ready" : "error"}`}
            />
          </span>

          <span style={{ color: "var(--glass-border-light)" }}>|</span>

          <span
            className={`capability-chip ${capabilities.languages.python ? "ready" : "error"}`}
            title="Python 3.11"
          >
            <span
              className={`capability-dot ${capabilities.languages.python ? "ready" : "error"}`}
            />
            Py
          </span>

          <span
            className={`capability-chip ${capabilities.languages.node ? "ready" : "error"}`}
            title="Node.js & TS"
          >
            <span
              className={`capability-dot ${capabilities.languages.node ? "ready" : "error"}`}
            />
            Node
          </span>

          <span
            className={`capability-chip ${capabilities.languages.c ? "ready" : "error"}`}
            title="GCC C/C++"
          >
            <span
              className={`capability-dot ${capabilities.languages.c ? "ready" : "error"}`}
            />
            GCC
          </span>

          <span
            className={`capability-chip ${capabilities.languages.java ? "ready" : "error"}`}
            title="OpenJDK Java"
          >
            <span
              className={`capability-dot ${capabilities.languages.java ? "ready" : "error"}`}
            />
            Java
          </span>
        </div>
      )}

      {lspStatuses
        .filter((s) => s.state !== "stopped")
        .map((lspStatus) => {
          const spec =
            lspStatus.language === "typescript"
              ? TYPESCRIPT_LSP
              : PYTHON_LSP;
          const ready = lspStatus.state === "ready";
          const pending =
            lspStatus.state === "starting" || lspStatus.state === "restarting";
          return (
            <span
              key={lspStatus.language}
              data-testid={`lsp-chip-${lspStatus.language}`}
              className={`capability-chip ${
                ready ? "ready" : pending ? "" : "error"
              }`}
              title={
                lspStatus.message ||
                (ready
                  ? `${spec.chipLabel} ready`
                  : pending
                    ? `${spec.chipLabel} starting`
                    : `${spec.chipLabel} unavailable — editing still works`)
              }
            >
              <span
                className={`capability-dot ${
                  ready ? "ready" : pending ? "" : "error"
                }`}
              />
              {spec.chipLabel}
            </span>
          );
        })}

      {/* Real-Time Multiplayer Collaborator Presence */}
      {project && user && (
        <CollaboratorAvatarStack
          collaborators={collaborators}
          runStatuses={runStatuses}
          status={collabStatus}
          currentUserId={user.id}
          isDnd={isDnd}
          followingUserId={followingUserId}
          onToggleDnd={onToggleDnd}
          onFollowCollaborator={onFollowCollaborator}
          onJumpToCollaborator={onJumpToCollaborator}
          onOpenShareModal={onOpenShareModal}
          onOpenTeamPanel={onOpenTeamPanel}
          incomingRequestCount={incomingRequestCount}
          attention={attention}
        />
      )}

      {/* Project Secrets & Environment Variables Trigger (owner only) */}
      {onOpenSecretsModal && (
        <button
          className="glass-btn"
          onClick={onOpenSecretsModal}
          style={{
            padding: "5px 10px",
            fontSize: "11px",
            background: "rgba(203, 166, 247, 0.1)",
            color: "#cba6f7",
            border: "1px solid rgba(203, 166, 247, 0.3)",
            display: "flex",
            alignItems: "center",
            gap: "5px",
          }}
          title="Manage environment variables & secrets"
        >
          <IconShield size={12} />
          <span>Secrets</span>
        </button>
      )}

      {/* Project Health Center Trigger */}
      {onOpenHealthModal && (
        <button
          className="glass-btn"
          onClick={onOpenHealthModal}
          style={{
            padding: "5px 10px",
            fontSize: "11px",
            background: "rgba(166, 227, 161, 0.1)",
            color: "#a6e3a1",
            border: "1px solid rgba(166, 227, 161, 0.3)",
            display: "flex",
            alignItems: "center",
            gap: "5px",
          }}
          title="Open Project Health Center"
        >
          <IconActivity size={12} />
          <span>Health</span>
        </button>
      )}

      {/* Admin Control Plane Switcher */}
      {user?.role === "admin" && onSwitchToAdmin && (
        <button
          className="glass-btn"
          onClick={onSwitchToAdmin}
          style={{
            padding: "5px 12px",
            fontSize: "11px",
            background: "rgba(243, 139, 168, 0.15)",
            color: "#f38ba8",
            border: "1px solid rgba(243, 139, 168, 0.35)",
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: "6px",
          }}
          title="Open Admin Control Plane Dashboard"
        >
          <IconShield size={12} />
          <span>Control Plane</span>
        </button>
      )}

      {/* Action Controls */}
      <div className="toolbar-actions">
        <button
          className="glass-btn"
          onClick={handleInstall}
          disabled={!project || isBusy}
          title={
            isInstalling
              ? "Installing dependencies…"
              : "Install project dependencies (requirements.txt / package.json)"
          }
        >
          <IconDownload size={12} />
          <span>{isInstalling ? "Installing…" : "Install"}</span>
        </button>

        <button
          type="button"
          className="glass-btn"
          data-testid="debug-start"
          onClick={handleDebug}
          disabled={!canDebug || isRunning || isInstalling || debugging}
          title={
            debugging
              ? "Debugger is active — use the Debug panel to control it"
              : canDebug
                ? "Debug current file"
                : "Open a Python or Node/TypeScript file to debug"
          }
        >
          <span>Debug</span>
        </button>

        {isRunning ? (
          <button
            className="glass-btn btn-stop"
            onClick={handleStop}
            title="Stop Execution (Ctrl+Enter)"
          >
            <IconStop size={12} />
            <span>Stop</span>
            <span className="shortcut-hint">{IS_MAC ? "⌘↵" : "Ctrl+↵"}</span>
          </button>
        ) : (
          <button
            className="glass-btn btn-run"
            onClick={handleRun}
            disabled={!canRun || isInstalling || debugging}
            title={
              debugging
                ? "Debugger is active — stop it before running"
                : isInstalling
                ? "Install in progress — run is unavailable until it finishes"
                : canRun
                  ? `${runLabel} (Ctrl+Enter)`
                  : notRunnableTitle
            }
          >
            <IconPlay size={12} />
            <span>{runLabel}</span>
            <span className="shortcut-hint">{IS_MAC ? "⌘↵" : "Ctrl+↵"}</span>
          </button>
        )}
      </div>
    </header>
  );
}
