import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  Suspense,
} from "react";
import {
  User,
  Project,
  TreeNode,
  ContainerStats,
  UserPreferences,
} from "../../types";
import {
  api,
  getCapabilities,
  triggerAIAction,
  applyAIPatch,
  verifyAIPatch,
  AIVerificationRecord,
} from "../../api";
import Sidebar from "../Sidebar/Sidebar";
import Toolbar from "../Toolbar/Toolbar";
// Lazy: pulls in monaco-editor (~4.5MB raw); a static import here put that
// weight in the entry bundle, downloading before even the login screen showed.
const Editor = React.lazy(() => import("../Editor/Editor"));
// Type-only import: erased at compile time, so the lazy chunk boundary for
// Monaco is preserved while IDE stays typed against the live-content API.
import type { LiveContentApi } from "../Editor/Editor";
import Output from "../Output/Output";
import Terminal from "../Terminal/Terminal";
import Preview from "../Preview/Preview";
import ProblemsPanel from "../Output/ProblemsPanel";
import ResourcesView from "../Resources/ResourcesView";
import ProjectHealthModal from "../Health/ProjectHealthModal";
import SettingsModal, { DEFAULT_PREFERENCES } from "../Settings/SettingsModal";
const AIPatchModal = React.lazy(() => import("../AI/AIPatchModal"));
const AIExplainModal = React.lazy(() => import("../AI/AIExplainModal"));
import AIVerificationCard from "../AI/AIVerificationCard";
const Tour = React.lazy(() => import("../common/Tour"));
import CommandPaletteModal from "../common/CommandPaletteModal";
import { ErrorBoundary } from "../common/ErrorBoundary";
import WorkspaceSearchModal from "../Search/WorkspaceSearchModal";
import type {
  CollaborationClient,
  CollaboratorPresence,
  CollabConnectionStatus,
} from "../../collab/client";
import ProjectSharingModal from "../Collab/ProjectSharingModal";
import { CommandRegistry, Command } from "../../utils/commands";
import { buildFileIndex, IndexedFile } from "../../utils/fileIndex";
import {
  getRecentFiles,
  addRecentFile,
  addRecentProject,
} from "../../utils/recentStore";
import { Diagnostic, parseDiagnostics } from "../../utils/diagnostics";
import { useKeyboardShortcuts, IS_MAC } from "../../hooks/useKeyboardShortcuts";
import { throttleLatest } from "../../utils/throttleLatest";
import {
  IconTerminal,
  IconMonitor,
  IconCode,
  IconLayers,
  IconChevronDown,
  IconChevronRight,
  IconCheck,
  IconDocker,
  IconAlertTriangle,
  IconActivity,
} from "../common/Icons";

