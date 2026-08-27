import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { AdminProjectData } from "../../types";
import {
  IconDatabase,
  IconDownload,
  IconTrash,
  IconRefresh,
  IconAlertTriangle,
  IconCheck,
  IconServer,
} from "../common/Icons";

// M46: surfaces backend/src/admin/routes.ts's nine already-built,
// admin-gated, audit-logged backup operations — none of which had a
// frontend caller before this milestone. No backend file is touched here;
// every request below hits an existing, unmodified endpoint.
//
// This panel is intentionally self-contained (mirrors AdminResourceAnalytics,
// the established precedent for an extracted admin tab) rather than sharing
// AdminDashboard's own `actionMessage`/modal state — `projects` is the one
// piece of already-loaded dashboard data it needs, passed as a prop instead
// of being re-fetched.
//
// Destructive confirmations deliberately do NOT use the shared
// common/Modal.tsx ConfirmModal: AdminDashboard.tsx's own existing
// destructive-delete-user flow (search "MODAL 4" in that file) already
// established a different, admin-specific pattern — a locally-owned
// `admin-modal-overlay`/`admin-modal-card` dialog with its own loading/error
// state — and nothing in this file introduces a new one. This is the
// intended, evidence-based adaptation called for when the discovery
// contract's ConfirmModal assumption didn't match what AdminDashboard.tsx
// actually does.

interface DbBackupMetadata {
  filename: string;
  sizeBytes: number;
  createdAt: string;
  integrity: "ok" | "failed" | "unverified";
}

interface WorkspaceBackupMetadata {
  filename: string;
  projectId: string;
  sizeBytes: number;
  createdAt: string;
}

type PendingDeletion =
  | { kind: "db"; backup: DbBackupMetadata }
  | { kind: "workspace"; backup: WorkspaceBackupMetadata; projectName: string };

interface PendingRestore {
  backup: WorkspaceBackupMetadata;
  projectName: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// Honest by design: "unverified" is the backend's normal, expected value
// for every listed (not just-created) database backup — see
// backup/service.ts's own doc comment on listDatabaseBackups(). It must
// never be displayed as though it were "ok".
function IntegrityBadge({
  integrity,
}: {
  integrity: DbBackupMetadata["integrity"];
}) {
  if (integrity === "ok") {
    return (
      <span className="glass-badge glass-badge-success">
        <IconCheck size={10} />
        <span>OK</span>
      </span>
    );
  }
  if (integrity === "failed") {
    return (
      <span className="glass-badge glass-badge-error">
        <IconAlertTriangle size={10} />
        <span>FAILED</span>
      </span>
    );
  }
  return (
    <span className="glass-badge glass-badge-warning">
      <span>UNVERIFIED</span>
    </span>
  );
}

async function downloadBackup(
  url: string,
  filename: string,
  onError: (message: string) => void,
): Promise<void> {
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(
        errJson.error?.message || `Download failed with status ${res.status}`,
      );
    }
    const blob = await res.blob();
    const objectUrl = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(objectUrl);
  } catch (err: any) {
    onError(err.message || "Download failed");
  }
}

