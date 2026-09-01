import React from "react";
import type { CommentThreadDTO } from "../../types";

export interface CommentsPanelProps {
  activeFile: string | null;
  threads: CommentThreadDTO[];
  unresolved: CommentThreadDTO[];
  showResolved: boolean;
  onToggleResolved: (v: boolean) => void;
  onNavigate: (thread: CommentThreadDTO) => void;
}

function relFile(p: string): string {
  return p.split("/").pop() || p;
}

function ThreadRow({
  thread,
  onNavigate,
}: {
  thread: CommentThreadDTO;
  onNavigate: (t: CommentThreadDTO) => void;
}) {
  const replies = thread.replies.filter((c) => c.deletedAt == null).length;
  return (
    <li className="comments-panel-row">
      <button
        type="button"
        className="comments-panel-rowbtn"
        onClick={() => onNavigate(thread)}
      >
        <span className="comments-panel-loc">
          {relFile(thread.filePath)} L{thread.anchor.startLine}
        </span>
        <span className="comments-panel-preview">
          {(thread.root.body || "(comment)").split("\n")[0].slice(0, 80)}
        </span>
        <span className="comments-panel-meta">
          {replies > 0 ? `${replies} repl${replies === 1 ? "y" : "ies"}` : ""}
          {thread.anchorStatus === "stale" ? " · ⚠ moved" : ""}
        </span>
      </button>
    </li>
  );
}

/**
 * M61-A: a section inside the existing right-rail collaborative area (sibling
 * to TeamPanel) — NOT a new floating window. Shows the active file's threads
 * plus a project-wide unresolved roll-up. Navigation always goes through the
 * open-then-reveal primitive (`onNavigate`).
 */
export default function CommentsPanel({
  activeFile,
  threads,
  unresolved,
  showResolved,
  onToggleResolved,
  onNavigate,
}: CommentsPanelProps) {
  const fileActive = threads.filter((t) => t.resolvedAt == null);
  const fileResolved = threads.filter((t) => t.resolvedAt != null);

  return (
    <section className="comments-panel" aria-label="Comments">
      <header className="comments-panel-head">
        <h3>Comments</h3>
        <span className="comments-panel-count" aria-label="Unresolved comments">
          {unresolved.length} unresolved
        </span>
      </header>

      <div className="comments-panel-group">
        <h4>
          {activeFile ? relFile(activeFile) : "No file open"}
          {" · "}
          {fileActive.length} open
        </h4>
        {fileActive.length === 0 && (
          <p className="comments-panel-empty">No comments in this file.</p>
        )}
        <ul>
          {fileActive.map((t) => (
            <ThreadRow key={t.id} thread={t} onNavigate={onNavigate} />
          ))}
        </ul>
        {fileResolved.length > 0 && (
          <>
            <button
              type="button"
              className="comments-panel-toggle"
              aria-expanded={showResolved}
              onClick={() => onToggleResolved(!showResolved)}
            >
              Resolved ({fileResolved.length})
            </button>
            {showResolved && (
              <ul>
                {fileResolved.map((t) => (
                  <ThreadRow key={t.id} thread={t} onNavigate={onNavigate} />
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {unresolved.length > 0 && (
        <div className="comments-panel-group">
          <h4>Unresolved across project ({unresolved.length})</h4>
          <ul>
            {unresolved.slice(0, 20).map((t) => (
              <ThreadRow key={t.id} thread={t} onNavigate={onNavigate} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
