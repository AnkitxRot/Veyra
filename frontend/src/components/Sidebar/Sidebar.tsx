import React, { useState, useEffect } from "react";
import { User, Project, TreeNode } from "../../types";
import { api } from "../../api";
import {
  IconFolder,
  IconFolderOpen,
  IconChevronRight,
  IconChevronDown,
  IconPlus,
  IconRefresh,
  IconLogOut,
  IconTrash,
  IconEdit,
  IconSparkles,
  IconDownload,
  IconUpload,
  IconFileUpload,
  IconFolderUpload,
  IconSettings,
  IconCopy,
} from "../common/Icons";
import { getLanguageIcon } from "../common/iconUtils";
import { PromptModal, ConfirmModal } from "../common/Modal";
import { TemplateModal } from "../common/TemplateModal";
import type { CollaboratorPresence } from "../../collab/client";

interface SidebarProps {
  user: User;
  projects: Project[];
  project: Project | null;
  onSelectProject: (p: Project) => void;
  onCreateProject: () => void;
  tree: TreeNode[];
  onOpenFile: (path: string) => void;
  activeFile: string | null;
  onLogout: () => void;
  refreshTree: () => void;
  width?: number;
  onOpenTour?: () => void;
  onOpenSettings?: () => void;
  collaborators?: CollaboratorPresence[];
  currentUserId?: number;
}

