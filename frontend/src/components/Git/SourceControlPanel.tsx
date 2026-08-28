import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import {
  Project,
  GitStatus,
  GitFileEntry,
  GitFileDiff,
  GitCommit,
  GitBranch,
} from "../../types";
import { ConfirmModal } from "../common/Modal";
import {
  IconGitBranch,
  IconGitCommit,
  IconRefresh,
  IconPlus,
  IconChevronDown,
  IconChevronRight,
  IconCheck,
  IconTrash,
  IconAlertTriangle,
} from "../common/Icons";
import CollaboratorImpactNotice, {
  type CollaboratorImpact,
} from "../Collab/CollaboratorImpactNotice";

export interface SourceControlPanelProps {
  project: Project | null;
  projectRole: "owner" | "editor" | "viewer";
  /** Returns the workspace-relative paths of editor buffers with unsaved
   *  changes — used to preflight branch checkout. */
  getDirtyOpenPaths: () => string[];
  /** Reconcile already-open editor buffers after files changed on disk
   *  (branch checkout). Same reconciliation IDE.tsx uses for Replace All. */
  onReconcileBuffers: (
    changedPaths: string[],
    opts: { noticeLabel: string; authoritative?: boolean },
  ) => void;
  /** Report the current branch / init state up to IDE (status-bar badge). */
  onGitState?: (state: { initialized: boolean; branch: string | null }) => void;
}