export default function AdminBackupsPanel({
  projects,
}: {
  projects: AdminProjectData[];
}) {
  // ---- Database backups ----
  const [dbBackups, setDbBackups] = useState<DbBackupMetadata[]>([]);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [dbCreating, setDbCreating] = useState(false);
  const [dbMessage, setDbMessage] = useState<string | null>(null);

  const loadDbBackups = useCallback(async () => {
    setDbLoading(true);
    setDbError(null);
    try {
      const res = await api<{ backups: DbBackupMetadata[] }>(
        "/api/admin/backups",
      );
      setDbBackups(res.backups || []);
    } catch (err: any) {
      setDbError(err.message || "Failed to load database backups");
    } finally {
      setDbLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDbBackups();
  }, [loadDbBackups]);

  const handleCreateDbBackup = async () => {
    if (dbCreating) return;
    setDbCreating(true);
    setDbError(null);
    try {
      await api("/api/admin/backups", { method: "POST" });
      setDbMessage("Database backup created.");
      setTimeout(() => setDbMessage(null), 4000);
      await loadDbBackups();
    } catch (err: any) {
      setDbError(err.message || "Failed to create database backup");
    } finally {
      setDbCreating(false);
    }
  };

  // ---- Workspace backups ----
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [wsBackups, setWsBackups] = useState<WorkspaceBackupMetadata[]>([]);
  const [wsLoading, setWsLoading] = useState(false);
  const [wsError, setWsError] = useState<string | null>(null);
  const [wsCreating, setWsCreating] = useState(false);
  const [wsMessage, setWsMessage] = useState<string | null>(null);
  // Guards against a stale response from a previously-selected project
  // overwriting the currently-selected project's state if the user changes
  // the selection while a request is still in flight.
  const wsRequestIdRef = useRef(0);

  const loadWorkspaceBackups = useCallback(async (projectId: string) => {
    if (!projectId) {
      setWsBackups([]);
      setWsError(null);
      return;
    }
    const requestId = ++wsRequestIdRef.current;
    setWsLoading(true);
    setWsError(null);
    try {
      const res = await api<{ backups: WorkspaceBackupMetadata[] }>(
        `/api/admin/workspace-backups/${projectId}`,
      );
      if (wsRequestIdRef.current !== requestId) return;
      setWsBackups(res.backups || []);
    } catch (err: any) {
      if (wsRequestIdRef.current !== requestId) return;
      setWsError(err.message || "Failed to load workspace backups");
    } finally {
      if (wsRequestIdRef.current === requestId) setWsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWorkspaceBackups(selectedProjectId);
  }, [selectedProjectId, loadWorkspaceBackups]);

  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  const handleCreateWorkspaceBackup = async () => {
    if (wsCreating || !selectedProjectId) return;
    setWsCreating(true);
    setWsError(null);
    try {
      const res = await api<{
        backup: { workspaceFileCount: number; snapshotCount: number };
      }>(`/api/admin/workspace-backups/${selectedProjectId}`, {
        method: "POST",
      });
      setWsMessage(
        `Workspace backup created (${res.backup.workspaceFileCount} files, ${res.backup.snapshotCount} snapshots).`,
      );
      setTimeout(() => setWsMessage(null), 4000);
      await loadWorkspaceBackups(selectedProjectId);
    } catch (err: any) {
      setWsError(err.message || "Failed to create workspace backup");
    } finally {
      setWsCreating(false);
    }
  };

  // ---- Shared destructive-delete confirmation (DB + workspace) ----
  const [pendingDeletion, setPendingDeletion] =
    useState<PendingDeletion | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleConfirmDelete = async () => {
    if (!pendingDeletion) return;
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      if (pendingDeletion.kind === "db") {
        await api(`/api/admin/backups/${pendingDeletion.backup.filename}`, {
          method: "DELETE",
        });
        setPendingDeletion(null);
        setDbMessage(`Deleted backup ${pendingDeletion.backup.filename}.`);
        setTimeout(() => setDbMessage(null), 4000);
        await loadDbBackups();
      } else {
        await api(
          `/api/admin/workspace-backups/${pendingDeletion.backup.projectId}/${pendingDeletion.backup.filename}`,
          { method: "DELETE" },
        );
        setPendingDeletion(null);
        setWsMessage(`Deleted backup ${pendingDeletion.backup.filename}.`);
        setTimeout(() => setWsMessage(null), 4000);
        await loadWorkspaceBackups(pendingDeletion.backup.projectId);
      }
    } catch (err: any) {
      setDeleteError(err.message || "Failed to delete backup");
    } finally {
      setDeleteLoading(false);
    }
  };

  // ---- Destructive restore confirmation (workspace only) ----
  const [pendingRestore, setPendingRestore] = useState<PendingRestore | null>(
    null,
  );
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const handleConfirmRestore = async () => {
    if (!pendingRestore || restoreLoading) return;
    setRestoreLoading(true);
    setRestoreError(null);
    try {
      const { backup } = pendingRestore;
      await api(
        `/api/admin/workspace-backups/${backup.projectId}/${backup.filename}/restore`,
        { method: "POST" },
      );
      setWsMessage(
        `Restored ${backup.filename} to ${pendingRestore.projectName}.`,
      );
      setTimeout(() => setWsMessage(null), 5000);
      setPendingRestore(null);
      // The restore just overwrote this project's live workspace — the
      // backup list itself is unaffected, but re-fetching keeps this panel
      // honest rather than leaving it on a response captured before the
      // restore happened. Any other already-open view of this project's
      // files (e.g. the IDE, if a tab is open elsewhere) is outside this
      // panel's reach and is expected to reload independently.
      await loadWorkspaceBackups(backup.projectId);
    } catch (err: any) {
      setRestoreError(err.message || "Failed to restore workspace backup");
    } finally {
      setRestoreLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* ============================= DATABASE BACKUPS ============================= */}
      <div className="admin-table-wrap">
        <div className="admin-table-toolbar">
          <h2
            style={{
              fontSize: "14px",
              fontWeight: 600,
              margin: 0,
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <IconDatabase size={16} color="#89b4fa" />
            <span>Database Backups ({dbBackups.length})</span>
          </h2>

          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {dbMessage && (
              <span className="glass-badge glass-badge-success">
                <IconCheck size={10} />
                <span>{dbMessage}</span>
              </span>
            )}
            <button
              className="glass-btn glass-btn-icon"
              onClick={loadDbBackups}
              title="Refresh"
              disabled={dbLoading}
            >
              <IconRefresh size={12} />
            </button>
            <button
              className="glass-btn glass-btn-primary"
              onClick={handleCreateDbBackup}
              disabled={dbCreating}
              style={{ fontSize: "12px", padding: "5px 12px" }}
            >
              {dbCreating ? "Creating…" : "Create Backup"}
            </button>
          </div>
        </div>

        {dbError && (
          <div
            className="glass-banner glass-banner-error"
            style={{ margin: "10px 14px 0" }}
          >
            <span>{dbError}</span>
          </div>
        )}

        <div className="admin-table-scroll">
          {dbLoading && dbBackups.length === 0 ? (
            <div
              style={{
                padding: "24px",
                textAlign: "center",
                color: "var(--fg-muted)",
                fontSize: "13px",
              }}
            >
              Loading database backups…
            </div>
          ) : dbBackups.length === 0 ? (
            <div
              style={{
                padding: "30px",
                textAlign: "center",
                color: "var(--fg-muted)",
                fontSize: "13px",
              }}
            >
              No database backups yet. Create one to establish a recovery point.
            </div>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Filename</th>
                  <th>Size</th>
                  <th>Created</th>
                  <th>Integrity</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {dbBackups.map((b) => (
                  <tr key={b.filename}>
                    <td
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "12px",
                      }}
                    >
                      {b.filename}
                    </td>
                    <td style={{ color: "var(--fg-secondary)" }}>
                      {formatBytes(b.sizeBytes)}
                    </td>
                    <td style={{ color: "var(--fg-muted)" }}>
                      {formatTimestamp(b.createdAt)}
                    </td>
                    <td>
                      <IntegrityBadge integrity={b.integrity} />
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        className="glass-btn glass-btn-icon"
                        title="Download"
                        aria-label={`Download ${b.filename}`}
                        onClick={() =>
                          downloadBackup(
                            `/api/admin/backups/${b.filename}`,
                            b.filename,
                            setDbError,
                          )
                        }
                      >
                        <IconDownload size={12} />
                      </button>
                      <button
                        className="glass-btn glass-btn-icon"
                        title="Delete"
                        aria-label={`Delete ${b.filename}`}
                        style={{ marginLeft: "6px", color: "#f38ba8" }}
                        onClick={() =>
                          setPendingDeletion({ kind: "db", backup: b })
                        }
                      >
                        <IconTrash size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ============================= WORKSPACE BACKUPS ============================= */}
      <div className="admin-table-wrap">
        <div className="admin-table-toolbar">
          <h2
            style={{
              fontSize: "14px",
              fontWeight: 600,
              margin: 0,
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <IconServer size={16} color="#a6e3a1" />
            <span>
              Workspace Backups {selectedProjectId && `(${wsBackups.length})`}
            </span>
          </h2>

          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {wsMessage && (
              <span className="glass-badge glass-badge-success">
                <IconCheck size={10} />
                <span>{wsMessage}</span>
              </span>
            )}
            <select
              className="glass-input"
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
              style={{
                fontSize: "12px",
                padding: "4px 10px",
                minWidth: "220px",
              }}
            >
              <option value="">Select a project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.owner_username})
                </option>
              ))}
            </select>
            <button
              className="glass-btn glass-btn-primary"
              onClick={handleCreateWorkspaceBackup}
              disabled={wsCreating || !selectedProjectId}
              style={{ fontSize: "12px", padding: "5px 12px" }}
            >
              {wsCreating ? "Creating…" : "Create Workspace Backup"}
            </button>
          </div>
        </div>

        {wsError && (
          <div
            className="glass-banner glass-banner-error"
            style={{ margin: "10px 14px 0" }}
          >
            <span>{wsError}</span>
          </div>
        )}

        <div className="admin-table-scroll">
          {!selectedProjectId ? (
            <div
              style={{
                padding: "30px",
                textAlign: "center",
                color: "var(--fg-muted)",
                fontSize: "13px",
              }}
            >
              Select a project above to view or create its workspace backups.
            </div>
          ) : wsLoading && wsBackups.length === 0 ? (
            <div
              style={{
                padding: "24px",
                textAlign: "center",
                color: "var(--fg-muted)",
                fontSize: "13px",
              }}
            >
              Loading workspace backups…
            </div>
          ) : wsBackups.length === 0 ? (
            <div
              style={{
                padding: "30px",
                textAlign: "center",
                color: "var(--fg-muted)",
                fontSize: "13px",
              }}
            >
              No workspace backups for this project yet.
            </div>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Filename</th>
                  <th>Size</th>
                  <th>Created</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {wsBackups.map((b) => (
                  <tr key={b.filename}>
                    <td
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "12px",
                      }}
                    >
                      {b.filename}
                    </td>
                    <td style={{ color: "var(--fg-secondary)" }}>
                      {formatBytes(b.sizeBytes)}
                    </td>
                    <td style={{ color: "var(--fg-muted)" }}>
                      {formatTimestamp(b.createdAt)}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        className="glass-btn glass-btn-icon"
                        title="Download"
                        aria-label={`Download ${b.filename}`}
                        onClick={() =>
                          downloadBackup(
                            `/api/admin/workspace-backups/${b.projectId}/${b.filename}`,
                            b.filename,
                            setWsError,
                          )
                        }
                      >
                        <IconDownload size={12} />
                      </button>
                      <button
                        className="glass-btn glass-btn-icon"
                        title="Restore"
                        aria-label={`Restore ${b.filename}`}
                        style={{ marginLeft: "6px", color: "#a6e3a1" }}
                        onClick={() =>
                          setPendingRestore({
                            backup: b,
                            projectName: selectedProject?.name || b.projectId,
                          })
                        }
                      >
                        <IconRefresh size={12} />
                      </button>
                      <button
                        className="glass-btn glass-btn-icon"
                        title="Delete"
                        aria-label={`Delete ${b.filename}`}
                        style={{ marginLeft: "6px", color: "#f38ba8" }}
                        onClick={() =>
                          setPendingDeletion({
                            kind: "workspace",
                            backup: b,
                            projectName: selectedProject?.name || b.projectId,
                          })
                        }
                      >
                        <IconTrash size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ============================= DELETE CONFIRMATION ============================= */}
      {pendingDeletion && (
        <div className="admin-modal-overlay" role="dialog" aria-modal="true">
          <div
            className="admin-modal-card"
            style={{ border: "1px solid rgba(243, 139, 168, 0.4)" }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                marginBottom: "14px",
              }}
            >
              <div
                style={{
                  width: "36px",
                  height: "36px",
                  borderRadius: "10px",
                  background: "rgba(243, 139, 168, 0.15)",
                  color: "#f38ba8",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <IconAlertTriangle size={20} />
              </div>
              <div>
                <h3
                  style={{
                    margin: 0,
                    fontSize: "16px",
                    fontWeight: 600,
                    color: "var(--fg-primary)",
                  }}
                >
                  Delete Backup
                </h3>
                <p
                  style={{
                    margin: 0,
                    fontSize: "12px",
                    color: "var(--fg-muted)",
                  }}
                >
                  This cannot be undone
                </p>
              </div>
            </div>

            {deleteError && (
              <div
                className="glass-banner glass-banner-error"
                style={{ marginBottom: "14px", fontSize: "12px" }}
              >
                <span>{deleteError}</span>
              </div>
            )}

            <p
              style={{
                fontSize: "13px",
                color: "var(--fg-secondary)",
                lineHeight: 1.5,
                marginBottom: "20px",
              }}
            >
              Permanently delete{" "}
              {pendingDeletion.kind === "workspace"
                ? "workspace "
                : "database "}
              backup{" "}
              <strong style={{ color: "#f38ba8" }}>
                {pendingDeletion.backup.filename}
              </strong>
              {pendingDeletion.kind === "workspace" && (
                <>
                  {" "}
                  (project{" "}
                  <strong style={{ color: "#f38ba8" }}>
                    {pendingDeletion.projectName}
                  </strong>
                  )
                </>
              )}
              ?
            </p>

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "10px",
              }}
            >
              <button
                className="glass-btn glass-btn-ghost"
                onClick={() => setPendingDeletion(null)}
                disabled={deleteLoading}
              >
                Cancel
              </button>
              <button
                className="glass-btn"
                onClick={handleConfirmDelete}
                disabled={deleteLoading}
                style={{
                  background: "rgba(243, 139, 168, 0.3)",
                  color: "#f38ba8",
                  border: "1px solid rgba(243, 139, 168, 0.4)",
                  fontWeight: 600,
                }}
              >
                {deleteLoading ? "Deleting…" : "Permanently Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============================= RESTORE CONFIRMATION ============================= */}
      {pendingRestore && (
        <div className="admin-modal-overlay" role="dialog" aria-modal="true">
          <div
            className="admin-modal-card"
            style={{ border: "1px solid rgba(249, 226, 175, 0.4)" }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                marginBottom: "14px",
              }}
            >
              <div
                style={{
                  width: "36px",
                  height: "36px",
                  borderRadius: "10px",
                  background: "rgba(249, 226, 175, 0.15)",
                  color: "#f9e2af",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <IconAlertTriangle size={20} />
              </div>
              <div>
                <h3
                  style={{
                    margin: 0,
                    fontSize: "16px",
                    fontWeight: 600,
                    color: "var(--fg-primary)",
                  }}
                >
                  Restore Workspace Backup
                </h3>
                <p
                  style={{
                    margin: 0,
                    fontSize: "12px",
                    color: "var(--fg-muted)",
                  }}
                >
                  This overwrites the project's current workspace
                </p>
              </div>
            </div>

            {restoreError && (
              <div
                className="glass-banner glass-banner-error"
                style={{ marginBottom: "14px", fontSize: "12px" }}
              >
                <span>{restoreError}</span>
              </div>
            )}

            <p
              style={{
                fontSize: "13px",
                color: "var(--fg-secondary)",
                lineHeight: 1.5,
                marginBottom: "20px",
              }}
            >
              Restore{" "}
              <strong style={{ color: "#f9e2af" }}>
                {pendingRestore.backup.filename}
              </strong>{" "}
              (created {formatTimestamp(pendingRestore.backup.createdAt)}) to{" "}
              <strong style={{ color: "#f9e2af" }}>
                {pendingRestore.projectName}
              </strong>
              ? This will replace the project's current workspace contents.
            </p>

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "10px",
              }}
            >
              <button
                className="glass-btn glass-btn-ghost"
                onClick={() => setPendingRestore(null)}
                disabled={restoreLoading}
              >
                Cancel
              </button>
              <button
                className="glass-btn"
                onClick={handleConfirmRestore}
                disabled={restoreLoading}
                style={{
                  background: "rgba(249, 226, 175, 0.3)",
                  color: "#f9e2af",
                  border: "1px solid rgba(249, 226, 175, 0.4)",
                  fontWeight: 600,
                }}
              >
                {restoreLoading ? "Restoring…" : "Restore Workspace"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