export default function Sidebar({
  user,
  projects,
  project,
  onSelectProject,
  onCreateProject,
  tree,
  onOpenFile,
  activeFile,
  onLogout,
  refreshTree,
  width = 260,
  onOpenTour,
  onOpenSettings,
  collaborators,
  currentUserId,
}: SidebarProps) {
  const [showProjectsAccordion, setShowProjectsAccordion] = useState(true);
  const [searchFilter, setSearchFilter] = useState("");

  // Modals state
  const [modalState, setModalState] = useState<{
    type:
      | "new_file"
      | "new_folder"
      | "rename"
      | "delete"
      | "new_project"
      | "fork_project"
      | null;
    node?: TreeNode | null;
    initialValue?: string;
  }>({ type: null });
  const [isForking, setIsForking] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);

  const isDemoUser =
    user.username.startsWith("evaluator_") || (user as any).isDemo;

  const collaboratorsByPath = React.useMemo(() => {
    const map = new Map<string, CollaboratorPresence[]>();
    if (!collaborators) return map;
    for (const c of collaborators) {
      if (c.userId !== currentUserId && c.activeFile) {
        const list = map.get(c.activeFile) || [];
        list.push(c);
        map.set(c.activeFile, list);
      }
    }
    return map;
  }, [collaborators, currentUserId]);

  const handleCreateProject = async (opts: {
    templateId: string | null;
    name: string;
  }) => {
    if (!opts.name.trim() || isCreatingProject) return;
    setIsCreatingProject(true);
    try {
      const res = opts.templateId
        ? await api<{ project: Project }>("/api/projects/from-template", {
            method: "POST",
            body: JSON.stringify({
              templateId: opts.templateId,
              name: opts.name.trim(),
            }),
          })
        : await api<{ project: Project }>("/api/projects", {
            method: "POST",
            body: JSON.stringify({ name: opts.name.trim(), language: "auto" }),
          });
      onCreateProject();
      if (res.project) {
        onSelectProject(res.project);
      }
    } catch (err: any) {
      alert(`Error creating project: ${err.message}`);
    } finally {
      setIsCreatingProject(false);
      setModalState({ type: null });
    }
  };

  const handleForkProject = async (name: string) => {
    if (!project || isForking) return;
    setIsForking(true);
    try {
      const res = await api<{ project: Project }>(
        `/api/projects/${project.id}/fork`,
        {
          method: "POST",
          body: JSON.stringify(name.trim() ? { name: name.trim() } : {}),
        },
      );
      onCreateProject();
      if (res.project) {
        onSelectProject(res.project);
      }
    } catch (err: any) {
      alert(`Fork failed: ${err.message}`);
    } finally {
      setIsForking(false);
      setModalState({ type: null });
    }
  };

  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const replaceFileInputRef = React.useRef<HTMLInputElement | null>(null);
  const directFileInputRef = React.useRef<HTMLInputElement | null>(null);
  const folderInputRef = React.useRef<HTMLInputElement | null>(null);

  const [uploadTargetDir, setUploadTargetDir] = useState<string>("");
  const [isUploading, setIsUploading] = useState(false);
  const [conflictModal, setConflictModal] = useState<{
    isOpen: boolean;
    files: File[];
    targetDir: string;
    conflicts: string[];
  }>({ isOpen: false, files: [], targetDir: "", conflicts: [] });

  const triggerFileUpload = (targetDir = "") => {
    setUploadTargetDir(targetDir);
    if (directFileInputRef.current) {
      directFileInputRef.current.value = "";
      directFileInputRef.current.click();
    }
  };

  const triggerFolderUpload = (targetDir = "") => {
    setUploadTargetDir(targetDir);
    if (folderInputRef.current) {
      folderInputRef.current.value = "";
      folderInputRef.current.click();
    }
  };

  const handleUploadFiles = async (
    fileList: FileList | File[] | null,
    targetDir = uploadTargetDir,
    overwrite = false,
  ) => {
    if (!project || !fileList || fileList.length === 0) return;
    const filesArray = Array.from(fileList);
    setIsUploading(true);

    try {
      const formData = new FormData();
      if (targetDir) formData.append("targetDir", targetDir);
      if (overwrite) formData.append("overwrite", "true");

      for (const file of filesArray) {
        const relPath = (file as any).webkitRelativePath || file.name;
        formData.append("files", file, relPath);
      }

      const res = await fetch(
        `/api/projects/${project.id}/upload?targetDir=${encodeURIComponent(targetDir)}${overwrite ? "&overwrite=true" : ""}`,
        {
          method: "POST",
          body: formData,
          credentials: "include",
        },
      );

      if (res.status === 409) {
        const errJson = await res.json().catch(() => ({}));
        const conflicts = errJson.error?.details?.conflicts || [
          errJson.error?.message || "File conflict",
        ];
        setConflictModal({
          isOpen: true,
          files: filesArray,
          targetDir,
          conflicts,
        });
        return;
      }

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(
          errJson.error?.message || `Upload failed with status ${res.status}`,
        );
      }

      refreshTree();
      setConflictModal({
        isOpen: false,
        files: [],
        targetDir: "",
        conflicts: [],
      });
    } catch (err: any) {
      alert(`Upload failed: ${err.message}`);
    } finally {
      setIsUploading(false);
      if (directFileInputRef.current) directFileInputRef.current.value = "";
      if (folderInputRef.current) folderInputRef.current.value = "";
    }
  };

  const handleExportProject = async () => {
    if (!project) return;
    try {
      const res = await fetch(`/api/projects/${project.id}/export`, {
        credentials: "include",
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(
          errJson.error?.message || `Export failed with status ${res.status}`,
        );
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "project"}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(`Export failed: ${err.message}`);
    }
  };

  const handleImportNewProject = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);
      const projectName = file.name.replace(/\.zip$/i, "");
      const res = await api<{ project: Project }>("/api/projects/import", {
        method: "POST",
        body: JSON.stringify({ name: projectName, archiveBase64: base64 }),
      });
      onCreateProject();
      if (res.project) {
        onSelectProject(res.project);
      }
      alert(
        `Project "${res.project?.name || projectName}" imported successfully!`,
      );
    } catch (err: any) {
      alert(`Import failed: ${err.message}`);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleImportWorkspace = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    if (!project) return;
    const file = e.target.files?.[0];
    if (!file) return;
    if (
      !window.confirm(
        `Replace all workspace files in "${project.name}" with contents of ${file.name}?`,
      )
    ) {
      if (replaceFileInputRef.current) replaceFileInputRef.current.value = "";
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);
      await api<{ ok: boolean; fileCount: number }>(
        `/api/projects/${project.id}/import?replace=true`,
        {
          method: "POST",
          body: JSON.stringify({ archiveBase64: base64, replace: true }),
        },
      );
      refreshTree();
      alert(`Workspace updated with ${file.name}!`);
    } catch (err: any) {
      alert(`Workspace import failed: ${err.message}`);
    } finally {
      if (replaceFileInputRef.current) replaceFileInputRef.current.value = "";
    }
  };

  const handleFileActionConfirm = async (val?: string) => {
    if (!project) return;
    const { type, node } = modalState;
    const parentPath =
      node?.type === "dir"
        ? node.path
        : node
          ? node.path.split("/").slice(0, -1).join("/")
          : "";

    try {
      if (type === "new_file" && val) {
        const fullPath = parentPath ? `${parentPath}/${val}` : val;
        await api(`/api/projects/${project.id}/file`, {
          method: "POST",
          body: JSON.stringify({ path: fullPath, content: "" }),
        });
        refreshTree();
        onOpenFile(fullPath);
      } else if (type === "new_folder" && val) {
        const fullPath = parentPath
          ? `${parentPath}/${val}/.keep`
          : `${val}/.keep`;
        await api(`/api/projects/${project.id}/file`, {
          method: "POST",
          body: JSON.stringify({ path: fullPath, content: "" }),
        });
        refreshTree();
      } else if (type === "rename" && val && node) {
        const newPath = parentPath ? `${parentPath}/${val}` : val;
        await api(`/api/projects/${project.id}/move`, {
          method: "POST",
          body: JSON.stringify({ from: node.path, to: newPath }),
        });
        refreshTree();
        if (activeFile === node.path) onOpenFile(newPath);
      } else if (type === "delete" && node) {
        await api(`/api/projects/${project.id}/delete`, {
          method: "POST",
          body: JSON.stringify({ path: node.path }),
        });
        refreshTree();
      }
    } catch (err: any) {
      alert(`Error: ${err.message || "Action failed"}`);
    } finally {
      setModalState({ type: null });
    }
  };

  return (
    <aside
      className="sidebar"
      style={{ width: `${width}px`, minWidth: `${width}px` }}
      aria-label="Project Explorer"
    >
      {/* Sidebar Header with User Profile / Demo Tag */}
      <div className="sidebar-header">
        <div className="sidebar-user-badge">
          <span className="user-status-dot" title="Workspace Connected" />
          <span
            style={{
              maxWidth: "120px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {user.username}
          </span>
          {isDemoUser && (
            <span
              className="glass-badge glass-badge-success"
              style={{ fontSize: "9px", padding: "1px 5px" }}
            >
              DEMO
            </span>
          )}
        </div>

        <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
          {onOpenTour && (
            <button
              className="glass-btn glass-btn-icon"
              onClick={onOpenTour}
              title="Guided Onboarding Tour"
              aria-label="Guided Tour"
            >
              <IconSparkles size={13} color="var(--accent)" />
            </button>
          )}
          {onOpenSettings && (
            <button
              className="glass-btn glass-btn-icon"
              onClick={onOpenSettings}
              title="Editor Settings"
              aria-label="Editor Settings"
            >
              <IconSettings size={13} />
            </button>
          )}
          <button
            className="glass-btn glass-btn-icon"
            onClick={onLogout}
            title="Sign Out"
            aria-label="Sign Out"
          >
            <IconLogOut size={13} />
          </button>
        </div>
      </div>

      <div className="sidebar-content">
        {/* Projects Accordion */}
        <div className="sidebar-section">
          <div
            className="section-header"
            style={{ cursor: "pointer" }}
            onClick={() => setShowProjectsAccordion(!showProjectsAccordion)}
            tabIndex={0}
            role="button"
            aria-expanded={showProjectsAccordion}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setShowProjectsAccordion(!showProjectsAccordion);
              }
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              {showProjectsAccordion ? (
                <IconChevronDown size={12} />
              ) : (
                <IconChevronRight size={12} />
              )}
              Projects
              <span
                className="glass-badge"
                style={{ padding: "0 5px", fontSize: "10px" }}
              >
                {projects.length}
              </span>
            </span>
            <div
              className="section-actions"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="file"
                ref={fileInputRef}
                style={{ display: "none" }}
                accept=".zip,application/zip"
                onChange={handleImportNewProject}
              />
              <button
                className="glass-btn glass-btn-icon"
                onClick={() => fileInputRef.current?.click()}
                title="Import Project (.zip)"
                aria-label="Import Project (.zip)"
              >
                <IconUpload size={12} />
              </button>
              <button
                className="glass-btn glass-btn-icon"
                onClick={() => setModalState({ type: "new_project" })}
                title="Create New Project"
                aria-label="Create New Project"
              >
                <IconPlus size={12} />
              </button>
            </div>
          </div>

          {showProjectsAccordion && (
            <ul className="project-list" role="listbox">
              {projects.map((p: Project) => (
                <li
                  key={p.id}
                  className={`project-item ${project?.id === p.id ? "active" : ""}`}
                  onClick={() => onSelectProject(p)}
                  tabIndex={0}
                  role="option"
                  aria-selected={project?.id === p.id}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectProject(p);
                    }
                  }}
                >
                  <IconFolder size={14} />
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      flex: 1,
                    }}
                  >
                    {p.name}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Workspace File Explorer */}
        {project && (
          <div
            className="sidebar-section"
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            <div className="section-header">
              <span>Files</span>
              <div className="section-actions">
                <input
                  type="file"
                  ref={replaceFileInputRef}
                  style={{ display: "none" }}
                  accept=".zip,application/zip"
                  onChange={handleImportWorkspace}
                />
                <input
                  type="file"
                  ref={directFileInputRef}
                  style={{ display: "none" }}
                  multiple
                  onChange={(e) => handleUploadFiles(e.target.files)}
                />
                <input
                  type="file"
                  ref={folderInputRef}
                  style={{ display: "none" }}
                  multiple
                  {...({ webkitdirectory: "", directory: "" } as any)}
                  onChange={(e) => handleUploadFiles(e.target.files)}
                />
                <button
                  className="glass-btn glass-btn-icon"
                  onClick={() => triggerFileUpload()}
                  title="Upload Files"
                  aria-label="Upload Files"
                  disabled={isUploading}
                >
                  <IconFileUpload size={12} />
                </button>
                <button
                  className="glass-btn glass-btn-icon"
                  onClick={() => triggerFolderUpload()}
                  title="Upload Folder"
                  aria-label="Upload Folder"
                  disabled={isUploading}
                >
                  <IconFolderUpload size={12} />
                </button>
                <button
                  className="glass-btn glass-btn-icon"
                  onClick={handleExportProject}
                  title="Export Workspace (.zip)"
                  aria-label="Export Workspace (.zip)"
                >
                  <IconDownload size={12} />
                </button>
                <button
                  className="glass-btn glass-btn-icon"
                  onClick={() => setModalState({ type: "fork_project" })}
                  title="Fork Project"
                  aria-label="Fork Project"
                  disabled={isForking}
                >
                  <IconCopy size={12} />
                </button>
                <button
                  className="glass-btn glass-btn-icon"
                  onClick={() => replaceFileInputRef.current?.click()}
                  title="Import / Replace Workspace (.zip)"
                  aria-label="Import / Replace Workspace (.zip)"
                >
                  <IconUpload size={12} />
                </button>
                <button
                  className="glass-btn glass-btn-icon"
                  onClick={() => setModalState({ type: "new_file" })}
                  title="New File"
                  aria-label="New File"
                >
                  <IconPlus size={12} />
                </button>
                <button
                  className="glass-btn glass-btn-icon"
                  onClick={() => setModalState({ type: "new_folder" })}
                  title="New Folder"
                  aria-label="New Folder"
                >
                  <IconFolder size={12} />
                </button>
                <button
                  className="glass-btn glass-btn-icon"
                  onClick={refreshTree}
                  title="Refresh File Tree"
                  aria-label="Refresh File Tree"
                >
                  <IconRefresh size={12} />
                </button>
              </div>
            </div>

            {/* Upload Progress Indicator */}
            {isUploading && (
              <div
                style={{
                  padding: "4px 8px 6px",
                  fontSize: "11px",
                  color: "var(--accent-primary)",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <span
                  className="spinner"
                  style={{
                    width: "10px",
                    height: "10px",
                    borderWidth: "1.5px",
                    display: "inline-block",
                  }}
                />
                <span>Uploading files...</span>
              </div>
            )}

            {/* Quick Filter Bar */}
            <div style={{ padding: "0 8px 6px" }}>
              <input
                className="glass-input"
                style={{ padding: "4px 8px", fontSize: "11px" }}
                placeholder="Filter files..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                aria-label="Filter files in project"
              />
            </div>

            <div className="file-tree-container">
              <FileTree
                nodes={tree}
                filter={searchFilter}
                onSelect={onOpenFile}
                selected={activeFile}
                collaboratorsByPath={collaboratorsByPath}
                onAction={(action: any, node?: any) => {
                  if (
                    action === "new_file" ||
                    action === "new_folder" ||
                    action === "rename" ||
                    action === "delete"
                  ) {
                    setModalState({
                      type: action,
                      node,
                      initialValue:
                        action === "rename" && node ? node.name : "",
                    });
                  } else if (action === "upload_file") {
                    const parentPath =
                      node?.type === "dir"
                        ? node.path
                        : node
                          ? node.path.split("/").slice(0, -1).join("/")
                          : "";
                    triggerFileUpload(parentPath);
                  } else if (action === "upload_folder") {
                    const parentPath =
                      node?.type === "dir"
                        ? node.path
                        : node
                          ? node.path.split("/").slice(0, -1).join("/")
                          : "";
                    triggerFolderUpload(parentPath);
                  }
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Custom Liquid Glass Modals */}
      <TemplateModal
        isOpen={modalState.type === "new_project"}
        isCreating={isCreatingProject}
        onConfirm={handleCreateProject}
        onCancel={() => setModalState({ type: null })}
      />

      <PromptModal
        isOpen={modalState.type === "fork_project"}
        title="Fork Project"
        message="Creates an independent copy of this project's workspace, owned by you."
        initialValue={project ? `${project.name} (Fork)` : ""}
        placeholder="Fork Name"
        confirmLabel={isForking ? "Forking…" : "Fork"}
        onConfirm={handleForkProject}
        onCancel={() => setModalState({ type: null })}
      />

      <PromptModal
        isOpen={modalState.type === "new_file"}
        title="New File"
        placeholder="filename.py, app.js, main.c..."
        confirmLabel="Create File"
        onConfirm={handleFileActionConfirm}
        onCancel={() => setModalState({ type: null })}
      />

      <PromptModal
        isOpen={modalState.type === "new_folder"}
        title="New Folder"
        placeholder="Folder Name"
        confirmLabel="Create Folder"
        onConfirm={handleFileActionConfirm}
        onCancel={() => setModalState({ type: null })}
      />

      <PromptModal
        isOpen={modalState.type === "rename"}
        title="Rename"
        initialValue={modalState.initialValue}
        confirmLabel="Rename"
        onConfirm={handleFileActionConfirm}
        onCancel={() => setModalState({ type: null })}
      />

      <ConfirmModal
        isOpen={modalState.type === "delete"}
        title="Delete Item"
        message={`Are you sure you want to delete ${modalState.node?.name || "this item"}? This action cannot be undone.`}
        confirmLabel="Delete Permanently"
        isDestructive={true}
        onConfirm={() => handleFileActionConfirm()}
        onCancel={() => setModalState({ type: null })}
      />

      <ConfirmModal
        isOpen={conflictModal.isOpen}
        title="Overwrite Existing Files?"
        message={`The following file(s) already exist in the workspace: ${conflictModal.conflicts.slice(0, 4).join(", ")}${conflictModal.conflicts.length > 4 ? ` and ${conflictModal.conflicts.length - 4} more` : ""}. Do you want to replace them?`}
        confirmLabel="Overwrite"
        isDestructive={true}
        onConfirm={() =>
          handleUploadFiles(conflictModal.files, conflictModal.targetDir, true)
        }
        onCancel={() =>
          setConflictModal({
            isOpen: false,
            files: [],
            targetDir: "",
            conflicts: [],
          })
        }
      />
    </aside>
  );
}

function FileTree({
  nodes,
  filter,
  onSelect,
  selected,
  onAction,
  collaboratorsByPath,
}: any) {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    node: TreeNode | null;
    type: "bg" | "node";
  } | null>(null);

  const handleContextBg = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({
      x: Math.min(e.clientX, window.innerWidth - 180),
      y: Math.min(e.clientY, window.innerHeight - 200),
      node: null,
      type: "bg",
    });
  };

  const handleContextNode = (e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: Math.min(e.clientX, window.innerWidth - 180),
      y: Math.min(e.clientY, window.innerHeight - 200),
      node,
      type: "node",
    });
  };

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    document.addEventListener("click", closeMenu);
    return () => document.removeEventListener("click", closeMenu);
  }, []);

  const filterNodes = (items: TreeNode[]): TreeNode[] => {
    if (!filter.trim()) return items;
    const lower = filter.toLowerCase();
    return items
      .map((item) => {
        if (item.type === "file" && item.name.toLowerCase().includes(lower))
          return item;
        if (item.type === "dir") {
          if (item.name.toLowerCase().includes(lower)) return item;
          if (item.children) {
            const matchingChildren = filterNodes(item.children);
            if (matchingChildren.length > 0) {
              return { ...item, children: matchingChildren };
            }
          }
        }
        return null;
      })
      .filter(Boolean) as TreeNode[];
  };

  const filtered = filterNodes(nodes);

  return (
    <div
      onContextMenu={handleContextBg}
      style={{ minHeight: "100%", paddingBottom: "20px" }}
    >
      {filtered.length === 0 ? (
        <div
          style={{
            padding: "24px 12px",
            textAlign: "center",
            color: "var(--fg-muted)",
            fontSize: "var(--text-xs)",
          }}
        >
          <p style={{ margin: "0 0 12px 0" }}>
            {filter ? "No matching files" : "Workspace is empty"}
          </p>
          {!filter && (
            <button
              className="glass-btn glass-btn-primary"
              style={{ fontSize: "11px", padding: "4px 10px" }}
              onClick={() => onAction("new_file")}
            >
              + Add File
            </button>
          )}
        </div>
      ) : (
        <FileTreeNodes
          nodes={filtered}
          onSelect={onSelect}
          selected={selected}
          onContextNode={handleContextNode}
          collaboratorsByPath={collaboratorsByPath}
        />
      )}

      {/* Liquid Glass Context Menu */}
      {contextMenu && (
        <div
          className="glass-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="context-menu-item"
            onClick={() => {
              setContextMenu(null);
              onAction("new_file", contextMenu.node);
            }}
          >
            <IconPlus size={13} />
            <span>New File</span>
          </div>
          <div
            className="context-menu-item"
            onClick={() => {
              setContextMenu(null);
              onAction("new_folder", contextMenu.node);
            }}
          >
            <IconFolder size={13} />
            <span>New Folder</span>
          </div>
          <div className="context-menu-divider" />
          <div
            className="context-menu-item"
            onClick={() => {
              setContextMenu(null);
              onAction("upload_file", contextMenu.node);
            }}
          >
            <IconFileUpload size={13} />
            <span>Upload Files Here...</span>
          </div>
          <div
            className="context-menu-item"
            onClick={() => {
              setContextMenu(null);
              onAction("upload_folder", contextMenu.node);
            }}
          >
            <IconFolderUpload size={13} />
            <span>Upload Folder Here...</span>
          </div>
          {contextMenu.type === "node" && (
            <>
              <div className="context-menu-divider" />
              <div
                className="context-menu-item"
                onClick={() => {
                  setContextMenu(null);
                  onAction("rename", contextMenu.node);
                }}
              >
                <IconEdit size={13} />
                <span>Rename</span>
              </div>
              <div
                className="context-menu-item danger"
                onClick={() => {
                  setContextMenu(null);
                  onAction("delete", contextMenu.node);
                }}
              >
                <IconTrash size={13} />
                <span>Delete</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function FileTreeNodes({
  nodes,
  onSelect,
  selected,
  onContextNode,
  collaboratorsByPath,
}: any) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggleCollapse = (path: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  const handleKeyDown = (e: React.KeyboardEvent, n: TreeNode) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (n.type === "dir") toggleCollapse(n.path);
      else onSelect(n.path);
    } else if (
      e.key === "ArrowRight" &&
      n.type === "dir" &&
      collapsed[n.path]
    ) {
      e.preventDefault();
      toggleCollapse(n.path);
    } else if (
      e.key === "ArrowLeft" &&
      n.type === "dir" &&
      !collapsed[n.path]
    ) {
      e.preventDefault();
      toggleCollapse(n.path);
    }
  };

  return (
    <ul className="file-tree" role="tree">
      {nodes.map((n: TreeNode) => {
        const isDir = n.type === "dir";
        const isCollapsed = collapsed[n.path];
        const nodeCollaborators = !isDir
          ? collaboratorsByPath?.get(n.path) || []
          : [];

        return (
          <li key={n.path} role="none">
            <div
              className={`tree-node ${selected === n.path ? "active" : ""}`}
              onClick={(e) => {
                if (isDir) toggleCollapse(n.path, e);
                else onSelect(n.path);
              }}
              onContextMenu={(e) => onContextNode(e, n)}
              tabIndex={0}
              role="treeitem"
              aria-selected={selected === n.path}
              aria-expanded={isDir ? !isCollapsed : undefined}
              onKeyDown={(e) => handleKeyDown(e, n)}
              title={n.path}
            >
              {isDir && (
                <span
                  style={{ color: "var(--fg-muted)", display: "inline-flex" }}
                >
                  {isCollapsed ? (
                    <IconChevronRight size={12} />
                  ) : (
                    <IconChevronDown size={12} />
                  )}
                </span>
              )}
              <span className="tree-node-icon">
                {isDir ? (
                  isCollapsed ? (
                    <IconFolder size={14} />
                  ) : (
                    <IconFolderOpen size={14} />
                  )
                ) : (
                  getLanguageIcon(n.name, 14)
                )}
              </span>
              <span className="tree-node-name">{n.name}</span>
              {nodeCollaborators.length > 0 && (
                <span
                  className="tree-node-collab-badge"
                  title={nodeCollaborators
                    .map((c: any) => `${c.name} (${c.activity?.type || "viewing"})`)
                    .join(", ")}
                  aria-label={`${nodeCollaborators.length} active collaborator(s)`}
                >
                  {nodeCollaborators.slice(0, 3).map((c: any) => (
                    <span
                      key={c.clientId}
                      className="tree-node-collab-dot"
                      style={{ backgroundColor: c.color }}
                    />
                  ))}
                  {nodeCollaborators.length > 3 && (
                    <span className="tree-node-collab-count">
                      +{nodeCollaborators.length - 3}
                    </span>
                  )}
                </span>
              )}
            </div>
            {isDir && n.children && !isCollapsed && (
              <div className="tree-children" role="group">
                <FileTreeNodes
                  nodes={n.children}
                  onSelect={onSelect}
                  selected={selected}
                  onContextNode={onContextNode}
                  collaboratorsByPath={collaboratorsByPath}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