function statusGlyph(e: GitFileEntry): {
  glyph: string;
  label: string;
  color: string;
} {
  const c = e.staged ? e.index : e.worktree;
  if (e.untracked) return { glyph: "U", label: "untracked", color: "#a6e3a1" };
  switch (c) {
    case "M":
      return { glyph: "M", label: "modified", color: "#f9e2af" };
    case "A":
      return { glyph: "A", label: "added", color: "#a6e3a1" };
    case "D":
      return { glyph: "D", label: "deleted", color: "#f38ba8" };
    case "R":
      return { glyph: "R", label: "renamed", color: "#89b4fa" };
    case "C":
      return { glyph: "C", label: "copied", color: "#89b4fa" };
    default:
      return { glyph: c || "?", label: "changed", color: "var(--fg-muted)" };
  }
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function SourceControlPanel({
  project,
  projectRole,
  getDirtyOpenPaths,
  onReconcileBuffers,
  onGitState,
}: SourceControlPanelProps) {
  const canWrite = projectRole !== "viewer";
  const projectId = project?.id ?? null;

  const [status, setStatus] = useState<GitStatus | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [branchInfo, setBranchInfo] = useState<{
    current: string | null;
    branches: GitBranch[];
  } | null>(null);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [commitMessage, setCommitMessage] = useState("");
  const [selected, setSelected] = useState<{
    path: string;
    staged: boolean;
  } | null>(null);
  const [fileDiff, setFileDiff] = useState<GitFileDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const [showHistory, setShowHistory] = useState(true);
  const [showBranches, setShowBranches] = useState(false);
  const [branchSearch, setBranchSearch] = useState("");
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    branch: string;
    blockingPaths: string[];
  } | null>(null);
  // M56: another collaborator has KNOWN-unsaved changes in a file this
  // checkout would overwrite. Requires explicit confirmation to proceed.
  const [collabConflict, setCollabConflict] = useState<{
    branch: string;
    impacts: CollaboratorImpact[];
  } | null>(null);

  // Project-switch isolation: a stale in-flight refresh must never paint
  // another project's repository state.
  const genRef = useRef(0);

  const flashToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 4000);
  };

  const refreshAll = useCallback(async () => {
    if (!projectId) return;
    const gen = ++genRef.current;
    setLoading(true);
    setError(null);
    try {
      const st = await api<GitStatus>(`/api/projects/${projectId}/git/status`);
      if (gen !== genRef.current) return;
      setStatus(st);
      onGitState?.({ initialized: st.initialized, branch: st.branch });
      if (st.initialized) {
        const [log, br] = await Promise.all([
          api<{ commits: GitCommit[] }>(
            `/api/projects/${projectId}/git/log?limit=50`,
          ),
          api<{ current: string | null; branches: GitBranch[] }>(
            `/api/projects/${projectId}/git/branches`,
          ),
        ]);
        if (gen !== genRef.current) return;
        setCommits(log.commits);
        setBranchInfo(br);
      } else {
        setCommits([]);
        setBranchInfo(null);
      }
    } catch (err: any) {
      if (gen !== genRef.current) return;
      setError(err?.message || "Failed to load Git status");
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, [projectId, onGitState]);

  // Reset + load on project change.
  useEffect(() => {
    genRef.current++;
    setStatus(null);
    setCommits([]);
    setBranchInfo(null);
    setSelected(null);
    setFileDiff(null);
    setCommitMessage("");
    setConflict(null);
    setCollabConflict(null);
    setError(null);
    setToast(null);
    if (projectId) void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const loadFileDiff = useCallback(
    async (path: string, staged: boolean) => {
      if (!projectId) return;
      const gen = genRef.current;
      setSelected({ path, staged });
      setDiffLoading(true);
      setFileDiff(null);
      try {
        const fd = await api<GitFileDiff>(
          `/api/projects/${projectId}/git/diff/file?path=${encodeURIComponent(
            path,
          )}&staged=${staged ? "true" : "false"}`,
        );
        if (gen === genRef.current) setFileDiff(fd);
      } catch (err: any) {
        if (gen === genRef.current)
          setError(err?.message || "Failed to load diff");
      } finally {
        if (gen === genRef.current) setDiffLoading(false);
      }
    },
    [projectId],
  );

  const mutate = useCallback(
    async (fn: () => Promise<void>) => {
      if (!projectId || busy) return;
      setBusy(true);
      setError(null);
      try {
        await fn();
        await refreshAll();
      } catch (err: any) {
        setError(err?.message || "Git operation failed");
      } finally {
        setBusy(false);
      }
    },
    [projectId, busy, refreshAll],
  );

  const doInit = () =>
    mutate(async () => {
      await api(`/api/projects/${projectId}/git/init`, { method: "POST" });
      flashToast("Repository initialized");
    });

  const stageOne = (path: string) =>
    mutate(async () => {
      await api(`/api/projects/${projectId}/git/stage`, {
        method: "POST",
        body: JSON.stringify({ paths: [path] }),
      });
    });
  const unstageOne = (path: string) =>
    mutate(async () => {
      await api(`/api/projects/${projectId}/git/unstage`, {
        method: "POST",
        body: JSON.stringify({ paths: [path] }),
      });
    });
  const stageAll = () =>
    mutate(async () => {
      await api(`/api/projects/${projectId}/git/stage`, {
        method: "POST",
        body: JSON.stringify({ all: true }),
      });
    });
  const unstageAll = () =>
    mutate(async () => {
      await api(`/api/projects/${projectId}/git/unstage`, {
        method: "POST",
        body: JSON.stringify({ all: true }),
      });
    });

  const doCommit = () =>
    mutate(async () => {
      const msg = commitMessage.trim();
      if (!msg) return;
      const res = await api<{ shortHash: string }>(
        `/api/projects/${projectId}/git/commit`,
        { method: "POST", body: JSON.stringify({ message: msg }) },
      );
      setCommitMessage("");
      setSelected(null);
      setFileDiff(null);
      flashToast(`Committed ${res.shortHash}`);
    });

  const createBranch = (name: string) =>
    mutate(async () => {
      await api(`/api/projects/${projectId}/git/branches`, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setNewBranchOpen(false);
      setNewBranchName("");
      flashToast(`Branch "${name}" created`);
    });

  const checkout = useCallback(
    async (name: string, force = false) => {
      if (!projectId || busy) return;
      setBusy(true);
      setError(null);
      setConflict(null);
      if (!force) setCollabConflict(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/git/checkout`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            dirtyOpenPaths: getDirtyOpenPaths(),
            ...(force ? { force: true } : {}),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 409 && Array.isArray(data.blockingPaths)) {
          setConflict({ branch: name, blockingPaths: data.blockingPaths });
          return;
        }
        if (
          res.status === 409 &&
          data?.error?.code === "collaborator_dirty_conflict"
        ) {
          setCollabConflict({
            branch: name,
            impacts: Array.isArray(data.collaboratorImpacts)
              ? data.collaboratorImpacts
              : [],
          });
          return;
        }
        if (!res.ok) {
          throw new Error(data?.error?.message || "Checkout failed");
        }
        setCollabConflict(null);
        if (Array.isArray(data.changedPaths) && data.changedPaths.length > 0) {
          onReconcileBuffers(data.changedPaths, {
            noticeLabel: "Branch checkout",
            authoritative: true,
          });
        }
        flashToast(`Switched to "${data.branch}"`);
        setSelected(null);
        setFileDiff(null);
        await refreshAll();
      } catch (err: any) {
        setError(err?.message || "Checkout failed");
      } finally {
        setBusy(false);
      }
    },
    [projectId, busy, getDirtyOpenPaths, onReconcileBuffers, refreshAll],
  );

  const deleteBranch = (name: string) =>
    mutate(async () => {
      await api(
        `/api/projects/${projectId}/git/branches/${encodeURIComponent(name)}`,
        {
          method: "DELETE",
        },
      );
      setDeleteTarget(null);
      flashToast(`Branch "${name}" deleted`);
    });

  // ---- render ----------------------------------------------------------

  if (!project) {
    return (
      <div
        className="panel-content"
        style={{ padding: 16, color: "var(--fg-muted)" }}
      >
        No project open.
      </div>
    );
  }

  const filteredBranches = (branchInfo?.branches ?? []).filter((b) =>
    b.name.toLowerCase().includes(branchSearch.trim().toLowerCase()),
  );

  return (
    <div
      className="panel-content"
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderBottom: "1px solid var(--glass-border-subtle)",
          flexShrink: 0,
        }}
      >
        <IconGitBranch size={13} color="var(--accent)" />
        <span style={{ fontWeight: 600, fontSize: 12 }}>Source Control</span>
        {status?.initialized && (
          <span
            className="glass-badge glass-badge-info"
            style={{ fontSize: 10, padding: "1px 7px" }}
            title="current branch"
          >
            {status.detached ? "detached @ " : ""}
            {status.branch ?? "—"}
          </span>
        )}
        <button
          type="button"
          className="glass-btn glass-btn-ghost"
          style={{ marginLeft: "auto", fontSize: 11, padding: "2px 7px" }}
          onClick={() => void refreshAll()}
          disabled={loading || busy}
          title="Refresh"
          aria-label="Refresh Source Control"
        >
          <IconRefresh size={11} className={loading ? "spinning" : ""} />{" "}
          Refresh
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px" }}>
        {error && (
          <div
            role="alert"
            style={{
              fontSize: 11,
              color: "#f38ba8",
              border: "1px solid #f38ba8",
              borderRadius: 6,
              padding: "6px 8px",
              marginBottom: 8,
            }}
          >
            {error}
          </div>
        )}

        {toast && (
          <div
            role="status"
            style={{
              fontSize: 11,
              color: "#a6e3a1",
              display: "flex",
              alignItems: "center",
              gap: 5,
              marginBottom: 8,
            }}
          >
            <IconCheck size={11} /> {toast}
          </div>
        )}

        {/* Uninitialized onboarding */}
        {status && !status.initialized && (
          <div style={{ textAlign: "center", padding: "22px 8px" }}>
            <IconGitBranch size={22} color="var(--fg-muted)" />
            <p
              style={{
                fontSize: 12,
                color: "var(--fg-primary)",
                margin: "10px 0 4px",
              }}
            >
              No repository yet
            </p>
            <p
              style={{
                fontSize: 11,
                color: "var(--fg-muted)",
                maxWidth: 320,
                margin: "0 auto 12px",
              }}
            >
              Track changes, create branches, and restore previous versions.
            </p>
            {canWrite ? (
              <button
                type="button"
                className="glass-btn glass-btn-primary"
                onClick={doInit}
                disabled={busy}
                style={{ fontSize: 12 }}
              >
                Initialize Git Repository
              </button>
            ) : (
              <p style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                Ask the project owner or an editor to initialize Git.
              </p>
            )}
          </div>
        )}

        {status?.initialized && (
          <>
            {conflict && (
              <div
                data-testid="git-conflict"
                style={{
                  fontSize: 11,
                  border: "1px solid #fab387",
                  borderRadius: 6,
                  padding: "8px 10px",
                  marginBottom: 10,
                  color: "var(--fg-primary)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <IconAlertTriangle size={12} color="#fab387" />
                  <strong>Cannot switch to "{conflict.branch}"</strong>
                </div>
                <div style={{ marginTop: 4, color: "var(--fg-muted)" }}>
                  Commit or discard uncommitted changes to:{" "}
                  {conflict.blockingPaths.join(", ")}
                </div>
                <button
                  type="button"
                  className="glass-btn glass-btn-ghost"
                  style={{ fontSize: 10, padding: "2px 7px", marginTop: 6 }}
                  onClick={() => setConflict(null)}
                >
                  Dismiss
                </button>
              </div>
            )}

            {collabConflict && (
              <div
                data-testid="git-collab-conflict"
                style={{
                  fontSize: 11,
                  border: "1px solid #fab387",
                  borderRadius: 6,
                  padding: "8px 10px",
                  marginBottom: 10,
                  color: "var(--fg-primary)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <IconAlertTriangle size={12} color="#fab387" />
                  <strong>
                    Another collaborator has unsaved changes on "
                    {collabConflict.branch}"
                  </strong>
                </div>
                <CollaboratorImpactNotice
                  impacts={collabConflict.impacts}
                  heading="Checking out would overwrite files in use:"
                />
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <button
                    type="button"
                    className="glass-btn"
                    style={{ fontSize: 10, padding: "2px 7px" }}
                    disabled={busy}
                    onClick={() => checkout(collabConflict.branch, true)}
                  >
                    Check out anyway
                  </button>
                  <button
                    type="button"
                    className="glass-btn glass-btn-ghost"
                    style={{ fontSize: 10, padding: "2px 7px" }}
                    onClick={() => setCollabConflict(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* CHANGES (unstaged) */}
            <Section
              title="Changes"
              count={status.unstaged.length}
              action={
                canWrite && status.unstaged.length > 0
                  ? { label: "Stage All", onClick: stageAll }
                  : undefined
              }
            >
              {status.unstaged.length === 0 ? (
                <Empty>Working tree clean</Empty>
              ) : (
                status.unstaged.map((e) => (
                  <FileRow
                    key={`u-${e.path}`}
                    entry={e}
                    active={
                      selected?.path === e.path && selected?.staged === false
                    }
                    onSelect={() => loadFileDiff(e.path, false)}
                    onAction={canWrite ? () => stageOne(e.path) : undefined}
                    actionLabel="Stage"
                    actionGlyph="+"
                  />
                ))
              )}
            </Section>

            {/* STAGED */}
            <Section
              title="Staged Changes"
              count={status.staged.length}
              action={
                canWrite && status.staged.length > 0
                  ? { label: "Unstage All", onClick: unstageAll }
                  : undefined
              }
            >
              {status.staged.length === 0 ? (
                <Empty>Nothing staged</Empty>
              ) : (
                status.staged.map((e) => (
                  <FileRow
                    key={`s-${e.path}`}
                    entry={e}
                    active={
                      selected?.path === e.path && selected?.staged === true
                    }
                    onSelect={() => loadFileDiff(e.path, true)}
                    onAction={canWrite ? () => unstageOne(e.path) : undefined}
                    actionLabel="Unstage"
                    actionGlyph="−"
                  />
                ))
              )}
            </Section>

            {/* Selected file diff */}
            {selected && (
              <div
                style={{
                  border: "1px solid var(--glass-border-subtle)",
                  borderRadius: 6,
                  margin: "6px 0 12px",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    padding: "5px 9px",
                    background: "rgba(255,255,255,0.03)",
                    display: "flex",
                    justifyContent: "space-between",
                  }}
                >
                  <span>
                    {selected.path}
                    <span style={{ color: "var(--fg-muted)", fontWeight: 400 }}>
                      {" "}
                      · {selected.staged ? "staged" : "working tree"}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="glass-btn glass-btn-ghost"
                    style={{ fontSize: 10, padding: "1px 6px" }}
                    onClick={() => {
                      setSelected(null);
                      setFileDiff(null);
                    }}
                  >
                    Close
                  </button>
                </div>
                <DiffView diff={fileDiff} loading={diffLoading} />
              </div>
            )}

            {/* COMMIT */}
            {canWrite && (
              <div style={{ margin: "4px 0 14px" }}>
                <label
                  htmlFor="git-commit-message"
                  style={{
                    fontSize: 10,
                    color: "var(--fg-muted)",
                    fontWeight: 600,
                  }}
                >
                  COMMIT MESSAGE
                </label>
                <textarea
                  id="git-commit-message"
                  className="glass-input"
                  value={commitMessage}
                  maxLength={2000}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      (e.metaKey || e.ctrlKey) &&
                      e.key === "Enter" &&
                      commitMessage.trim() &&
                      status.staged.length > 0
                    ) {
                      e.preventDefault();
                      doCommit();
                    }
                  }}
                  placeholder={
                    status.staged.length === 0
                      ? "Stage changes, then describe them"
                      : "Describe your changes"
                  }
                  rows={2}
                  style={{
                    fontSize: 12,
                    width: "100%",
                    resize: "vertical",
                    marginTop: 3,
                  }}
                />
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginTop: 5,
                  }}
                >
                  <button
                    type="button"
                    className="glass-btn glass-btn-primary"
                    disabled={
                      busy ||
                      !commitMessage.trim() ||
                      status.staged.length === 0
                    }
                    onClick={doCommit}
                    style={{ fontSize: 12 }}
                  >
                    <IconGitCommit size={11} /> Commit
                  </button>
                  {status.staged.length === 0 && (
                    <span style={{ fontSize: 10, color: "var(--fg-muted)" }}>
                      Nothing staged to commit
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* HISTORY */}
            <CollapsibleSection
              title="History"
              open={showHistory}
              onToggle={() => setShowHistory((v) => !v)}
            >
              {commits.length === 0 ? (
                <Empty>No commits yet</Empty>
              ) : (
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {commits.map((c) => (
                    <div
                      key={c.hash}
                      style={{
                        padding: "5px 4px",
                        borderTop: "1px solid rgba(255,255,255,0.03)",
                        fontSize: 11,
                      }}
                    >
                      <div style={{ display: "flex", gap: 8 }}>
                        <code style={{ color: "var(--accent)" }}>
                          {c.shortHash}
                        </code>
                        <span
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            color: "var(--fg-primary)",
                          }}
                        >
                          {c.subject}
                        </span>
                      </div>
                      <div style={{ color: "var(--fg-muted)", marginLeft: 2 }}>
                        {c.author} · {timeAgo(c.date)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CollapsibleSection>

            {/* BRANCHES */}
            <CollapsibleSection
              title="Branches"
              count={branchInfo?.branches.length}
              open={showBranches}
              onToggle={() => setShowBranches((v) => !v)}
            >
              {(branchInfo?.branches.length ?? 0) > 6 && (
                <input
                  className="glass-input"
                  placeholder="Filter branches…"
                  value={branchSearch}
                  onChange={(e) => setBranchSearch(e.target.value)}
                  style={{
                    fontSize: 11,
                    padding: "3px 7px",
                    marginBottom: 5,
                    width: "100%",
                  }}
                />
              )}
              <div style={{ display: "flex", flexDirection: "column" }}>
                {filteredBranches.map((b) => (
                  <div
                    key={b.name}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 2px",
                      fontSize: 11,
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        color: b.current ? "#a6e3a1" : "transparent",
                      }}
                    >
                      ●
                    </span>
                    <span
                      style={{
                        flex: 1,
                        color: b.current
                          ? "var(--fg-primary)"
                          : "var(--fg-secondary)",
                        fontWeight: b.current ? 600 : 400,
                      }}
                    >
                      {b.name}
                      {b.current && (
                        <span
                          className="glass-badge glass-badge-info"
                          style={{
                            fontSize: 9,
                            padding: "0 5px",
                            marginLeft: 6,
                          }}
                        >
                          current
                        </span>
                      )}
                    </span>
                    {canWrite && !b.current && (
                      <>
                        <button
                          type="button"
                          className="glass-btn glass-btn-ghost"
                          style={{ fontSize: 10, padding: "1px 6px" }}
                          disabled={busy}
                          onClick={() => checkout(b.name)}
                        >
                          Checkout
                        </button>
                        <button
                          type="button"
                          className="glass-btn glass-btn-ghost"
                          style={{ fontSize: 10, padding: "1px 5px" }}
                          disabled={busy}
                          title={`Delete branch ${b.name}`}
                          aria-label={`Delete branch ${b.name}`}
                          onClick={() => setDeleteTarget(b.name)}
                        >
                          <IconTrash size={10} />
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
              {canWrite &&
                (newBranchOpen ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (newBranchName.trim())
                        createBranch(newBranchName.trim());
                    }}
                    style={{ display: "flex", gap: 5, marginTop: 6 }}
                  >
                    <input
                      className="glass-input"
                      autoFocus
                      placeholder="new-branch-name"
                      value={newBranchName}
                      onChange={(e) => setNewBranchName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setNewBranchOpen(false);
                      }}
                      style={{ fontSize: 11, padding: "3px 7px", flex: 1 }}
                    />
                    <button
                      type="submit"
                      className="glass-btn glass-btn-primary"
                      style={{ fontSize: 10, padding: "2px 8px" }}
                      disabled={busy || !newBranchName.trim()}
                    >
                      Create
                    </button>
                    <button
                      type="button"
                      className="glass-btn glass-btn-ghost"
                      style={{ fontSize: 10, padding: "2px 8px" }}
                      onClick={() => setNewBranchOpen(false)}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    className="glass-btn glass-btn-ghost"
                    style={{ fontSize: 10, padding: "3px 8px", marginTop: 6 }}
                    disabled={busy || !status.hasCommits}
                    title={
                      status.hasCommits
                        ? "Create branch from current HEAD"
                        : "Commit something first"
                    }
                    onClick={() => setNewBranchOpen(true)}
                  >
                    <IconPlus size={10} /> Create branch from HEAD
                  </button>
                ))}
            </CollapsibleSection>
          </>
        )}
      </div>

      <ConfirmModal
        isOpen={!!deleteTarget}
        title="Delete branch"
        message={`Delete the branch "${deleteTarget ?? ""}"? This cannot be undone. Unmerged commits on it may be lost.`}
        confirmLabel="Delete branch"
        isDestructive
        onConfirm={() => deleteTarget && deleteBranch(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

// ---- sub-components ---------------------------------------------------------

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, color: "var(--fg-muted)", padding: "4px 2px" }}>
      {children}
    </div>
  );
}

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count: number;
  action?: { label: string; onClick: () => void };
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 3,
        }}
      >
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4 }}>
          {title.toUpperCase()}
        </span>
        <span
          className="glass-badge glass-badge-info"
          style={{ fontSize: 9, padding: "0 5px" }}
        >
          {count}
        </span>
        {action && (
          <button
            type="button"
            className="glass-btn glass-btn-ghost"
            style={{ marginLeft: "auto", fontSize: 10, padding: "1px 7px" }}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function CollapsibleSection({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          background: "transparent",
          border: "none",
          color: "var(--fg-primary)",
          cursor: "pointer",
          padding: "3px 0",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.4,
        }}
        aria-expanded={open}
      >
        {open ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
        {title.toUpperCase()}
        {typeof count === "number" && (
          <span
            className="glass-badge glass-badge-info"
            style={{ fontSize: 9, padding: "0 5px" }}
          >
            {count}
          </span>
        )}
      </button>
      {open && <div style={{ paddingLeft: 4 }}>{children}</div>}
    </div>
  );
}

function FileRow({
  entry,
  active,
  onSelect,
  onAction,
  actionLabel,
  actionGlyph,
}: {
  entry: GitFileEntry;
  active: boolean;
  onSelect: () => void;
  onAction?: () => void;
  actionLabel: string;
  actionGlyph: string;
}) {
  const s = statusGlyph(entry);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "3px 4px",
        borderRadius: 4,
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        background: active ? "rgba(137,180,250,0.12)" : "transparent",
      }}
    >
      <span
        style={{
          color: s.color,
          width: 12,
          textAlign: "center",
          fontWeight: 700,
        }}
        title={s.label}
        aria-label={s.label}
      >
        {s.glyph}
      </span>
      <button
        type="button"
        onClick={onSelect}
        style={{
          flex: 1,
          minWidth: 0,
          textAlign: "left",
          background: "transparent",
          border: "none",
          color: "var(--fg-secondary)",
          cursor: "pointer",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={
          entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path
        }
      >
        {entry.path}
      </button>
      {onAction && (
        <button
          type="button"
          className="glass-btn glass-btn-ghost"
          style={{ fontSize: 10, padding: "0 6px" }}
          onClick={onAction}
          title={actionLabel}
          aria-label={`${actionLabel} ${entry.path}`}
        >
          {actionGlyph}
        </button>
      )}
    </div>
  );
}

function DiffView({
  diff,
  loading,
}: {
  diff: GitFileDiff | null;
  loading: boolean;
}) {
  if (loading) {
    return <Empty>Loading diff…</Empty>;
  }
  if (!diff) return <Empty>Select a file to view its diff</Empty>;
  if (diff.binary) {
    return <Empty>Binary file — no textual diff</Empty>;
  }
  if (diff.hunks.length === 0) {
    return <Empty>No changes</Empty>;
  }
  return (
    <div
      data-testid="git-diff"
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        maxHeight: 320,
        overflow: "auto",
        background: "rgba(0,0,0,0.18)",
      }}
    >
      {diff.hunks.map((h, hi) => (
        <div key={hi}>
          <div style={{ color: "#89b4fa", padding: "2px 8px" }}>{h.header}</div>
          {h.lines.map((l, li) => (
            <div
              key={li}
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                padding: "0 8px",
                color:
                  l.type === "add"
                    ? "#a6e3a1"
                    : l.type === "del"
                      ? "#f38ba8"
                      : l.type === "meta"
                        ? "var(--fg-muted)"
                        : "var(--fg-secondary)",
                background:
                  l.type === "add"
                    ? "rgba(166,227,161,0.08)"
                    : l.type === "del"
                      ? "rgba(243,139,168,0.08)"
                      : "transparent",
              }}
            >
              {l.type === "add" ? "+ " : l.type === "del" ? "- " : "  "}
              {l.content}
            </div>
          ))}
        </div>
      ))}
      {diff.truncated && (
        <div style={{ color: "#fab387", padding: "3px 8px" }}>
          Diff truncated — open the file to see the rest.
        </div>
      )}
    </div>
  );
}