export default function IDE({
  user,
  onLogout,
  onSwitchToAdmin,
}: {
  user: User;
  onLogout: () => void;
  onSwitchToAdmin?: () => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [openFiles, setOpenFiles] = useState<
    { path: string; content: string; dirty?: boolean }[]
  >([]);
  const openFilesRef = useRef(openFiles);
  // Populated by the (lazily loaded) Editor on mount: the live Monaco model
  // registry that serves as the save-time source of truth. See M1.
  const liveApiRef = useRef<LiveContentApi | null>(null);
  const [bottomTab, setBottomTab] = useState<
    "output" | "problems" | "resources" | "terminal" | "preview"
  >("output");
  const [capabilities, setCapabilities] = useState<any>(null);
  const [stats, setStats] = useState<ContainerStats | null>(null);
  const [showTour, setShowTour] = useState(false);
  const [isHealthModalOpen, setIsHealthModalOpen] = useState(false);

  // M1: Command Palette & Quick Open States
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<"commands" | "files">("files");
  const [recentFilesList, setRecentFilesList] = useState<string[]>([]);
  const [registeredCommands, setRegisteredCommands] = useState<Command[]>([]);

  // M2: Full Workspace Search & Problems Diagnostics States
  const [isWorkspaceSearchOpen, setIsWorkspaceSearchOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [formatOnSave, setFormatOnSave] = useState<boolean>(() => {
    return localStorage.getItem("cloudeee_format_on_save") === "true";
  });

  // M22: User Preferences & Editor Settings States
  const [preferences, setPreferences] =
    useState<UserPreferences>(DEFAULT_PREFERENCES);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    api<{ preferences: UserPreferences }>("/api/auth/preferences")
      .then((r) => {
        if (r && r.preferences) {
          setPreferences(r.preferences);
        }
      })
      .catch((err) => {
        console.warn("Failed to load user preferences:", err);
      });
  }, []);

  const handleUpdatePreferences = async (updated: Partial<UserPreferences>) => {
    const res = await api<{ preferences: UserPreferences }>(
      "/api/auth/preferences",
      {
        method: "PUT",
        body: JSON.stringify(updated),
      },
    );
    if (res && res.preferences) {
      setPreferences(res.preferences);
    }
  };

  // Layout Sizing States (Resizable Sidebar & Bottom Panel)
  const [sidebarWidth, setSidebarWidth] = useState(250);
  const [isSidebarHidden, setIsSidebarHidden] = useState(false);
  const [bottomHeight, setBottomHeight] = useState(260);
  const [isBottomCollapsed, setIsBottomCollapsed] = useState(false);
  const [isDraggingSidebar, setIsDraggingSidebar] = useState(false);
  const [isDraggingBottom, setIsDraggingBottom] = useState(false);
  const [saveToast, setSaveToast] = useState<string | null>(null);

  // M4: Real-Time Multiplayer Collaboration States
  const [collabClient, setCollabClient] = useState<CollaborationClient | null>(
    null,
  );
  const collabClientRef = useRef<CollaborationClient | null>(null);
  const [collaborators, setCollaborators] = useState<CollaboratorPresence[]>(
    [],
  );
  const [collabStatus, setCollabStatus] =
    useState<CollabConnectionStatus>("disconnected");
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [projectRole, setProjectRole] = useState<"owner" | "editor" | "viewer">(
    "owner",
  );

  // M5: Verification-Aware AI Engineering Assistant States
  const [aiExplainState, setAiExplainState] = useState<{
    isOpen: boolean;
    title: string;
    rootCause?: string;
    explanation: string;
    evidence: string[];
    suggestedTests?: string;
    providerName?: string;
    providerType?: string;
    activeFilePath?: string;
    diagnostics?: any[];
  }>({
    isOpen: false,
    title: "AI Code Explanation",
    explanation: "",
    evidence: [],
  });

  const [aiPatchState, setAiPatchState] = useState<{
    isOpen: boolean;
    filePath: string;
    originalContent: string;
    modifiedContent: string;
    explanation: string;
    providerName?: string;
    providerType?: string;
    linesAdded: number;
    linesRemoved: number;
    baseRevision?: string;
  }>({
    isOpen: false,
    filePath: "",
    originalContent: "",
    modifiedContent: "",
    explanation: "",
    linesAdded: 0,
    linesRemoved: 0,
  });

  const [aiVerification, setAiVerification] =
    useState<AIVerificationRecord | null>(null);
  const [isAiLoading, setIsAiLoading] = useState(false);

  const isDemo = user.isDemo || user.username.startsWith("evaluator_");

  // Trigger onboarding tour for demo sessions
  useEffect(() => {
    if (isDemo && !localStorage.getItem("cloudeee_demo_tour_seen")) {
      setShowTour(true);
    }
  }, [isDemo]);

  // M4 Collaboration Lifecycle: Connect to /ws/collab for active project
  useEffect(() => {
    // Open tabs are per-project resources. Without this reset, switching
    // projects (e.g. owner -> newly forked project -> back) leaves stale
    // tabs open under the new project's identity. Monaco's model registry
    // is keyed by file path only (no project scoping), so a same-named file
    // left open across the switch reuses the OLD model instance; binding
    // the new project's (initially empty) collab Y.Text to that stale,
    // non-empty model then seeds the new doc with the wrong project's
    // content, and the real sync that follows merges rather than replaces
    // it — corrupting the new project's file with duplicated content. This
    // was found via manual QA: forking a project, then switching back to
    // the source, duplicated a source file's content on disk.
    setOpenFiles([]);
    setActiveFile(null);

    if (!project) {
      if (collabClientRef.current) {
        collabClientRef.current.dispose();
        collabClientRef.current = null;
        setCollabClient(null);
      }
      setCollaborators([]);
      setCollabStatus("disconnected");
      return;
    }

    let cancelled = false;
    let client: CollaborationClient | null = null;
    let unsubAwareness: (() => void) | undefined;
    let unsubConnection: (() => void) | undefined;
    let throttledSetCollaborators: ReturnType<
      typeof throttleLatest<CollaboratorPresence[]>
    > | null = null;

    (async () => {
      const { CollaborationClient } = await import("../../collab/client");
      if (cancelled) return;

      client = new CollaborationClient(project.id, user);
      collabClientRef.current = client;
      setCollabClient(client);

      // Remote cursor moves fire an awareness_change for every connected
      // collaborator on essentially every keystroke/click they make. Setting
      // state directly here would re-render this entire top-level IDE
      // component (and its whole child tree) at that same frequency.
      // Coalesce bursts into at most one state update per 200ms window,
      // always keeping the latest presence snapshot (see utils/throttleLatest).
      throttledSetCollaborators = throttleLatest<CollaboratorPresence[]>(
        setCollaborators,
        200,
      );
      unsubAwareness = client.on("awareness_change", throttledSetCollaborators);

      unsubConnection = client.on(
        "connection_change",
        (status: CollabConnectionStatus) => {
          setCollabStatus(status);
        },
      );
    })();

    // Fetch project access role
    api<{ project: Project; role?: "owner" | "editor" | "viewer" }>(
      `/api/projects/${project.id}`,
    )
      .then((res) => {
        if (res.role) setProjectRole(res.role);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unsubAwareness?.();
      unsubConnection?.();
      client?.dispose();
      if (collabClientRef.current === client) {
        collabClientRef.current = null;
      }
      throttledSetCollaborators?.cancel();
    };
    // project is tracked by id only to avoid reconnect churn when the object
    // reference changes without the id changing; collabClient is read via
    // collabClientRef to avoid a self-triggered reconnect loop (this effect
    // itself calls setCollabClient).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, user]);

  const loadProjects = useCallback(async () => {
    try {
      const res = await api<{ projects: Project[] }>("/api/projects");
      setProjects(res.projects);
      if (res.projects.length > 0 && !project) {
        setProject(res.projects[0]);
        addRecentProject(res.projects[0]);
      }
    } catch {}
  }, [project]);

  const loadTree = useCallback(async () => {
    if (!project) return;
    try {
      const res = await api<{ tree: TreeNode[] }>(
        `/api/projects/${project.id}/tree`,
      );
      setTree(res.tree);
    } catch {}
  }, [project]);

  // Track Recent Projects on Switch
  const handleSelectProject = (p: Project) => {
    setProject(p);
    addRecentProject(p);
  };

  // Sync Recent Files on Project Switch
  useEffect(() => {
    if (project) {
      setRecentFilesList(getRecentFiles(project.id));
    }
  }, [project]);

  // Memoized In-Memory File Index
  const fileIndex: IndexedFile[] = useMemo(() => {
    return buildFileIndex(tree);
  }, [tree]);

  // Live Telemetry Polling (Every 2.5s)
  useEffect(() => {
    if (!project) return;
    const fetchStats = async () => {
      try {
        const res = await api<{ stats: ContainerStats }>(
          `/api/projects/${project.id}/stats`,
        );
        setStats(res.stats);
      } catch {}
    };
    fetchStats();
    const timer = setInterval(fetchStats, 2500);
    return () => clearInterval(timer);
  }, [project?.id]);

  useEffect(() => {
    loadProjects();
    getCapabilities()
      .then(setCapabilities)
      .catch(() => {});
  }, [loadProjects]);

  useEffect(() => {
    if (project) {
      loadTree();
    }
  }, [project, loadTree]);

  const handleOpenFile = async (path: string) => {
    if (!project) return;

    // Record into recent store
    addRecentFile(project.id, path);
    setRecentFilesList(getRecentFiles(project.id));

    const existing = openFiles.find((f) => f.path === path);
    if (existing) {
      setActiveFile(path);
      return;
    }

    try {
      const res = await api<{ content: string }>(
        `/api/projects/${project.id}/file?path=${encodeURIComponent(path)}`,
      );
      setOpenFiles((prev) => [...prev, { path, content: res.content }]);
      setActiveFile(path);
    } catch (err: any) {
      alert(`Could not open file: ${err.message || "Error"}`);
    }
  };

  useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);

  // ---------------------------------------------------------------------------
  // M1 truthful-content resolution.
  //
  // Since cc55a1a, `openFiles[].content` freezes at file-open time (keystrokes
  // only flip `dirty` to avoid render churn), so React state must never be
  // treated as save-time truth. Resolution order:
  //   1. live Monaco model — what the user actually sees right now;
  //   2. Yjs document — for dirty files whose model was torn down while a
  //      collaboration room holds newer content than disk/state;
  //   3. stored snapshot — last resort; only ever correct for clean buffers
  //      or when neither of the above exists.
  // Returns null when nothing can vouch for the content, which callers must
  // treat as "do not save".
  const resolveLiveFileContent = useCallback((path: string): string | null => {
    const live = liveApiRef.current?.get(path);
    if (live !== null && live !== undefined) return live;

    const stored = openFilesRef.current.find((f) => f.path === path);
    if (!stored) return null;

    if (stored.dirty && collabClientRef.current) {
      try {
        return collabClientRef.current.doc.getText(path).toString();
      } catch {
        // fall through to the stored snapshot
      }
    }
    return stored.content;
  }, []);

  // Single funnel for every Ctrl+S / palette / programmatic save trigger:
  // dispatch the ide-save contract with an authoritative path. The ide-save
  // listener resolves the content itself (live-model first), so no dispatcher
  // can ever smuggle stale bytes into the persistence path.
  const dispatchCanonicalSave = useCallback(
    (explicitPath?: string) => {
      const path = explicitPath ?? activeFile;
      if (!project || !path) return;
      document.dispatchEvent(new CustomEvent("ide-save", { detail: { path } }));
    },
    [project, activeFile],
  );

  // M2: Format Document handler
  const handleFormatDocument = useCallback(
    async (targetFilePath?: string) => {
      const fileToFormat = targetFilePath || activeFile;
      if (!project || !fileToFormat) return;

      const targetFile = openFilesRef.current.find(
        (f) => f.path === fileToFormat,
      );
      if (!targetFile) return;

      try {
        const res = await api<{
          formatted: string;
          changed: boolean;
          formatter: string;
          warning?: string;
        }>(`/api/projects/${project.id}/format`, {
          method: "POST",
          body: JSON.stringify({
            path: targetFile.path,
            // M1: format what the user actually sees, not the stale snapshot.
            content:
              resolveLiveFileContent(targetFile.path) ?? targetFile.content,
          }),
        });

        if (res.changed) {
          // Apply to the live model FIRST so both modes converge visibly:
          // solo — the model now matches the state update below; collab —
          // the model edit propagates through y-monaco into the room's
          // Y.Text and out to every peer. State-only updates would desync
          // here (the external-sync effect skips dirty buffers).
          // Routed through liveApiRef (not a value import) so this file never
          // pulls the Editor/Monaco chunk out of its lazy boundary.
          const appliedToModel = liveApiRef.current?.apply(
            targetFile.path,
            res.formatted,
          );
          void appliedToModel;
          setOpenFiles((prev) =>
            prev.map((f) =>
              f.path === targetFile.path
                ? { ...f, content: res.formatted, dirty: true }
                : f,
            ),
          );
          setSaveToast(`Formatted with ${res.formatter}`);
          setTimeout(() => setSaveToast(null), 2000);
        } else if (res.warning) {
          setSaveToast(`Format note: ${res.warning}`);
          setTimeout(() => setSaveToast(null), 3000);
        }
      } catch (err: any) {
        console.warn("Formatting skipped:", err.message);
      }
    },
    [project, activeFile, resolveLiveFileContent],
  );

  // M1: Ctrl+S / palette saves funnel through dispatchCanonicalSave → the
  // ide-save listener below, which resolves content from the live editor
  // model. The former direct-POST implementation read `openFiles[].content`,
  // which has been stale-during-typing since cc55a1a and silently persisted
  // file-open-time bytes (BUG-1).
  const handleSaveActiveFile = useCallback(() => {
    dispatchCanonicalSave();
  }, [dispatchCanonicalSave]);

  // M1 canonical save listener: the ONLY code path that POSTs file contents.
  // Content is re-resolved here from the live editor model regardless of what
  // the dispatcher attached, so every trigger (Monaco command, global
  // shortcut, palette, future callers) shares one truthful contract.
  useEffect(() => {
    const handleSave = async (e: Event) => {
      const detail = ((e as CustomEvent).detail ?? {}) as {
        path?: string;
        content?: string;
      };
      const path = typeof detail.path === "string" ? detail.path : null;
      if (!project || !path) return;

      let finalContent = resolveLiveFileContent(path);
      if (
        (finalContent === null || finalContent === undefined) &&
        typeof detail.content === "string"
      ) {
        // Back-compat for dispatchers that pre-resolve content.
        finalContent = detail.content;
      }
      if (typeof finalContent !== "string") {
        alert(`Save failed: no live content available for ${path}`);
        return;
      }

      // If Format on Save is enabled, format the live content prior to saving.
      // Post-save convergence is automatic in both modes: solo — the external
      // sync effect setValue()s the formatted bytes into the model once the
      // buffer is marked clean; collab — notifyExternalFileMutation() on the
      // server flows the formatted bytes back through Yjs into every model.
      if (formatOnSave) {
        try {
          const res = await api<{ formatted: string; changed: boolean }>(
            `/api/projects/${project.id}/format`,
            {
              method: "POST",
              body: JSON.stringify({ path, content: finalContent }),
            },
          );
          if (res.changed) finalContent = res.formatted;
        } catch {}
      }

      try {
        await api(`/api/projects/${project.id}/file`, {
          method: "POST",
          body: JSON.stringify({ path, content: finalContent }),
        });
        setOpenFiles((prev) =>
          prev.map((f) =>
            f.path === path ? { ...f, content: finalContent, dirty: false } : f,
          ),
        );
        setSaveToast(`Saved ${path.split("/").pop()}`);
        setTimeout(() => setSaveToast(null), 2000);
      } catch (err: any) {
        alert(`Save failed: ${err.message}`);
      }
    };

    document.addEventListener("ide-save", handleSave);
    return () => document.removeEventListener("ide-save", handleSave);
  }, [project, formatOnSave, resolveLiveFileContent]);

  // Listen to ide-run event from Toolbar
  useEffect(() => {
    const handleRunRequest = async (e: Event) => {
      const {
        language,
        activeFile: reqFile,
        langDisplay,
      } = (e as CustomEvent).detail;
      if (!project) return;

      // Auto-save dirty files before executing. M1: content comes from the
      // live editor model (openFiles[].content is stale during typing), and
      // only files whose save actually succeeded are marked clean — the old
      // code cleared `dirty` even when the POST threw.
      const dirtyFiles = openFiles.filter((f) => f.dirty);
      const savedContents = new Map<string, string>();
      for (const f of dirtyFiles) {
        const content = resolveLiveFileContent(f.path);
        if (content === null) continue;
        try {
          await api(`/api/projects/${project.id}/file`, {
            method: "POST",
            body: JSON.stringify({ path: f.path, content }),
          });
          savedContents.set(f.path, content);
        } catch {}
      }
      setOpenFiles((prev) =>
        prev.map((f) => {
          const saved = savedContents.get(f.path);
          return saved !== undefined
            ? { ...f, content: saved, dirty: false }
            : f;
        }),
      );

      // Switch to output tab and expand drawer if collapsed
      setBottomTab("output");
      setIsBottomCollapsed(false);

      // Dispatch confirmed execution event
      document.dispatchEvent(
        new CustomEvent("ide-run-confirmed", {
          detail: { language, activeFile: reqFile, langDisplay },
        }),
      );
    };

    document.addEventListener("ide-run", handleRunRequest);
    return () => document.removeEventListener("ide-run", handleRunRequest);
  }, [project, openFiles, resolveLiveFileContent]);

  // M43: Output (which owns the actual install request/stream) only exists
  // in the DOM while bottomTab === "output" and the panel isn't collapsed —
  // the same reason ide-run above must switch to that tab before its
  // *-confirmed event fires, or the listener that would handle it won't be
  // mounted yet. Install has no async dirty-file-save gate like Run does,
  // so this handler is a synchronous, minimal echo of that same fix.
  useEffect(() => {
    const handleInstallRequest = () => {
      if (!project) return;
      setBottomTab("output");
      setIsBottomCollapsed(false);
      document.dispatchEvent(new Event("ide-install-confirmed"));
    };

    document.addEventListener("ide-install", handleInstallRequest);
    return () =>
      document.removeEventListener("ide-install", handleInstallRequest);
  }, [project]);

  // Listen for execution completion events to parse compiler/runtime diagnostics
  useEffect(() => {
    const handleExecutionResult = (e: Event) => {
      const {
        result,
        activeFile: runFile,
        language,
      } = (e as CustomEvent).detail || {};
      if (!result) return;

      const rawCombined = `${result.stdout || ""}\n${result.stderr || ""}`;
      const newDiags = parseDiagnostics(rawCombined, language, runFile);

      if (newDiags.length > 0) {
        setDiagnostics(newDiags);
        // Automatically reveal Problems tab if compiler error occurred
        if (result.type === "compile_error" || result.exitCode !== 0) {
          setBottomTab("problems");
          setIsBottomCollapsed(false);
        }
      } else if (result.type === "success" && result.exitCode === 0) {
        // Clear diagnostics on clean execution
        setDiagnostics([]);
      }
    };

    document.addEventListener("ide-execution-result", handleExecutionResult);
    return () =>
      document.removeEventListener(
        "ide-execution-result",
        handleExecutionResult,
      );
  }, []);

  // M5: AI Action Trigger Handler
  const handleTriggerAIAction = useCallback(
    async (
      action: string,
      params?: {
        path?: string;
        selectedCode?: string;
        selectionRange?: any;
        diagnostics?: any[];
        searchQuery?: string;
      },
    ) => {
      if (!project) return;
      const targetFile = params?.path || activeFile;
      if (!targetFile) {
        alert("Please open or select a file first.");
        return;
      }

      setIsAiLoading(true);
      try {
        const res = await triggerAIAction(project.id, {
          action,
          activeFilePath: targetFile,
          selectedCode: params?.selectedCode,
          selectionRange: params?.selectionRange,
          diagnostics:
            params?.diagnostics ||
            diagnostics.filter((d) => d.filePath === targetFile),
          searchQuery: params?.searchQuery,
        });

        const resp = res.response;

        if (resp.patch) {
          setAiPatchState({
            isOpen: true,
            filePath: resp.patch.filePath,
            originalContent: resp.patch.originalContent,
            modifiedContent: resp.patch.modifiedContent,
            explanation: resp.patch.explanation,
            providerName: resp.modelName,
            providerType: resp.providerType,
            linesAdded: resp.patch.linesAdded,
            linesRemoved: resp.patch.linesRemoved,
            baseRevision: resp.patch.baseRevision,
          });
        } else {
          setAiExplainState({
            isOpen: true,
            title: `AI Analysis: ${action.replace(/_/g, " ").toUpperCase()}`,
            rootCause: resp.rootCause,
            explanation: resp.explanation,
            evidence: resp.evidence || [],
            suggestedTests: resp.suggestedTests,
            providerName: resp.modelName,
            providerType: resp.providerType,
            activeFilePath: targetFile,
            diagnostics: params?.diagnostics,
          });
        }
      } catch (err: any) {
        alert(`AI Action Failed: ${err.message || "Error"}`);
      } finally {
        setIsAiLoading(false);
      }
    },
    [project, activeFile, diagnostics],
  );

  // M5: AI Patch Acceptance Handler with Snapshot Safety & Sandbox Verification
  const handleAcceptAIPatch = async ({
    runVerification,
    createSnapshot,
  }: {
    runVerification: boolean;
    createSnapshot: boolean;
  }) => {
    if (!project || !aiPatchState.filePath) return;

    try {
      const applyRes = await applyAIPatch(project.id, {
        filePath: aiPatchState.filePath,
        content: aiPatchState.modifiedContent,
        createSafetySnapshot: createSnapshot,
        explanation: aiPatchState.explanation,
        baseRevision: aiPatchState.baseRevision || "",
      });

      // Update in local openFiles state
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.path === aiPatchState.filePath
            ? { ...f, content: aiPatchState.modifiedContent, dirty: false }
            : f,
        ),
      );

      setAiPatchState((prev) => ({ ...prev, isOpen: false }));
      loadTree();

      // Execute Sandbox Verification Pipeline
      const verifRes = await verifyAIPatch(project.id, {
        action: "patch_verification",
        providerType: aiPatchState.providerType || "deterministic",
        modelName: aiPatchState.providerName || "Deterministic-Engine",
        filePath: aiPatchState.filePath,
        explanation: aiPatchState.explanation,
        diffSummary: `+${aiPatchState.linesAdded} -${aiPatchState.linesRemoved} lines`,
        snapshotId: applyRes.snapshotId,
        skipVerification: !runVerification,
      });

      setAiVerification(verifRes.verification);
    } catch (err: any) {
      if (err.code === "stale_patch") {
        alert(
          "This file changed since the AI patch was generated. Please re-run the AI action to get an updated patch.",
        );
        setAiPatchState((prev) => ({ ...prev, isOpen: false }));
        return;
      }
      alert(`Failed to apply patch: ${err.message || "Error"}`);
    }
  };

  // Listen to ide-ai-action CustomEvent from Editor / Output / Problems
  useEffect(() => {
    const handleAIEvent = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && detail.action) {
        handleTriggerAIAction(detail.action, detail);
      }
    };
    document.addEventListener("ide-ai-action", handleAIEvent);
    return () => document.removeEventListener("ide-ai-action", handleAIEvent);
  }, [project, activeFile, diagnostics, handleTriggerAIAction]);

  // Register Extensible IDE Commands in Registry
  useEffect(() => {
    const registry = CommandRegistry.getInstance();

    const commands: Command[] = [
      // Navigation
      {
        id: "workbench.action.quickOpen",
        title: "Quick Open File",
        description: "Search and open workspace files by name",
        category: "Navigation",
        shortcut: "Ctrl+P",
        macShortcut: "⌘P",
        handler: () => {
          setPaletteMode("files");
          setIsPaletteOpen(true);
        },
      },
      {
        id: "workbench.action.showCommands",
        title: "Command Palette",
        description: "Show and run IDE commands",
        category: "Navigation",
        shortcut: "Ctrl+Shift+P",
        macShortcut: "⇧⌘P",
        handler: () => {
          setPaletteMode("commands");
          setIsPaletteOpen(true);
        },
      },
      {
        id: "workbench.action.searchWorkspace",
        title: "Search Text in Workspace Files",
        description: "Find text occurrences across all project files",
        category: "Navigation",
        shortcut: "Ctrl+Shift+F",
        macShortcut: "⇧⌘F",
        handler: () => {
          setIsWorkspaceSearchOpen(true);
        },
      },
      // Execution
      {
        id: "execution.action.run",
        title: "Run Current File",
        description: "Execute active file in isolated Docker sandbox",
        category: "Execution",
        shortcut: "Ctrl+Enter",
        macShortcut: "⌘↵",
        available: () => !!project && !!activeFile,
        handler: () => {
          const btn = document.querySelector(
            ".btn-run",
          ) as HTMLButtonElement | null;
          btn?.click();
        },
      },
      {
        id: "execution.action.stop",
        title: "Stop Active Execution",
        description: "Terminate in-flight process execution",
        category: "Execution",
        handler: () => {
          const btn = document.querySelector(
            ".btn-stop",
          ) as HTMLButtonElement | null;
          btn?.click();
        },
      },
      {
        id: "execution.action.openTerminal",
        title: "Switch to Interactive Terminal",
        description: "Attach interactive XTerm shell to sandbox container",
        category: "Execution",
        handler: () => {
          setBottomTab("terminal");
          setIsBottomCollapsed(false);
        },
      },
      {
        id: "execution.action.openOutput",
        title: "Switch to Execution Output",
        description: "View build, compilation and execution logs",
        category: "Execution",
        handler: () => {
          setBottomTab("output");
          setIsBottomCollapsed(false);
        },
      },
      {
        id: "execution.action.openProblems",
        title: "Switch to Problems & Diagnostics Panel",
        description: "View compiler errors, warnings, and code diagnostics",
        category: "Execution",
        handler: () => {
          setBottomTab("problems");
          setIsBottomCollapsed(false);
        },
      },
      {
        id: "execution.action.openPreview",
        title: "Switch to Web Server Preview",
        description: "Render running web server in sandboxed iframe",
        category: "Execution",
        handler: () => {
          setBottomTab("preview");
          setIsBottomCollapsed(false);
        },
      },
      {
        id: "execution.action.openResources",
        title: "Switch to Resource Intelligence & Metrics",
        description:
          "View real-time and historical CPU, memory, PID, and I/O time-series charts",
        category: "Execution",
        handler: () => {
          setBottomTab("resources");
          setIsBottomCollapsed(false);
        },
      },
      {
        id: "workbench.action.openProjectHealth",
        title: "Open Project Health Center",
        description:
          "Inspect runtime status, daily reliability scores, and active anomaly journal",
        category: "UI",
        handler: () => setIsHealthModalOpen(true),
      },
      // Editor / Formatting
      {
        id: "editor.action.formatDocument",
        title: "Format Document",
        description: "Format active document using language formatter",
        category: "UI",
        shortcut: "Shift+Alt+F",
        macShortcut: "⇧⌥F",
        available: () => !!activeFile,
        handler: () => handleFormatDocument(),
      },
      {
        id: "editor.action.toggleFormatOnSave",
        title: `Toggle Format on Save (${formatOnSave ? "Currently Enabled" : "Currently Disabled"})`,
        description: "Automatically format files on save",
        category: "UI",
        handler: () => {
          setFormatOnSave((prev) => {
            const next = !prev;
            localStorage.setItem("cloudeee_format_on_save", String(next));
            setSaveToast(`Format on Save: ${next ? "Enabled" : "Disabled"}`);
            setTimeout(() => setSaveToast(null), 2500);
            return next;
          });
        },
      },
      {
        id: "workbench.action.toggleSidebar",
        title: "Toggle Sidebar",
        description: "Show or hide the workspace file tree",
        category: "UI",
        shortcut: "Ctrl+B",
        macShortcut: "⌘B",
        handler: () => setIsSidebarHidden((prev) => !prev),
      },
      {
        id: "workbench.action.toggleBottomPanel",
        title: "Toggle Bottom Console Drawer",
        description: "Expand or collapse the output/terminal drawer",
        category: "UI",
        shortcut: "Ctrl+J",
        macShortcut: "⌘J",
        handler: () => setIsBottomCollapsed((prev) => !prev),
      },
      {
        id: "workbench.action.saveFile",
        title: "Save Active File",
        description: "Save dirty buffer to workspace disk storage",
        category: "UI",
        shortcut: "Ctrl+S",
        macShortcut: "⌘S",
        available: () => !!activeFile,
        handler: () => handleSaveActiveFile(),
      },
      {
        id: "workbench.action.shareProject",
        title: "Share Project & Manage Collaborators",
        description:
          "Invite teammates and manage real-time Editor/Viewer permissions",
        category: "Collaboration",
        available: () => !!project,
        handler: () => setIsShareModalOpen(true),
      },
      {
        id: "workbench.action.openTour",
        title: "Guided Evaluator Walkthrough Tour",
        description:
          "Launch interactive onboarding tour for Cloud IDE concepts",
        category: "UI",
        handler: () => setShowTour(true),
      },
      // AI Engineering Assistant Commands
      {
        id: "workbench.action.aiExplainSelection",
        title: "AI: Explain Code / Selection",
        description: "Analyze active file AST, diagnostics, and root causes",
        category: "AI",
        available: () => !!activeFile,
        handler: () => handleTriggerAIAction("explain"),
      },
      {
        id: "workbench.action.aiFixProblem",
        title: "AI: Fix Active Problem / Error",
        description:
          "Propose automated fix patch for compiler/runtime diagnostic",
        category: "AI",
        available: () => !!activeFile,
        handler: () => handleTriggerAIAction("fix_error"),
      },
      {
        id: "workbench.action.aiRefactor",
        title: "AI: Refactor Code",
        description: "Enhance structure, clarity, and idioms",
        category: "AI",
        available: () => !!activeFile,
        handler: () => handleTriggerAIAction("refactor"),
      },
      {
        id: "workbench.action.aiGenerateTests",
        title: "AI: Generate Unit Test Suite",
        description: "Synthesize comprehensive test cases covering edge cases",
        category: "AI",
        available: () => !!activeFile,
        handler: () => handleTriggerAIAction("generate_tests"),
      },
      {
        id: "workbench.action.aiOptimize",
        title: "AI: Optimize Code Performance",
        description: "Refactor algorithms and eliminate redundant operations",
        category: "AI",
        available: () => !!activeFile,
        handler: () => handleTriggerAIAction("optimize"),
      },
      {
        id: "workbench.action.aiDocstring",
        title: "AI: Generate Documentation & Docstring",
        description: "Generate structured documentation header",
        category: "AI",
        available: () => !!activeFile,
        handler: () => handleTriggerAIAction("docstring"),
      },
      {
        id: "workbench.action.aiCommitMessage",
        title: "AI: Generate Conventional Commit Message",
        description: "Draft conventional commit message for changes",
        category: "AI",
        available: () => !!activeFile,
        handler: () => handleTriggerAIAction("commit_message"),
      },
    ];

    // Admin Command
    if (user.role === "admin" && onSwitchToAdmin) {
      commands.push({
        id: "admin.action.openControlPlane",
        title: "Open Admin Control Plane",
        description: "Manage tenants, sandboxes, and view system health",
        category: "Admin",
        handler: () => onSwitchToAdmin(),
      });
    }

    const unregister = registry.registerMany(commands);
    setRegisteredCommands(registry.getAll());

    const unsubscribe = registry.subscribe(() => {
      setRegisteredCommands(registry.getAll());
    });

    return () => {
      unregister();
      unsubscribe();
    };
  }, [
    project,
    activeFile,
    user.role,
    onSwitchToAdmin,
    formatOnSave,
    handleFormatDocument,
    handleSaveActiveFile,
    handleTriggerAIAction,
  ]);

  // Central Keyboard Shortcuts Dispatcher
  useKeyboardShortcuts({
    onOpenCommandPalette: () => {
      setPaletteMode("commands");
      setIsPaletteOpen(true);
    },
    onOpenQuickOpen: () => {
      setPaletteMode("files");
      setIsPaletteOpen(true);
    },
    // M1: the hook dispatches the canonical ide-save event itself using this
    // path accessor; the listener below resolves live content and persists.
    getActiveFile: () => activeFile,
    onToggleSidebar: () => {
      setIsSidebarHidden((prev) => !prev);
    },
    onToggleBottomPanel: () => {
      setIsBottomCollapsed((prev) => !prev);
    },
  });

  // Global key listener for Ctrl+Shift+F (Workspace Search) and Shift+Alt+F (Format Document)
  useEffect(() => {
    const handleGlobalExtraShortcuts = (e: KeyboardEvent) => {
      const isMod = IS_MAC ? e.metaKey : e.ctrlKey;

      // Workspace Search: Ctrl+Shift+F / Cmd+Shift+F
      if (isMod && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        setIsWorkspaceSearchOpen(true);
        return;
      }

      // Format Document: Shift+Alt+F
      if (e.shiftKey && e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        handleFormatDocument();
        return;
      }
    };

    window.addEventListener("keydown", handleGlobalExtraShortcuts, {
      capture: true,
    });
    return () =>
      window.removeEventListener("keydown", handleGlobalExtraShortcuts, {
        capture: true,
      });
  }, [activeFile, project, handleFormatDocument]);

  // Horizontal Sidebar Drag Resizer
  const handleSidebarMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingSidebar(true);
  };

  // Vertical Bottom Panel Drag Resizer
  const handleBottomMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingBottom(true);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDraggingSidebar) {
        const newWidth = Math.max(180, Math.min(e.clientX, 500));
        setSidebarWidth(newWidth);
      } else if (isDraggingBottom) {
        const newHeight = Math.max(
          120,
          Math.min(window.innerHeight - e.clientY, 600),
        );
        setBottomHeight(newHeight);
      }
    };

    const handleMouseUp = () => {
      setIsDraggingSidebar(false);
      setIsDraggingBottom(false);
    };

    if (isDraggingSidebar || isDraggingBottom) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDraggingSidebar, isDraggingBottom]);

  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter(
    (d) => d.severity === "warning",
  ).length;

  return (
    <div className="ide-layout">
      {/* Liquid Glass Sidebar */}
      {!isSidebarHidden && (
        <Sidebar
          user={user}
          projects={projects}
          project={project}
          onSelectProject={handleSelectProject}
          onCreateProject={loadProjects}
          tree={tree}
          onOpenFile={handleOpenFile}
          activeFile={activeFile}
          onLogout={onLogout}
          refreshTree={loadTree}
          width={sidebarWidth}
          onOpenTour={() => setShowTour(true)}
          onOpenSettings={() => setShowSettings(true)}
        />
      )}

      {/* Horizontal Resizer Bar */}
      {!isSidebarHidden && (
        <div
          className={`resizer-h ${isDraggingSidebar ? "dragging" : ""}`}
          onMouseDown={handleSidebarMouseDown}
        />
      )}

      {/* Main Workspace Area */}
      <main className="ide-main">
        {/* Liquid Glass Top Toolbar with Telemetry HUD, Quick Search & Admin Switcher */}
        <Toolbar
          project={project}
          activeFile={activeFile}
          capabilities={capabilities}
          stats={stats}
          user={user}
          onSwitchToAdmin={onSwitchToAdmin}
          onOpenQuickOpen={() => {
            setPaletteMode("files");
            setIsPaletteOpen(true);
          }}
          onOpenCommandPalette={() => {
            setPaletteMode("commands");
            setIsPaletteOpen(true);
          }}
          onOpenHealthModal={() => setIsHealthModalOpen(true)}
          collaborators={collaborators}
          collabStatus={collabStatus}
          onOpenShareModal={() => setIsShareModalOpen(true)}
          onFollowCollaborator={(c) => {
            if (c.activeFile) {
              handleOpenFile(c.activeFile);
            }
          }}
        />

        {/* Central Editor & Bottom Workspace */}
        <div className="ide-workspace" style={{ flexDirection: "column" }}>
          <div className="ide-editor-area">
            <ErrorBoundary label="Editor">
              <Suspense
                fallback={
                  <div
                    style={{
                      display: "flex",
                      height: "100%",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <div
                      style={{
                        width: "24px",
                        height: "24px",
                        border: "3px solid var(--border)",
                        borderTopColor: "var(--accent)",
                        borderRadius: "50%",
                        animation: "editor-suspense-spin 1s linear infinite",
                      }}
                    />
                    <style>{`@keyframes editor-suspense-spin { to { transform: rotate(360deg); } }`}</style>
                  </div>
                }
              >
                <Editor
                  project={project}
                  openFiles={openFiles}
                  setOpenFiles={setOpenFiles}
                  activeFile={activeFile}
                  setActiveFile={setActiveFile}
                  diagnostics={diagnostics}
                  collabClient={collabClient}
                  isReadOnly={projectRole === "viewer"}
                  liveApiRef={liveApiRef}
                  preferences={preferences}
                  onCreateFile={() => {
                    const el = document.querySelector(
                      'button[title="New File"]',
                    ) as HTMLButtonElement;
                    el?.click();
                  }}
                />
              </Suspense>
            </ErrorBoundary>
          </div>

          {/* Vertical Resizer Bar */}
          {!isBottomCollapsed && (
            <div
              className={`resizer-v ${isDraggingBottom ? "dragging" : ""}`}
              onMouseDown={handleBottomMouseDown}
            />
          )}

          {/* Liquid Glass Bottom Panel Drawer */}
          <div
            className="ide-bottom-panel"
            style={{
              height: isBottomCollapsed ? "38px" : `${bottomHeight}px`,
              minHeight: isBottomCollapsed ? "38px" : "120px",
            }}
          >
            {/* Panel Tabs Header */}
            <div className="panel-tabs-header">
              <div className="panel-tabs" role="tablist">
                <button
                  className={`panel-tab ${bottomTab === "output" && !isBottomCollapsed ? "active" : ""}`}
                  onClick={() => {
                    setBottomTab("output");
                    setIsBottomCollapsed(false);
                  }}
                  role="tab"
                >
                  <IconCode size={12} />
                  <span>Output & History</span>
                </button>

                <button
                  className={`panel-tab ${bottomTab === "problems" && !isBottomCollapsed ? "active" : ""}`}
                  onClick={() => {
                    setBottomTab("problems");
                    setIsBottomCollapsed(false);
                  }}
                  role="tab"
                >
                  <IconAlertTriangle
                    size={12}
                    color={
                      errorCount > 0
                        ? "#f38ba8"
                        : warningCount > 0
                          ? "#f9e2af"
                          : "currentColor"
                    }
                  />
                  <span>Problems</span>
                  {diagnostics.length > 0 && (
                    <span
                      className={`glass-badge ${errorCount > 0 ? "glass-badge-error" : "glass-badge-warning"}`}
                      style={{
                        fontSize: "9px",
                        padding: "1px 5px",
                        marginLeft: "4px",
                      }}
                    >
                      {diagnostics.length}
                    </span>
                  )}
                </button>

                <button
                  className={`panel-tab ${bottomTab === "resources" && !isBottomCollapsed ? "active" : ""}`}
                  onClick={() => {
                    setBottomTab("resources");
                    setIsBottomCollapsed(false);
                  }}
                  role="tab"
                >
                  <IconActivity size={12} color="var(--accent)" />
                  <span>Resources</span>
                </button>

                <button
                  className={`panel-tab ${bottomTab === "terminal" && !isBottomCollapsed ? "active" : ""}`}
                  onClick={() => {
                    setBottomTab("terminal");
                    setIsBottomCollapsed(false);
                  }}
                  role="tab"
                >
                  <IconTerminal size={12} />
                  <span>Terminal</span>
                </button>

                <button
                  className={`panel-tab ${bottomTab === "preview" && !isBottomCollapsed ? "active" : ""}`}
                  onClick={() => {
                    setBottomTab("preview");
                    setIsBottomCollapsed(false);
                  }}
                  role="tab"
                >
                  <IconMonitor size={12} />
                  <span>Web Preview</span>
                </button>
              </div>

              <div className="panel-actions">
                <button
                  className="glass-btn glass-btn-icon"
                  onClick={() => setIsBottomCollapsed(!isBottomCollapsed)}
                  title={isBottomCollapsed ? "Expand Panel" : "Collapse Panel"}
                  aria-label={
                    isBottomCollapsed ? "Expand Panel" : "Collapse Panel"
                  }
                >
                  {isBottomCollapsed ? (
                    <IconChevronRight size={13} />
                  ) : (
                    <IconChevronDown size={13} />
                  )}
                </button>
              </div>
            </div>

            {/* Panel Content Display */}
            {!isBottomCollapsed && (
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                {bottomTab === "output" && (
                  <Output project={project} onRefreshTree={loadTree} />
                )}
                {bottomTab === "problems" && (
                  <ProblemsPanel
                    diagnostics={diagnostics}
                    onSelectDiagnostic={(filePath, line, column) => {
                      document.dispatchEvent(
                        new CustomEvent("ide-reveal-location", {
                          detail: { filePath, line, column },
                        }),
                      );
                    }}
                    onClearDiagnostics={() => setDiagnostics([])}
                    onExplainDiagnostic={(diag) => {
                      handleTriggerAIAction("explain", {
                        path: diag.filePath,
                        diagnostics: [diag],
                      });
                    }}
                    onFixDiagnostic={(diag) => {
                      handleTriggerAIAction("fix_error", {
                        path: diag.filePath,
                        diagnostics: [diag],
                      });
                    }}
                  />
                )}
                {bottomTab === "resources" && (
                  <ResourcesView project={project} />
                )}
                {bottomTab === "terminal" && <Terminal project={project} />}
                {bottomTab === "preview" && <Preview project={project} />}
              </div>
            )}
          </div>
        </div>

        {/* AI Verification Outcome Banner / Notification */}
        {aiVerification && (
          <div
            style={{
              position: "fixed",
              bottom: "40px",
              right: "24px",
              zIndex: 9000,
              maxWidth: "460px",
              width: "100%",
            }}
          >
            <AIVerificationCard
              status={aiVerification.status}
              action={aiVerification.action}
              filePath={aiVerification.file_path || "workspace"}
              explanation={
                aiVerification.explanation || "Verification Complete"
              }
              exitCode={aiVerification.exit_code}
              stdoutSummary={aiVerification.stdout_summary}
              stderrSummary={aiVerification.stderr_summary}
              skipReason={aiVerification.skip_reason}
              durationMs={aiVerification.duration_ms}
              providerType={aiVerification.provider_type}
              onDismiss={() => setAiVerification(null)}
            />
          </div>
        )}

        {/* Liquid Glass Status Bar Footer */}
        <footer className="ide-statusbar">
          <div className="ide-statusbar-section">
            <span className="ide-statusbar-item" title="Active Project">
              <IconLayers size={11} />
              <span>{project ? project.name : "No workspace"}</span>
            </span>
            <span className="ide-statusbar-item" title="Docker Sandbox">
              <IconDocker size={11} />
              <span>Docker Runner</span>
            </span>
            {isAiLoading && (
              <span
                className="glass-badge glass-badge-info"
                style={{ fontSize: "9px", padding: "1px 6px" }}
              >
                AI REASONING…
              </span>
            )}
            {isDemo && (
              <span
                className="glass-badge glass-badge-success"
                style={{ fontSize: "9px", padding: "1px 6px" }}
              >
                DEMO SESSION
              </span>
            )}
          </div>

          <div className="ide-statusbar-section">
            {saveToast && (
              <span
                className="glass-badge glass-badge-success"
                style={{ animation: "fadeIn 150ms ease" }}
              >
                <IconCheck size={9} />
                <span>{saveToast}</span>
              </span>
            )}
            <span
              className="ide-statusbar-item"
              onClick={() => {
                setFormatOnSave(!formatOnSave);
                localStorage.setItem(
                  "cloudeee_format_on_save",
                  String(!formatOnSave),
                );
                setSaveToast(`Format on Save: ${!formatOnSave ? "On" : "Off"}`);
                setTimeout(() => setSaveToast(null), 2000);
              }}
              style={{ cursor: "pointer" }}
              title="Click to toggle Format on Save"
            >
              {formatOnSave ? "Format: On" : "Format: Off"}
            </span>
            <span className="ide-statusbar-item">UTF-8</span>
            <span className="ide-statusbar-item">LF</span>
            <span
              className="ide-statusbar-item"
              style={{ color: "var(--accent)" }}
            >
              {activeFile
                ? activeFile.split(".").pop()?.toUpperCase()
                : "Plain Text"}
            </span>
          </div>
        </footer>
      </main>

      {/* Reusable Command Palette & Quick Open Modal */}
      <CommandPaletteModal
        isOpen={isPaletteOpen}
        initialMode={paletteMode}
        onClose={() => setIsPaletteOpen(false)}
        fileIndex={fileIndex}
        recentFiles={recentFilesList}
        onOpenFile={handleOpenFile}
        commands={registeredCommands}
        onExecuteCommand={(id) => {
          CommandRegistry.getInstance().execute(id);
        }}
      />

      {/* Full Workspace Text Search Modal */}
      <WorkspaceSearchModal
        isOpen={isWorkspaceSearchOpen}
        onClose={() => setIsWorkspaceSearchOpen(false)}
        project={project}
        onSelectResult={async (filePath, line, column, matchLength) => {
          // A result's target file may not already be an open tab — unlike
          // setActiveFile (which only switches among already-open tabs),
          // handleOpenFile fetches+opens it first (no-op if already open),
          // so the reveal below always has a loaded model to act on.
          await handleOpenFile(filePath);
          document.dispatchEvent(
            new CustomEvent("ide-reveal-location", {
              detail: { filePath, line, column, matchLength },
            }),
          );
        }}
      />

      {/* Project Health Center Modal */}
      <ProjectHealthModal
        isOpen={isHealthModalOpen}
        onClose={() => setIsHealthModalOpen(false)}
        project={project}
      />

      {/* Real-Time Project Sharing & Collaborators Modal */}
      {project && (
        <ProjectSharingModal
          projectId={project.id}
          projectName={project.name}
          isOpen={isShareModalOpen}
          onClose={() => setIsShareModalOpen(false)}
          currentUserRole={projectRole}
        />
      )}

      {/* AI Proposed Patch Diff Review Modal */}
      {aiPatchState.isOpen && (
        <Suspense fallback={null}>
          <AIPatchModal
            isOpen={aiPatchState.isOpen}
            onClose={() =>
              setAiPatchState((prev) => ({ ...prev, isOpen: false }))
            }
            onAccept={handleAcceptAIPatch}
            filePath={aiPatchState.filePath}
            originalContent={aiPatchState.originalContent}
            modifiedContent={aiPatchState.modifiedContent}
            explanation={aiPatchState.explanation}
            providerName={aiPatchState.providerName}
            providerType={aiPatchState.providerType}
            linesAdded={aiPatchState.linesAdded}
            linesRemoved={aiPatchState.linesRemoved}
          />
        </Suspense>
      )}

      {/* AI Structured Code Insights & Explanation Modal */}
      {aiExplainState.isOpen && (
        <Suspense fallback={null}>
          <AIExplainModal
            isOpen={aiExplainState.isOpen}
            onClose={() =>
              setAiExplainState((prev) => ({ ...prev, isOpen: false }))
            }
            onProposeFix={() => {
              handleTriggerAIAction("fix_error", {
                path: aiExplainState.activeFilePath,
                diagnostics: aiExplainState.diagnostics,
              });
            }}
            title={aiExplainState.title}
            providerName={aiExplainState.providerName}
            providerType={aiExplainState.providerType}
            rootCause={aiExplainState.rootCause}
            explanation={aiExplainState.explanation}
            evidence={aiExplainState.evidence}
            suggestedTests={aiExplainState.suggestedTests}
          />
        </Suspense>
      )}

      {/* Guided Evaluator Onboarding Walkthrough */}
      {showTour && (
        <Suspense fallback={null}>
          <Tour
            isOpen={showTour}
            onClose={() => {
              setShowTour(false);
              localStorage.setItem("cloudeee_demo_tour_seen", "true");
            }}
          />
        </Suspense>
      )}

      {/* M22: Editor Preferences / Settings Modal */}
      <SettingsModal
        isOpen={showSettings}
        preferences={preferences}
        onSave={handleUpdatePreferences}
        onClose={() => setShowSettings(false)}
      />
    </div>
  );
}
