import React from "react";
import type { RunStatusEntry, SharedRunOutput } from "../../types";
import { IconCheck, IconClose } from "../common/Icons";

/**
 * M65 — read-only view of another collaborator's run output, shown inside the
 * Output console. The lifecycle (buffer, 256 KB bound, truncation, teardown)
 * is owned by CollaborationClient; this is presentation only. No stdin, no
 * stop — a viewer/observer never controls someone else's process.
 */
export interface SharedRunOutputPanelProps {
  output: SharedRunOutput;
  /** The matching M54 run-status entry, if it has not lingered out yet. */
  status?: RunStatusEntry;
  /** Whether the collaboration link is currently up. */
  connected: boolean;
}

type Phase = "running" | "completed" | "failed" | "stopped";

function phaseOf(status: RunStatusEntry | undefined): Phase {
  if (!status) return "completed";
  if (status.state === "running") return "running";
  if (status.state === "success") return "completed";
  if (status.state === "stopped") return "stopped";
  return "failed";
}

const PHASE_LABEL: Record<Phase, string> = {
  running: "running",
  completed: "completed",
  failed: "failed",
  stopped: "stopped",
};

const PHASE_BADGE: Record<Phase, string> = {
  running: "accent",
  completed: "success",
  failed: "error",
  stopped: "warning",
};

export default function SharedRunOutputPanel({
  output,
  status,
  connected,
}: SharedRunOutputPanelProps) {
  const phase = phaseOf(status);
  const who = status?.username?.trim() || "A collaborator";
  const file = status?.file ?? null;

  return (
    <div className="shared-run-output" data-testid="shared-run-output">
      <div className="shared-run-output-header">
        <span
          className={`glass-badge glass-badge-${PHASE_BADGE[phase]}`}
          style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          {phase === "running" && <span className="capability-dot ready" />}
          {phase === "completed" && <IconCheck size={10} />}
          {phase === "failed" && <IconClose size={10} />}
          <span>{PHASE_LABEL[phase]}</span>
        </span>
        <span className="shared-run-output-title">
          {who} {phase === "running" ? "is running" : "ran"}
          {file ? ` ${file}` : ""}
        </span>
      </div>

      {!connected && (
        <div
          className="shared-run-output-notice"
          role="status"
          style={{ color: "var(--fg-muted)", fontStyle: "italic", padding: "4px 0" }}
        >
          Output unavailable — reconnecting to collaboration…
        </div>
      )}

      {output.truncated && (
        <div
          className="shared-run-output-truncated"
          style={{ color: "var(--fg-muted)", fontStyle: "italic" }}
        >
          … earlier output truncated
        </div>
      )}

      <div className="shared-run-output-body output-log-container">
        {output.chunks.map((c, i) => (
          <span key={i} className={`log-line log-${c.stream}`}>
            {c.data}
          </span>
        ))}
      </div>
    </div>
  );
}
