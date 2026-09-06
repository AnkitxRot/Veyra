import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  Suspense,
} from "react";
import { flushSync } from "react-dom";
import {
  User,
  Project,
  TreeNode,
  ContainerStats,
  UserPreferences,
  RunStatusEntry,
  SharedRunOutput,
} from "../../types";
import {
  api,
  getCapabilities,
  triggerAIAction,
  applyAIPatch,
  verifyAIPatch,
  AIVerificationRecord,
  fetchCollabTimeline,
  fetchWhileAway,
  ackWhileAway,
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
import { ExecutionSessionProvider } from "../../hooks/useExecutionSession";
import SourceControlPanel from "../Git/SourceControlPanel";
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
import NoticeStack from "../common/NoticeStack";
import WorkspaceSearchModal from "../Search/WorkspaceSearchModal";
import FollowBanner from "../Collab/FollowBanner";
import CollabConnectionBanner from "../Collab/CollabConnectionBanner";
import TeamPanel from "../Collab/TeamPanel";
import AttentionTray from "../Collab/AttentionTray";
import WhileYouWereAway, {
  type WhileAwayCardGroup,
} from "../Collab/WhileYouWereAway";
import type { AttentionEvent } from "../../collab/attention";
import type {
  TimelineEvent,
  CollabChangeWire,
  CommentThreadDTO,
  CommentEventWire,
  CommentMentionWire,
  ProfileEventWire,
  CollaboratorInfo,
} from "../../types";
import { CommentStore } from "../../comments/store";
import * as commentsApi from "../../comments/api";
import { encodeAnchor } from "../../comments/anchor";
import { countsByFile, nextInFile, previousInFile, nextUnresolved } from "../../comments/navigation";
import { KeepDeduper, keepCalloutAsComment } from "../../comments/keep";
import CommentThread from "../Comments/CommentThread";
import CommentsPanel from "../Comments/CommentsPanel";
import {
  mergeTimeline,
  wireToTimelineEvent,
  groupWhileAway,
} from "../../collab/timeline";
import {
  buildFocusContext,
  FOLLOW_ABSENCE_GRACE_MS,
  FOLLOW_LEFT_NOTICE_MS,
} from "../../collab/focus";
import {
  anchorFilePresent,
  anchorFileBasename,
  type FollowAnchor,
} from "../../collab/followAnchor";
import { FollowGeneration } from "../../collab/followGeneration";
import type { EditorViewApi } from "../Editor/Editor";
import type {
  CollaborationClient,
  CollaboratorPresence,
  CollabConnectionStatus,
  ExternalMutationNotice,
  MutationType,
} from "../../collab/client";
import ProjectSharingModal from "../Collab/ProjectSharingModal";
import ProjectSecretsModal from "../ProjectSecrets/ProjectSecretsModal";
import { CommandRegistry, Command } from "../../utils/commands";
import { buildFileIndex, IndexedFile } from "../../utils/fileIndex";
import {
  getRecentFiles,
  addRecentFile,
  addRecentProject,
} from "../../utils/recentStore";
import { Diagnostic, parseDiagnostics } from "../../utils/diagnostics";
import { useKeyboardShortcuts, IS_MAC } from "../../hooks/useKeyboardShortcuts";
import {
  resolveKeymap,
  chordToDisplay,
  type CommandId,
} from "../../keymap/keymap";
import { useNotices } from "../../hooks/useNotices";
import { useProjectRole } from "../../hooks/useProjectRole";
import { useAppearance } from "../../hooks/useAppearance";
import {
  useLayoutPreferences,
  type LayoutPreferences,
} from "../../hooks/useLayoutPreferences";
import { throttleLatest } from "../../utils/throttleLatest";
import { useStableCollaborators } from "../../utils/useStableCollaborators";
import { handleSaveError } from "../../utils/collabConflict";
import { openAndRevealLocation } from "../../utils/revealLocation";
import { appendOpenFile } from "../../utils/openFiles";
import {
  readProjectSession,
  writeProjectSession,
  getLastProjectId,
  setLastProjectId,
  resolveProjectSelection,
  resolvePendingEntryOpen,
} from "../../utils/sessionStore";
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
  IconGitBranch,
} from "../common/Icons";

// M56: human-readable label for an external-mutation notice.
function describeMutationType(t: MutationType): string {
  switch (t) {
    case "replace":
      return "Replace All";
    case "git_checkout":
      return "Branch checkout";
    case "workspace_restore":
      return "restored the workspace";
    case "workspace_import":
      return "imported a new workspace";
    case "snapshot_restore":
      return "Snapshot restore";
    case "upload":
      return "File upload";
    default:
      return "External change";
  }
}

// M60: client-side trigger gate for "While You Were Away" — mirrors the server
// default COLLAB_AWAY_THRESHOLD_MS. The gate only decides whether to ASK the
// server; the authoritative content boundary is the server's collab_last_seen.
const COLLAB_AWAY_THRESHOLD_MS = 180_000;

export default function IDE({
  user,
  onLogout,
  onSwitchToAdmin,
  routeProjectId = null,
  onNavigateProject,
}: {
  user: User;
  onLogout: () => void;
  onSwitchToAdmin?: () => void;
  /** project id from the `/p/:id` deep link, or null */
  routeProjectId?: string | null;
  /** push `/p/:id` (or `/` for none) into history without a reload */
  onNavigateProject?: (id: string | null) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  // Session restore: guards a per-project one-shot tab restore AND scopes the
  // persistence effect so a mid-switch render never writes project A's tabs
  // into project B's session.
  const sessionOwnerRef = useRef<string | null>(null);
  const didInitialResolveRef = useRef(false);
  const treeLoadedForRef = useRef<string | null>(null);
  const restoreInFlightRef = useRef<string | null>(null);
  // One-shot hint from the Sidebar: a project just created from a starter
  // template should auto-open this runnable entry file so the user's first
  // action can be Run. Consumed once, only when there is no session to
  // restore and the user has not already opened a tab.
  const pendingEntryOpenRef = useRef<{ projectId: string; path: string } | null>(
    null,
  );
  // Read the current deep-link inside loadProjects without making it a
  // dependency (which would re-run the loader when we reset the URL after a
  // bad link, silently opening projects[0]).
  const routeProjectIdRef = useRef(routeProjectId);
  routeProjectIdRef.current = routeProjectId;
  // M68: render-time mirror of the currently-open project id, so a slow
  // collaboration fetch (timeline page, timeline head-refetch) that resolves
  // after a project switch can drop its result instead of merging a previous
  // project's events into the current project's timeline.
  const activeProjectIdRef = useRef<string | null>(null);
  activeProjectIdRef.current = project?.id ?? null;
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const activeFileRef = useRef<string | null>(null);
  activeFileRef.current = activeFile;
  const [openFiles, setOpenFiles] = useState<
    { path: string; content: string; dirty?: boolean }[]
  >([]);
  const openFilesRef = useRef(openFiles);
  // Populated by the (lazily loaded) Editor on mount: the live Monaco model
  // registry that serves as the save-time source of truth. See M1.
  const liveApiRef = useRef<LiveContentApi | null>(null);
  const [bottomTab, setBottomTab] = useState<
    "output" | "problems" | "resources" | "terminal" | "preview" | "git"
  >("output");
  // M51: local Git state, surfaced as a status-bar badge.
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [gitInitialized, setGitInitialized] = useState(false);
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
  // M22: User Preferences & Editor Settings States
  const [preferences, setPreferences] =
    useState<UserPreferences>(DEFAULT_PREFERENCES);
  // M67: flipped true once GET /api/auth/preferences resolves, so the layout
  // hook can tell a real stored layout from the pre-load defaults.
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // M66: "format on save" is a normal typed user preference now — no longer a
  // separate browser-only localStorage flag.
  const formatOnSave = preferences.formatOnSave;

  const handleUpdatePreferences = useCallback(
    async (updated: Partial<UserPreferences>) => {
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
    },
    [],
  );

  useEffect(() => {
    api<{ preferences: UserPreferences }>("/api/auth/preferences")
      .then((r) => {
        if (!r || !r.preferences) return;
        setPreferences(r.preferences);
        setPreferencesLoaded(true);

        // M66 one-time migration: fold a pre-existing per-device
        // `cloudeee_format_on_save` flag into the account preference, then
        // retire the localStorage key. "true" that the server does not yet
        // know about is pushed up; anything else is just cleared.
        const legacy = localStorage.getItem("cloudeee_format_on_save");
        if (legacy === null) return;
        if (legacy === "true" && !r.preferences.formatOnSave) {
          handleUpdatePreferences({ formatOnSave: true })
            .then(() => localStorage.removeItem("cloudeee_format_on_save"))
            .catch(() => {
              /* keep the key; retry on the next load */
            });
        } else {
          localStorage.removeItem("cloudeee_format_on_save");
        }
      })
      .catch((err) => {
        console.warn("Failed to load user preferences:", err);
      });
  }, [handleUpdatePreferences]);

  // Layout Sizing States (Resizable Sidebar & Bottom Panel) — M67: the four
  // dimensions below are now persisted through the typed user_preferences
  // store (see `useLayoutPreferences`); a reload restores the exact layout.
  const persistLayout = useCallback(
    (patch: Partial<UserPreferences>) => {
      handleUpdatePreferences(patch).catch(() => {
        /* layout persistence is best-effort — mirrors the existing silent
           failure handling for the other editor preferences */
      });
    },
    [handleUpdatePreferences],
  );
  const layoutLoaded = useMemo<LayoutPreferences | null>(
    () =>
      preferencesLoaded
        ? {
            sidebarWidth: preferences.sidebarWidth,
            bottomHeight: preferences.bottomHeight,
            sidebarHidden: preferences.sidebarHidden,
            bottomCollapsed: preferences.bottomCollapsed,
          }
        : null,
    [
      preferencesLoaded,
      preferences.sidebarWidth,
      preferences.bottomHeight,
      preferences.sidebarHidden,
      preferences.bottomCollapsed,
    ],
  );
  const {
    sidebarWidth,
    bottomHeight,
    isSidebarHidden,
    isBottomCollapsed,
    setSidebarWidth,
    setBottomHeight,
    persistSidebarWidth,
    persistBottomHeight,
    setIsSidebarHidden,
    setIsBottomCollapsed,
  } = useLayoutPreferences(layoutLoaded, persistLayout);

  // M69: the single resolved-appearance source. Stamps `<html data-theme>`
  // from the typed `theme` preference and — only in "system" mode — follows
  // the OS `prefers-color-scheme`. `resolvedTheme` is threaded to the Editor
  // and Terminal, which update Monaco / xterm in place (never remount).
  const { resolvedTheme } = useAppearance(preferences.theme);

  // M70: the resolved keybinding map (defaults + the user's typed overrides).
  // One source of truth — fed to `useKeyboardShortcuts`, the Editor's Monaco
  // save binding, and the command-palette shortcut labels.
  const resolvedKeymap = useMemo(
    () => resolveKeymap(preferences.keymap),
    [preferences.keymap],
  );
  const kbLabel = useCallback(
    (id: CommandId, mac: boolean) =>
      chordToDisplay(resolvedKeymap.byCommand[id], mac),
    [resolvedKeymap],
  );

  const [isDraggingSidebar, setIsDraggingSidebar] = useState(false);
  const [isDraggingBottom, setIsDraggingBottom] = useState(false);
  // M64: one typed transient-notice mechanism. Owns id/TTL/dedupe/cleanup for
  // every notice; callers filter by `surface` and render each group in place
  // (NoticeStack for "stack", the status bar for "statusbar", the editor
  // region for "editor", nothing for "headless").
  const {
    notices: activeNotices,
    notify,
    dismiss: dismissNotice,
    dismissKey: dismissNoticeKey,
    hasKey: hasNotice,
    clear: clearNotices,
  } = useNotices();

  // M4: Real-Time Multiplayer Collaboration States
  const [collabClient, setCollabClient] = useState<CollaborationClient | null>(
    null,
  );
  const collabClientRef = useRef<CollaborationClient | null>(null);
  const [collaborators, setCollaborators] = useState<CollaboratorPresence[]>(
    [],
  );
  // M71: a referentially-stable projection of `collaborators` for the memoized
  // <Sidebar>. Its identity only changes when a Sidebar-relevant field
  // (userId / activeFile / activity.type / name / color) changes — NOT on the
  // cursor/selection/lastActive churn that fires on every remote keystroke.
  // BASELINE A/C: that churn was costing 5–90 ms of FileTree reconciliation
  // per throttled tick. Every OTHER collaborator surface (Editor spatial
  // awareness, TeamPanel, avatar stack) still gets the full `collaborators`.
  const collaboratorsForTree = useStableCollaborators(collaborators, user.id);
  // M54: collaborative run awareness — server-authoritative, ephemeral.
  const [runStatuses, setRunStatuses] = useState<RunStatusEntry[]>([]);
  // M65: shared run output — the bounded, ephemeral stdout/stderr replay that
  // rides alongside a run status for owner/editor collaborators (RECEIVE-only).
  const [sharedRunOutputs, setSharedRunOutputs] = useState<SharedRunOutput[]>(
    [],
  );
  // M58: transient attention events (Point / Callout / targeted "Come look").
  // One throttled state fed from the collab client's AttentionStore — no second
  // store, no per-event IDE re-render.
  const [attention, setAttention] = useState<AttentionEvent[]>([]);
  // M64: the attention rate-limit signal is a headless notice — a
  // lifecycle-managed flag ("attn-rate", 4s TTL) with no rendered text. The
  // user-visible rate-limit banner is owned by AttentionTray, which reads this
  // via the `rateLimited` prop.
  const [collabStatus, setCollabStatus] =
    useState<CollabConnectionStatus>("disconnected");
  // M63: local Yjs update batches not yet on the wire to the server, and
  // whether automatic reconnection has been given up. Fed by the collab
  // client's `pending_updates_change` / `reconnect_exhausted` events; drive the
  // editor-region connection banner + the beforeunload guard.
  const [pendingCollabUpdates, setPendingCollabUpdates] = useState(0);
  const [collabReconnectExhausted, setCollabReconnectExhausted] =
    useState(false);
  // M60: Team Activity timeline (bounded, live-merged) + While-You-Were-Away.
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [timelineNextBefore, setTimelineNextBefore] = useState<string | null>(
    null,
  );
  const [timelineLoaded, setTimelineLoaded] = useState(false);
  const [timelineLoadingMore, setTimelineLoadingMore] = useState(false);
  const [whileAwayGroups, setWhileAwayGroups] = useState<
    WhileAwayCardGroup[] | null
  >(null);
  // M61-A: contextual comments — one CommentStore scoped to this project,
  // fed by receive-only `comment_event` pings + REST refetch.
  const commentStoreRef = useRef<CommentStore | null>(null);
  const [commentThreadsByFile, setCommentThreadsByFile] = useState<
    CommentThreadDTO[]
  >([]);
  const [unresolvedComments, setUnresolvedComments] = useState<
    CommentThreadDTO[]
  >([]);
  const [openCommentThreadId, setOpenCommentThreadId] = useState<string | null>(
    null,
  );
  const openCommentThreadIdRef = useRef<string | null>(null);
  const [showResolvedComments, setShowResolvedComments] = useState(false);
  const [mentionCards, setMentionCards] = useState<CommentMentionWire[]>([]);
  // M62: project collaborator roster (userId → username + effective
  // displayName), from `GET /api/projects/:id/collaborators`. Feeds comment
  // author rows. Refetched (coalesced) on a `profile_event` invalidation —
  // the ping itself carries no name, only "someone in this room changed".
  const [commentRoster, setCommentRoster] = useState<
    Map<
      number,
      { username: string; displayName: string | null; avatarVersion: number }
    >
  >(new Map());
  const profileEventTimerRef = useRef<number | null>(null);

  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [isSecretsModalOpen, setIsSecretsModalOpen] = useState(false);
  // M68: the access-role lookup fails CLOSED — a failed / in-flight
  // `GET /api/projects/:id` leaves `projectRole` at the read-only `viewer`
  // state, surfaced as a retryable notice below. It is never raised to
  // editor/owner except by a response that explicitly says so.
  const {
    role: projectRole,
    status: roleStatus,
    retry: retryProjectRole,
  } = useProjectRole(project?.id ?? null);

  // M68: a failed role lookup is visible and retryable. While it stands the
  // editor is read-only (fail closed); a successful retry clears it and the
  // real role takes effect. A project switch drops it with every other notice.
  useEffect(() => {
    if (roleStatus === "error") {
      notify({
        kind: "warning",
        text: "Couldn't confirm your access level for this project. You're in read-only mode until this resolves.",
        ttl: null,
        dedupeKey: "role-fetch",
        role: "alert",
        actions: [{ label: "Retry", onClick: retryProjectRole }],
      });
    } else {
      dismissNoticeKey("role-fetch");
    }
  }, [roleStatus, retryProjectRole, notify, dismissNoticeKey]);

  // M48 Follow Mode & DND states
  const [followedUserId, setFollowedUserId] = useState<number | null>(null);
  // M57: the full Team roster panel (opened from the header collaborator count).
  const [teamPanelOpen, setTeamPanelOpen] = useState(false);
  const [followPaused, setFollowPaused] = useState<boolean>(false);
  const [followPauseReason, setFollowPauseReason] = useState<string>("");
  const [isDnd, setIsDnd] = useState<boolean>(false);

  // M59: Collaborative Focus & Context Handoff.
  //  - one anchor per follow session (the true pre-follow context), captured
  //    once, preserved across A→B target switches, discarded on Stop/Return/reset
  //  - one userId-keyed absence timer for the ~6s reconnect grace
  //  - a lightweight "Rahul left" notice after the grace expires (M64: the
  //    editor-surface "follow-left" notice — lifecycle owned by useNotices,
  //    still rendered in the editor region with its Return / Stay actions)
  const followAnchorRef = useRef<FollowAnchor | null>(null);
  const followAbsenceTimerRef = useRef<number | null>(null);
  const followedUserIdRef = useRef<number | null>(null);
  // M73: the follow-session generation token. Every transition that ends or
  // switches the current follow (Stop, Return, target switch, new follow,
  // reset) bumps it. Any async / deferred continuation captured under an
  // earlier generation — a resolved `handleReturnToMyLocation` await, a
  // fired absence timer, a "follow-left" notice action / onExpire — checks
  // its captured generation and no-ops when it is stale, so a prior target's
  // lifecycle can never navigate, clear a new target's anchor, or expire
  // into the new session.
  const followGenRef = useRef(new FollowGeneration());
  const collaboratorsRef = useRef<CollaboratorPresence[]>([]);
  const lastFollowedRef = useRef<{ userId: number; name: string } | null>(null);
  const editorViewApiRef = useRef<EditorViewApi | null>(null);
  const attentionRef = useRef<AttentionEvent[]>([]);
  const keepDeduperRef = useRef(new KeepDeduper());
  const resetFollowStateRef = useRef<() => void>(() => {});

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
    // M68: the previous project's file tree must not linger under the new
    // project's identity — a failed load for the new project would otherwise
    // render the old project's files. Reset to a loading state and free the
    // in-flight marker + bump the generation so any still-pending fetch for
    // the previous project is discarded; `loadTree` (its own effect) refills.
    setTree([]);
    setTreeStatus("loading");
    treeLoadingPidRef.current = null;
    treeLoadGenRef.current++;
    // M64: every notice producer is project-scoped (save feedback, save
    // failures, reconcile, route, external mutation, attention rate limit,
    // follow-left) — none should survive a project switch.
    clearNotices();
    setGitBranch(null);
    setGitInitialized(false);

    if (!project) {
      if (collabClientRef.current) {
        collabClientRef.current.dispose();
        collabClientRef.current = null;
        setCollabClient(null);
      }
      setCollaborators([]);
      setRunStatuses([]);
      setSharedRunOutputs([]);
      setCollabStatus("disconnected");
      return;
    }

    let cancelled = false;
    let client: CollaborationClient | null = null;
    let unsubAwareness: (() => void) | undefined;
    let unsubRunStatus: (() => void) | undefined;
    let unsubRunOutput: (() => void) | undefined;
    let unsubConnection: (() => void) | undefined;
    let unsubExternalMutation: (() => void) | undefined;
    let unsubAttention: (() => void) | undefined;
    let unsubAttnRate: (() => void) | undefined;
    let unsubCollabChange: (() => void) | undefined;
    let unsubReconnGap: (() => void) | undefined;
    let unsubCommentEvent: (() => void) | undefined;
    let unsubCommentMention: (() => void) | undefined;
    let unsubCommentStore: (() => void) | undefined;
    let unsubProfileEvent: (() => void) | undefined;
    let unsubPendingUpdates: (() => void) | undefined;
    let unsubReconnectExhausted: (() => void) | undefined;
    let throttledSetCollaborators: ReturnType<
      typeof throttleLatest<CollaboratorPresence[]>
    > | null = null;
    let throttledSetAttention: ReturnType<
      typeof throttleLatest<AttentionEvent[]>
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

      // M54: run-status transitions are rare (start/end per run) — no throttle
      // needed, and the elapsed clock ticks locally in the UI, not here.
      unsubRunStatus = client.on(
        "run_status_change",
        (entries: RunStatusEntry[]) => setRunStatuses(entries),
      );

      // M65: shared run output — batched by the server (RUN_OUTPUT_FLUSH_MS)
      // and additionally cheap here (only owner/editor peers' runs, capped at
      // 256 KB). No throttle; the console view renders it read-only.
      unsubRunOutput = client.on(
        "run_output_change",
        (outs: SharedRunOutput[]) => setSharedRunOutputs(outs),
      );

      // M58: attention events are human-frequency but still throttled to avoid
      // a per-event IDE re-render (mirrors the collaborators path).
      throttledSetAttention = throttleLatest<AttentionEvent[]>(
        setAttention,
        200,
      );
      unsubAttention = client.on("attention_change", throttledSetAttention);
      unsubAttnRate = client.on("attention_rate_limited", () => {
        // M64: a headless notice — no kind, no text, never rendered. It is a
        // lifecycle-managed flag; AttentionTray owns the visible banner.
        notify({ ttl: 4000, surface: "headless", dedupeKey: "attn-rate" });
      });

      unsubConnection = client.on(
        "connection_change",
        (status: CollabConnectionStatus) => {
          setCollabStatus(status);
          // M59: a forbidden session (role revoked / access lost) must clear
          // Follow + anchor + timers immediately.
          if (status === "forbidden") resetFollowStateRef.current();
          // M63: any forward motion (connecting/reconnecting/resync/connected)
          // means we are no longer in the terminal "gave up" state.
          if (status !== "disconnected" && status !== "forbidden") {
            setCollabReconnectExhausted(false);
          }
        },
      );

      // M63: editor-region connection banner + beforeunload guard inputs.
      unsubPendingUpdates = client.on(
        "pending_updates_change",
        (n: number) => setPendingCollabUpdates(n),
      );
      unsubReconnectExhausted = client.on("reconnect_exhausted", () =>
        setCollabReconnectExhausted(true),
      );

      // M56: informational notice that an external mutation touched a file.
      // For a whole-workspace replacement (path === null) always show it; for
      // a single path, only if that file is currently open here.
      unsubExternalMutation = client.on(
        "external_mutation_notice",
        (n: ExternalMutationNotice) => {
          const openHere =
            n.path === null ||
            openFilesRef.current.some((f) => f.path === n.path);
          if (!openHere) return;
          const label = describeMutationType(n.mutationType);
          const text =
            n.path === null
              ? `${n.actor.username} ${label}`
              : `${n.actor.username} changed ${n.path.split("/").pop()} externally` +
                ` · ${label}` +
                (typeof n.matchCount === "number"
                  ? ` · ${n.matchCount} ${n.matchCount === 1 ? "match" : "matches"}`
                  : "");
          // M64: single shared slot ("ext-mutation") — a newer file-mutation
          // notice replaces the current one, matching the pre-M64 one-state
          // behaviour. 8s TTL, stale/replacement handling owned by useNotices.
          notify({
            kind: "info",
            text,
            ttl: 8000,
            dedupeKey: "ext-mutation",
          });
        },
      );

      // M60: a closed edit burst / callout lands live in the Team Activity
      // timeline. RECEIVE-only (see collab/client.ts). Bounded to ~200.
      unsubCollabChange = client.on(
        "collab_change",
        (w: CollabChangeWire) => {
          setTimeline((prev) =>
            mergeTimeline(prev, [wireToTimelineEvent(w)], 200),
          );
        },
      );

      // M61-A: contextual comments. `comment_event` is a receive-only
      // cache-invalidation ping — the store refetches the affected file over
      // REST (SQLite + REST stay authoritative). `comment_mention` is a
      // targeted presentation ping surfaced in the Attention & Mentions tray.
      const commentStore = new CommentStore(project.id);
      commentStoreRef.current = commentStore;
      unsubCommentStore = commentStore.on(() => {
        const af = activeFileRef.current;
        setCommentThreadsByFile(af ? commentStore.threadsFor(af) : []);
        setUnresolvedComments(commentStore.unresolved());
      });
      void commentStore.loadUnresolved();
      if (activeFileRef.current) void commentStore.load(activeFileRef.current);
      unsubCommentEvent = client.on(
        "comment_event",
        (ev: CommentEventWire) => {
          commentStore.applyEvent(ev);
          void commentStore.loadUnresolved();
          // The comment lifecycle also feeds the M60 timeline — refetch its head.
          void fetchCollabTimeline(project.id, { limit: 40 })
            .then((r) => {
              if (cancelled || project.id !== activeProjectIdRef.current) return;
              setTimeline((prev) => mergeTimeline(prev, r.events, 200));
            })
            .catch(() => {});
        },
      );
      unsubCommentMention = client.on(
        "comment_mention",
        (ev: CommentMentionWire) => {
          setMentionCards((c) => [ev, ...c].slice(0, 10));
        },
      );

      // M62: keep the comment author roster fresh. Initial load now, then one
      // coalesced refetch per burst of `profile_event` pings. The ping is
      // invalidation-only — it never carries a name, and it only reaches this
      // client because the changed user is in THIS project's room (per-room
      // socket), so no extra project-scoping check is needed. Presence names
      // update via awareness independently; this path is only for comments.
      const loadCommentRoster = () => {
        api<{ collaborators: CollaboratorInfo[] }>(
          `/api/projects/${project.id}/collaborators`,
        )
          .then((r) => {
            if (cancelled) return;
            const next = new Map<
              number,
              {
                username: string;
                displayName: string | null;
                avatarVersion: number;
              }
            >();
            for (const c of r.collaborators ?? []) {
              next.set(c.userId, {
                username: c.username,
                displayName: c.displayName ?? null,
                avatarVersion: c.avatarVersion ?? 0,
              });
            }
            setCommentRoster(next);
            dismissNoticeKey("roster-load");
          })
          .catch(() => {
            if (cancelled) return;
            // M68: a failed roster fetch leaves the last-known roster in place
            // (comment author names just may be stale) — but say so, and let
            // the user retry, instead of failing silently.
            notify({
              kind: "warning",
              text: "Couldn't refresh collaborator names — some may be out of date.",
              ttl: null,
              dedupeKey: "roster-load",
              actions: [{ label: "Retry", onClick: () => loadCommentRoster() }],
            });
          });
      };
      loadCommentRoster();
      unsubProfileEvent = client.on(
        "profile_event",
        (_ev: ProfileEventWire) => {
          // coalesce: while a refetch is already scheduled, drop the event.
          if (profileEventTimerRef.current != null) return;
          profileEventTimerRef.current = window.setTimeout(() => {
            profileEventTimerRef.current = null;
            loadCommentRoster();
          }, 300);
        },
      );

      // M60: on a real reconnect-after-gap, ask the server (authoritative
      // last-seen boundary) whether there is anything meaningful to show.
      const loadWhileAway = () => {
        void fetchWhileAway(project.id)
          .then((r) => {
            if (cancelled) return;
            dismissNoticeKey("whileaway-load");
            if (r.events.length === 0) return;
            setWhileAwayGroups(
              groupWhileAway(r.events).map((g) => ({
                userId: g.userId,
                username: g.username,
                lines: g.lines,
                events: g.events,
              })),
            );
          })
          .catch(() => {
            if (cancelled) return;
            // M68: the reconnect itself already succeeded (M63 semantics
            // unchanged); only the "what changed while you were away" summary
            // failed to load. Make that visible and retryable.
            notify({
              kind: "warning",
              text: "Couldn't load what changed while you were away.",
              ttl: null,
              dedupeKey: "whileaway-load",
              actions: [{ label: "Retry", onClick: () => loadWhileAway() }],
            });
          });
      };
      unsubReconnGap = client.on(
        "reconnected_after_gap",
        (info: { offlineMs: number }) => {
          if (info.offlineMs < COLLAB_AWAY_THRESHOLD_MS) return;
          loadWhileAway();
        },
      );
    })();

    // M68: the project access-role lookup lives in `useProjectRole` now — it
    // fails closed to `viewer` and is retryable, instead of the swallowed
    // fetch that used to sit here and leave a failed lookup at owner.

    return () => {
      cancelled = true;
      unsubAwareness?.();
      unsubRunStatus?.();
      unsubRunOutput?.();
      unsubConnection?.();
      unsubExternalMutation?.();
      unsubAttention?.();
      unsubAttnRate?.();
      unsubCollabChange?.();
      unsubReconnGap?.();
      unsubCommentEvent?.();
      unsubCommentMention?.();
      unsubCommentStore?.();
      unsubProfileEvent?.();
      unsubPendingUpdates?.();
      unsubReconnectExhausted?.();
      // M63: the next project starts with a clean connection-state slate.
      setPendingCollabUpdates(0);
      setCollabReconnectExhausted(false);
      commentStoreRef.current?.dispose();
      commentStoreRef.current = null;
      setCommentThreadsByFile([]);
      setUnresolvedComments([]);
      setOpenCommentThreadId(null);
      setMentionCards([]);
      setTimeline([]);
      setTimelineLoaded(false);
      setTimelineNextBefore(null);
      setWhileAwayGroups(null);
      // M64: notices are reset wholesale at the top of this effect for the
      // next project; nothing collab-specific to drop in this teardown.
      // M59: project switch / disposal / unmount clears Follow + anchor + all
      // follow timers so nothing leaks into the next project or a stale timer
      // fires after this client is gone.
      resetFollowStateRef.current();
      client?.dispose();
      if (collabClientRef.current === client) {
        collabClientRef.current = null;
      }
      throttledSetCollaborators?.cancel();
      throttledSetAttention?.cancel();
      setRunStatuses([]);
      setSharedRunOutputs([]);
      setAttention([]);
      // M62: cancel a pending coalesced profile-event roster refetch and
      // drop the stale roster so the next project starts clean.
      if (profileEventTimerRef.current != null) {
        window.clearTimeout(profileEventTimerRef.current);
        profileEventTimerRef.current = null;
      }
      setCommentRoster(new Map());
    };
    // project is tracked by id only to avoid reconnect churn when the object
    // reference changes without the id changing; collabClient is read via
    // collabClientRef to avoid a self-triggered reconnect loop (this effect
    // itself calls setCollabClient).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, user]);

  // M63: while the collaboration transport has local edits it could not send,
  // warn before the tab unloads. Yjs still holds those edits in memory, but
  // closing the tab now strands them until (and unless) this same browser
  // reconnects to the room. The listener exists ONLY while edits are pending —
  // it is removed as soon as the count returns to zero (or on unmount).
  useEffect(() => {
    if (pendingCollabUpdates <= 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [pendingCollabUpdates]);

  // M68: a total `GET /api/projects` failure is no longer swallowed — it is a
  // persistent, retryable notice instead of a blank IDE with no explanation.
  // An already-loaded `projects` list is preserved across a failed refresh.
  const loadProjectsRef = useRef<() => void>(() => {});
  const loadProjects = useCallback(async () => {
    try {
      const res = await api<{ projects: Project[] }>("/api/projects");
      setProjects(res.projects);
      dismissNoticeKey("projects-load");

      if (!didInitialResolveRef.current) {
        // First load after mount / hard reload: honour a `/p/:id` deep link,
        // else the last opened project, else the historical default.
        didInitialResolveRef.current = true;
        const { projectId, invalidRoute } = resolveProjectSelection({
          routeProjectId: routeProjectIdRef.current ?? null,
          lastProjectId: getLastProjectId(),
          projectIds: res.projects.map((p) => p.id),
        });
        if (invalidRoute) {
          // Explicit link to a project that isn't ours / doesn't exist — do
          // NOT open a different one and do NOT show an "opened" state.
          notify({
            kind: "error",
            text: "That project link isn't available. It may have been deleted, or you may not have access. Pick a project to continue.",
            ttl: null,
            dedupeKey: "invalid-route",
            role: "alert",
          });
          onNavigateProject?.(null);
        } else if (projectId) {
          const target = res.projects.find((p) => p.id === projectId)!;
          setProject(target);
          addRecentProject(target);
          setLastProjectId(target.id);
          onNavigateProject?.(target.id);
        }
        return;
      }

      // Later refreshes (post create / import / fork): keep the historical
      // "auto-open the newest project only when nothing is open" behaviour.
      if (res.projects.length > 0 && !project) {
        setProject(res.projects[0]);
        addRecentProject(res.projects[0]);
        setLastProjectId(res.projects[0].id);
        onNavigateProject?.(res.projects[0].id);
      }
    } catch {
      notify({
        kind: "error",
        text: "Couldn't load your projects. Check your connection and try again.",
        ttl: null,
        dedupeKey: "projects-load",
        role: "alert",
        actions: [{ label: "Retry", onClick: () => loadProjectsRef.current() }],
      });
    }
    // routeProjectId is read via routeProjectIdRef; onNavigateProject is a
    // stable useCallback from App. Keeping deps minimal preserves the original
    // loader lifecycle; notify / dismissNoticeKey are stable useNotices refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, notify, dismissNoticeKey]);
  useEffect(() => {
    loadProjectsRef.current = () => {
      void loadProjects();
    };
  }, [loadProjects]);

  // M68: the file-tree fetch is no longer a swallowed `catch {}`. An empty
  // `tree` now reads as loading / failed / genuinely empty in the Sidebar,
  // and a failure is a persistent, retryable notice. An already-loaded tree
  // is kept on screen through a background refresh or a failed refresh.
  const [treeStatus, setTreeStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const loadTreeRef = useRef<() => void>(() => {});
  // Which project's tree fetch is in flight, and a generation counter. A
  // second call for the SAME project (a doubled Retry click) is dropped; a
  // call for a DIFFERENT project (a switch mid-flight) proceeds and the
  // stale fetch's result is discarded by the generation check.
  const treeLoadingPidRef = useRef<string | null>(null);
  const treeLoadGenRef = useRef(0);
  const loadTree = useCallback(async () => {
    if (!project) return;
    const pid = project.id;
    if (treeLoadingPidRef.current === pid) return;
    const gen = ++treeLoadGenRef.current;
    treeLoadingPidRef.current = pid;
    if (treeLoadedForRef.current !== pid) setTreeStatus("loading");
    try {
      const res = await api<{ tree: TreeNode[] }>(
        `/api/projects/${pid}/tree`,
      );
      if (gen !== treeLoadGenRef.current) return;
      setTree(res.tree);
      treeLoadedForRef.current = pid;
      setTreeStatus("ready");
      dismissNoticeKey("tree-load");
    } catch {
      if (gen !== treeLoadGenRef.current) return;
      setTreeStatus("error");
      notify({
        kind: "error",
        text: "Couldn't load this project's files.",
        ttl: null,
        dedupeKey: "tree-load",
        role: "alert",
        actions: [{ label: "Retry", onClick: () => loadTreeRef.current() }],
      });
    } finally {
      // Only the current generation's settle clears the in-flight marker — a
      // superseded fetch (switch away and back) must not free it while the
      // newer fetch for the same project is still running.
      if (
        gen === treeLoadGenRef.current &&
        treeLoadingPidRef.current === pid
      ) {
        treeLoadingPidRef.current = null;
      }
    }
  }, [project, notify, dismissNoticeKey]);
  useEffect(() => {
    loadTreeRef.current = () => {
      void loadTree();
    };
  }, [loadTree]);

  // Track Recent Projects on Switch.
  // M71: stable identity — <Sidebar> is memoized; an inline handler here would
  // defeat the memo and re-render the whole file tree on every IDE render.
  const handleSelectProject = useCallback(
    (p: Project) => {
      dismissNoticeKey("invalid-route");
      if (p.id === project?.id) return;
      setProject(p);
      addRecentProject(p);
      setLastProjectId(p.id);
      onNavigateProject?.(p.id);
    },
    [project?.id, dismissNoticeKey, onNavigateProject],
  );

  // M71: stable identities for the remaining memoized-<Sidebar> handler props.
  const handleRetryTree = useCallback(() => loadTreeRef.current(), []);
  const handleOpenTour = useCallback(() => setShowTour(true), []);
  const handleOpenSettingsFromSidebar = useCallback(
    () => setShowSettings(true),
    [],
  );

  // Browser Back / Forward (and any external `/p/:id` change after the initial
  // resolve): move the open project to match the URL. The very first resolve
  // is owned by loadProjects() above.
  useEffect(() => {
    if (!didInitialResolveRef.current) return;
    const rid = routeProjectId ?? null;
    if (!rid || rid === project?.id) return;
    const target = projects.find((p) => p.id === rid);
    if (target) {
      setProject(target);
      addRecentProject(target);
      setLastProjectId(target.id);
      dismissNoticeKey("invalid-route");
    } else if (projects.length > 0) {
      // navigated (e.g. pasted a link) to a project we can't resolve
      notify({
        kind: "error",
        text: "That project link isn't available. It may have been deleted, or you may not have access.",
        ttl: null,
        dedupeKey: "invalid-route",
        role: "alert",
      });
      onNavigateProject?.(null);
    }
  }, [
    routeProjectId,
    projects,
    project?.id,
    onNavigateProject,
    notify,
    dismissNoticeKey,
  ]);

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
  const fileIndexRef = useRef<IndexedFile[]>([]);
  useEffect(() => {
    fileIndexRef.current = fileIndex;
  }, [fileIndex]);

  // --- Session restore: reopen this project's tabs / active file / panel ----
  //
  // Runs once per project, and only:
  //   - after its file tree is known (so a persisted path that no longer
  //     exists is skipped, not opened as an empty ghost tab), and
  //   - while `openFiles` is empty — either the initial mount, or right after
  //     the project-switch effect above cleared the previous project's tabs.
  //     If the user opened a file first, `openFiles` is non-empty and restore
  //     stands down for good.
  //
  // `sessionOwnerRef` records which project currently owns the localStorage
  // session slot; it is only advanced here, and it gates the persistence
  // effect below so a mid-switch render can never write project A's working
  // set into project B's session.
  useEffect(() => {
    const pid = project?.id;
    if (!pid) return;
    if (sessionOwnerRef.current === pid) return; // already handled this project
    if (treeLoadedForRef.current !== pid) return; // tree not loaded yet
    if (openFiles.length > 0) return; // pre-switch tabs not cleared yet / user acted

    // This project now owns its session slot; persistence may write it.
    sessionOwnerRef.current = pid;

    const sess = readProjectSession(pid);
    if (!sess) return;
    if (sess.bottomTab) setBottomTab(sess.bottomTab);
    if (sess.openTabs.length === 0) return;

    const existing = new Set(fileIndex.map((f) => f.path));
    const wanted = sess.openTabs.filter((p) => existing.has(p));
    if (wanted.length === 0) return;

    restoreInFlightRef.current = pid;
    let cancelled = false;
    (async () => {
      const loaded = await Promise.all(
        wanted.map(async (p) => {
          try {
            const r = await api<{ content: string }>(
              `/api/projects/${pid}/file?path=${encodeURIComponent(p)}`,
            );
            return { path: p, content: r.content };
          } catch {
            return null; // file vanished between tree read and fetch — skip
          }
        }),
      );
      if (cancelled) return;
      const valid = loaded.filter(
        (x): x is { path: string; content: string } => x !== null,
      );
      if (valid.length > 0 && openFilesRef.current.length === 0) {
        setOpenFiles(valid);
        setActiveFile(
          sess.active && valid.some((v) => v.path === sess.active)
            ? sess.active
            : valid[valid.length - 1].path,
        );
      }
    })().finally(() => {
      if (restoreInFlightRef.current === pid) restoreInFlightRef.current = null;
    });

    return () => {
      cancelled = true;
      if (restoreInFlightRef.current === pid) restoreInFlightRef.current = null;
    };
    // `openFiles` (not just its length) is intentionally a dep so this re-runs
    // after the project-switch clear; the sessionOwnerRef guard makes every
    // post-restore re-run a no-op.
  }, [project?.id, tree, fileIndex, openFiles]);

  // --- Session persist: mirror the working set into localStorage -----------
  //
  // Keyed on a stable joined-paths string, NOT `openFiles` itself, so typing
  // (which flips a per-file `dirty` bit exactly once) does not trigger writes.
  // Only meaningful transitions — tab open/close, active switch, bottom-panel
  // switch — reach here. Never writes editor text, only paths + panel id.
  const openTabsKey = useMemo(
    () => openFiles.map((f) => f.path).join("\n"),
    [openFiles],
  );
  useEffect(() => {
    const pid = project?.id;
    if (!pid) return;
    if (sessionOwnerRef.current !== pid) return; // mid-switch / not yet ours
    if (restoreInFlightRef.current === pid) return; // don't race the restore
    writeProjectSession(pid, {
      openTabs: openTabsKey ? openTabsKey.split("\n") : [],
      active: activeFile,
      bottomTab,
    });
  }, [project?.id, openTabsKey, activeFile, bottomTab]);

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

  // M56: mirror the active editor tab's unsaved state into collaboration
  // awareness (a single bounded `activeFileDirty` bit) so another
  // collaborator's destructive operation can warn before overwriting it.
  useEffect(() => {
    const client = collabClientRef.current;
    if (!client) return;
    const cur = openFiles.find((f) => f.path === activeFile);
    client.setActiveFileDirty(!!cur?.dirty);
  }, [activeFile, openFiles, collabClient]);

  const handleOpenFile = useCallback(
    async (path: string) => {
      if (!project) return;

    // Record into recent store
    addRecentFile(project.id, path);
    setRecentFilesList(getRecentFiles(project.id));

    const existing = openFilesRef.current.find((f) => f.path === path);
    if (existing) {
      setActiveFile(path);
      return;
    }

    try {
      const res = await api<{ content: string }>(
        `/api/projects/${project.id}/file?path=${encodeURIComponent(path)}`,
      );
      setOpenFiles((prev) => appendOpenFile(prev, { path, content: res.content }));
      setActiveFile(path);
    } catch (err: any) {
      alert(`Could not open file: ${err.message || "Error"}`);
    }
  },
  [project],
  );

  useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);

  const handleProjectBootstrapped = useCallback(
    (created: Project, entryFile: string) => {
      pendingEntryOpenRef.current = { projectId: created.id, path: entryFile };
    },
    [],
  );

  // Auto-open a freshly created starter's entry file once its tree has loaded.
  // Guard logic lives in resolvePendingEntryOpen (unit-tested); this effect
  // is just its wiring. The ref-clear makes it a one-shot.
  useEffect(() => {
    const pid = project?.id;
    const path = resolvePendingEntryOpen({
      projectId: pid,
      pending: pendingEntryOpenRef.current,
      treeLoadedFor: treeLoadedForRef.current,
      openFileCount: openFilesRef.current.length,
      hasSession: pid ? readProjectSession(pid) !== null : false,
    });
    if (!path) return;
    pendingEntryOpenRef.current = null;
    void handleOpenFile(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, tree, openFiles]);

  // M50/M51: after an external operation rewrites workspace files on disk
  // (workspace-wide Replace All; Git branch checkout), reconcile any editor
  // buffers currently open for those files. Clean buffers are refetched and
  // pushed into openFiles state — Editor.tsx's model-management effect then
  // setValue()s the live Monaco model under its isUpdatingModelRef guard
  // (active file immediately, background tabs on next switch), so a later
  // Ctrl+S from a stale model cannot silently revert the change. Dirty
  // buffers are never touched; the user is told which files changed
  // underneath their unsaved edits.
  const reconcileExternalFileChanges = useCallback(
    async (
      changedPaths: string[],
      opts: { noticeLabel: string; authoritative?: boolean },
    ) => {
      if (!project) return;
      const open = openFilesRef.current;
      const dirtySkipped: string[] = [];
      const toRefresh: string[] = [];
      for (const p of changedPaths) {
        const f = open.find((of) => of.path === p);
        if (!f) continue; // file not open — nothing to reconcile
        // `authoritative` (git checkout): the server already preflight-
        // rejected the switch if any of these files had genuinely-unsaved
        // edits, so a dirty flag now can only be a spurious echo of this
        // operation's own external-mutation sync — safe to refresh + clear.
        if (f.dirty && !opts.authoritative) dirtySkipped.push(p);
        else toRefresh.push(p);
      }

      const fetched = new Map<string, string>();
      await Promise.all(
        toRefresh.map(async (p) => {
          try {
            const res = await api<{ content: string }>(
              `/api/projects/${project.id}/file?path=${encodeURIComponent(p)}`,
            );
            fetched.set(p, res.content);
          } catch {
            // Leave the buffer as-is rather than blank it; reopening the tab
            // still fetches fresh content.
          }
        }),
      );

      if (fetched.size > 0) {
        setOpenFiles((prev) =>
          prev.map((f) =>
            fetched.has(f.path) && (opts.authoritative || !f.dirty)
              ? { ...f, content: fetched.get(f.path)!, dirty: false }
              : f,
          ),
        );
      }

      if (dirtySkipped.length > 0) {
        notify({
          kind: "warning",
          text:
            `${opts.noticeLabel} updated ${dirtySkipped.length} open ${
              dirtySkipped.length === 1 ? "file" : "files"
            } on disk, but your unsaved changes were left untouched: ${dirtySkipped.join(
              ", ",
            )}. Save or discard your edits to pick up the change.`,
          ttl: null,
          dedupeKey: "reconcile",
        });
      }

      // A branch checkout can add or remove files, not just change contents —
      // refresh the explorer so it reflects the checked-out tree.
      if (opts.noticeLabel === "Branch checkout") {
        void loadTree();
      }
    },
    [project, loadTree, notify],
  );

  const handleReplaceApplied = useCallback(
    (changedPaths: string[]) =>
      reconcileExternalFileChanges(changedPaths, {
        noticeLabel: "Replace All",
      }),
    [reconcileExternalFileChanges],
  );

  const getDirtyOpenPaths = useCallback(
    () => openFilesRef.current.filter((f) => f.dirty).map((f) => f.path),
    [],
  );

  const followedUser = useMemo(
    () =>
      followedUserId
        ? collaborators.find((c) => c.userId === followedUserId) || null
        : null,
    [followedUserId, collaborators],
  );

  // M59: the followed collaborator's current focus range (from their latest
  // attention event), shown on the FollowBanner. Derived — no store.
  const followedFocusRange = useMemo(() => {
    if (!followedUser || !user) return null;
    const fc = buildFocusContext(
      followedUser,
      attention,
      user.id,
      followedUserId,
    );
    return fc.range
      ? { startLine: fc.range.startLine, endLine: fc.range.endLine }
      : null;
  }, [followedUser, attention, followedUserId, user]);

  // M59: keep refs fresh so timer callbacks / event handlers read current state.
  useEffect(() => {
    followedUserIdRef.current = followedUserId;
  }, [followedUserId]);
  useEffect(() => {
    collaboratorsRef.current = collaborators;
  }, [collaborators]);
  useEffect(() => {
    attentionRef.current = attention;
  }, [attention]);
  useEffect(() => {
    openCommentThreadIdRef.current = openCommentThreadId;
  }, [openCommentThreadId]);

  const clearFollowAbsenceTimer = useCallback(() => {
    if (followAbsenceTimerRef.current !== null) {
      window.clearTimeout(followAbsenceTimerRef.current);
      followAbsenceTimerRef.current = null;
    }
  }, []);

  // M59: capture the pre-follow context — ONCE per follow session. The
  // null-guard is what makes Follow A → Follow B keep A's anchor.
  const captureAnchor = useCallback(() => {
    if (followAnchorRef.current) return;
    const saved = editorViewApiRef.current?.save();
    if (!saved) return;
    followAnchorRef.current = {
      filePath: saved.filePath,
      viewState: saved.viewState,
      cursor: saved.cursor,
      capturedAt: Date.now(),
    };
  }, []);

  // M59: the single Follow-transition controller. Acting on a DIFFERENT
  // collaborator ends the current Follow (anchor PRESERVED). follow:true
  // captures the anchor iff none exists, then sets the target.
  const focusOn = useCallback(
    (userId: number, opts: { follow: boolean }) => {
      const cur = followedUserIdRef.current;
      // M73: a real transition (switch target / start a follow) ends the prior
      // session — invalidate every token captured under it.
      if (opts.follow || (cur !== null && cur !== userId)) {
        followGenRef.current.bump();
      }
      if (cur !== null && cur !== userId) {
        setFollowedUserId(null);
        setFollowPaused(false);
        setFollowPauseReason("");
        clearFollowAbsenceTimer();
        // anchor deliberately NOT touched here
      }
      if (opts.follow) {
        // M64: a fresh follow session supersedes a pending "X left" notice —
        // otherwise it lingers with live Return/Stay buttons and its TTL
        // expiry would null this session's anchor. Explicit dismissal, so
        // onExpire does not run.
        dismissNoticeKey("follow-left");
        if (followAnchorRef.current == null) captureAnchor();
        setFollowedUserId(userId);
        const c = collaboratorsRef.current.find((x) => x.userId === userId);
        if (c) lastFollowedRef.current = { userId, name: c.name };
      }
    },
    [captureAnchor, clearFollowAbsenceTimer, dismissNoticeKey],
  );

  const handleReturnToMyLocation = useCallback(async () => {
    const anchor = followAnchorRef.current;
    // M73: token for this return — a new follow starting during the open below
    // must not have its target navigated away by the resolved continuation.
    const gen = followGenRef.current.bump();
    clearFollowAbsenceTimer();
    // M64: explicit dismissal — clears the notice + its TTL timer, and does
    // NOT run onExpire (the anchor is discarded here directly instead).
    dismissNoticeKey("follow-left");
    setFollowedUserId(null);
    setFollowPaused(false);
    setFollowPauseReason("");
    followAnchorRef.current = null;
    if (!anchor) return;

    const known = new Set<string>([
      ...fileIndexRef.current.map((f) => f.path),
      ...openFilesRef.current.map((f) => f.path),
    ]);
    if (!anchorFilePresent(anchor, known)) {
      notify({
        kind: "warning",
        text: `Your previous file "${anchorFileBasename(anchor)}" is no longer available.`,
        ttl: null,
        dedupeKey: "reconcile",
      });
      return;
    }
    await handleOpenFile(anchor.filePath);
    // A new follow session superseded this return while the file opened.
    if (!followGenRef.current.isCurrent(gen)) return;
    document.dispatchEvent(
      new CustomEvent("ide-restore-view-state", {
        detail: {
          filePath: anchor.filePath,
          viewState: anchor.viewState,
          cursor: anchor.cursor,
        },
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearFollowAbsenceTimer, dismissNoticeKey]);

  const handleStopFollowing = useCallback(() => {
    followGenRef.current.bump();
    clearFollowAbsenceTimer();
    dismissNoticeKey("follow-left");
    setFollowedUserId(null);
    setFollowPaused(false);
    setFollowPauseReason("");
    followAnchorRef.current = null;
  }, [clearFollowAbsenceTimer, dismissNoticeKey]);

  // M59: full reset — project switch / disposal / session expiry / unmount.
  const resetFollowState = useCallback(() => {
    followGenRef.current.bump();
    clearFollowAbsenceTimer();
    dismissNoticeKey("follow-left");
    followAnchorRef.current = null;
    lastFollowedRef.current = null;
    setFollowedUserId(null);
    setFollowPaused(false);
    setFollowPauseReason("");
  }, [clearFollowAbsenceTimer, dismissNoticeKey]);
  useEffect(() => {
    resetFollowStateRef.current = resetFollowState;
  }, [resetFollowState]);

  // M59: auto-track the followed collaborator, WITH a userId-keyed ~6s absence
  // grace so a brief ws blip / reconnect does not drop Follow.
  useEffect(() => {
    if (!followedUser) {
      if (followedUserId !== null && followAbsenceTimerRef.current === null) {
        // M73: this absence timer belongs to the follow session live now.
        const gen = followGenRef.current.current();
        followAbsenceTimerRef.current = window.setTimeout(() => {
          followAbsenceTimerRef.current = null;
          // A newer follow session started while the grace ran out — this
          // timer's target is history; do not drop the new follow or notify.
          if (!followGenRef.current.isCurrent(gen)) return;
          const targetId = followedUserIdRef.current;
          const stillAbsent =
            targetId !== null &&
            !collaboratorsRef.current.some((c) => c.userId === targetId);
          if (stillAbsent) {
            setFollowedUserId(null);
            setFollowPaused(false);
            setFollowPauseReason("");
            const name =
              lastFollowedRef.current?.name ?? "Your collaborator";
            // anchor PRESERVED — the notice offers "Return to your location".
            // M64: editor-surface notice; on TTL expiry the anchor is
            // discarded ("Stay here" default) via onExpire.
            notify({
              kind: "warning",
              text: `${name} left`,
              ttl: FOLLOW_LEFT_NOTICE_MS,
              surface: "editor",
              dedupeKey: "follow-left",
              onExpire: () => {
                // M73: only this session's "stay here" default may drop the
                // anchor — a session that started since must keep its own.
                if (followGenRef.current.isCurrent(gen)) {
                  followAnchorRef.current = null;
                }
              },
              actions: [
                {
                  label: "Return to your location",
                  onClick: () => {
                    void handleReturnToMyLocation();
                  },
                },
                {
                  label: "Stay here",
                  onClick: () => {
                    dismissNoticeKey("follow-left");
                    if (followGenRef.current.isCurrent(gen)) {
                      followAnchorRef.current = null;
                    }
                  },
                },
              ],
            });
          }
        }, FOLLOW_ABSENCE_GRACE_MS);
      }
      return;
    }

    // followedUser is present → seamless resume: kill any pending absence timer.
    clearFollowAbsenceTimer();

    if (followedUser.activeFile && followedUser.activeFile !== activeFile) {
      const isCurrentFileDirty = openFiles.some(
        (f) => f.path === activeFile && f.dirty,
      );
      if (isCurrentFileDirty) {
        setFollowPaused(true);
        setFollowPauseReason("Follow paused — you have unsaved changes");
      } else {
        setFollowPaused(false);
        setFollowPauseReason("");
        void openAndRevealLocation(handleOpenFile, {
          filePath: followedUser.activeFile,
          line: followedUser.cursor?.line ?? 1,
          column: followedUser.cursor?.column ?? 1,
        });
      }
    } else if (followedUser.activeFile === activeFile) {
      setFollowPaused(false);
      setFollowPauseReason("");
      if (followedUser.cursor) {
        document.dispatchEvent(
          new CustomEvent("ide-reveal-location", {
            detail: {
              filePath: followedUser.activeFile,
              line: followedUser.cursor.line,
              column: followedUser.cursor.column,
            },
          }),
        );
      }
    }
    // NOTE: no cleanup that clears followAbsenceTimerRef — the timer must
    // survive `collaborators` churn (this effect re-runs on every awareness
    // update). It is cleared explicitly in the handlers / teardown / on resume.
  }, [
    followedUser,
    activeFile,
    openFiles,
    followedUserId,
    clearFollowAbsenceTimer,
    notify,
    dismissNoticeKey,
    handleReturnToMyLocation,
  ]);

  const handleFollowCollaborator = useCallback(
    (c: CollaboratorPresence) => {
      if (followedUserId === c.userId) {
        // Unfollow = Stop (discard anchor, stay put).
        handleStopFollowing();
        return;
      }
      focusOn(c.userId, { follow: true });
      if (c.activeFile) {
        const isCurrentFileDirty = openFilesRef.current.some(
          (f) => f.path === activeFile && f.dirty,
        );
        if (!isCurrentFileDirty) {
          void handleOpenFile(c.activeFile);
        } else if (c.activeFile !== activeFile) {
          setFollowPaused(true);
          setFollowPauseReason("Follow paused — you have unsaved changes");
        }
      }
    },
    [followedUserId, activeFile, focusOn, handleStopFollowing],
  );

  const handleJumpToCollaborator = useCallback(
    (c: CollaboratorPresence) => {
      if (!c.activeFile) return;
      // M59: Jump is a deliberate navigation elsewhere — it ends a follow of a
      // DIFFERENT collaborator (anchor preserved). It never starts Follow.
      focusOn(c.userId, { follow: false });
      // M58: route through the canonical open-then-reveal primitive. The old
      // handleOpenFile + setTimeout(dispatch) path could dispatch the reveal
      // before a closed file finished opening — see openAndRevealLocation.
      void openAndRevealLocation(handleOpenFile, {
        filePath: c.activeFile,
        line: c.cursor?.line ?? 1,
        column: c.cursor?.column ?? 1,
      });
    },
    [focusOn],
  );

  // M60: click a Team Activity / While-You-Were-Away row → the canonical
  // open-then-reveal primitive. File-only when there is no exact range;
  // never navigable when there is no filePath (commits, snapshots).
  const handleTimelineNavigate = useCallback((ev: TimelineEvent) => {
    if (!ev.navigable || !ev.filePath) return;
    void openAndRevealLocation(handleOpenFile, {
      filePath: ev.filePath,
      line: ev.lineRange?.startLine ?? 1,
      column: 1,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- M61-A: contextual comments ----------------------------------------
  const commentMembers = useMemo(() => {
    // userId → { username (mention token + key), displayName (presentation) }.
    // The REST roster is authoritative for displayName (freshest after a
    // `profile_event` refetch); live presence fills anyone connected but not
    // on the roster (typically the project owner) and any displayName the
    // roster hasn't caught up on; the local user is always included.
    const m = new Map<
      number,
      {
        userId: number;
        username: string;
        displayName: string | null;
        avatarVersion: number;
      }
    >();
    for (const [uid, info] of commentRoster) {
      m.set(uid, {
        userId: uid,
        username: info.username,
        displayName: info.displayName,
        avatarVersion: info.avatarVersion,
      });
    }
    for (const c of collaborators) {
      const existing = m.get(c.userId);
      if (!existing) {
        m.set(c.userId, {
          userId: c.userId,
          username: c.name,
          displayName: c.displayName ?? null,
          avatarVersion: c.avatarVersion ?? 0,
        });
      } else {
        if (!existing.displayName && c.displayName) {
          existing.displayName = c.displayName;
        }
        // Live presence is fresher than a not-yet-refetched roster.
        if (c.avatarVersion && c.avatarVersion !== existing.avatarVersion) {
          existing.avatarVersion = c.avatarVersion;
        }
      }
    }
    if (user) {
      const existing = m.get(user.id);
      m.set(user.id, {
        userId: user.id,
        username: user.username,
        displayName: existing?.displayName ?? null,
        avatarVersion: existing?.avatarVersion ?? 0,
      });
    }
    return [...m.values()];
  }, [commentRoster, collaborators, user]);

  const commentCountsByFile = useMemo(() => countsByFile(unresolvedComments), [unresolvedComments]);

  const openCommentThread = useMemo(
    () =>
      [...commentThreadsByFile, ...unresolvedComments].find(
        (t) => t.id === openCommentThreadId,
      ) ?? null,
    [commentThreadsByFile, unresolvedComments, openCommentThreadId],
  );

  const reloadActiveComments = useCallback(() => {
    const af = activeFileRef.current;
    if (af) void commentStoreRef.current?.load(af);
    void commentStoreRef.current?.loadUnresolved();
  }, []);

  const handleOpenCommentThread = useCallback((threadId: string) => {
    setOpenCommentThreadId(threadId);
  }, []);

  const handleCommentNavigate = useCallback(
    (thread: CommentThreadDTO) => {
      void openAndRevealLocation(handleOpenFile, {
        filePath: thread.filePath,
        line: thread.anchor.startLine,
        column: 1,
      });
      setOpenCommentThreadId(thread.id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handleCreateComment = useCallback(
    async (input: {
      filePath: string;
      selection: {
        startLine: number;
        startColumn: number;
        endLine: number;
        endColumn: number;
      };
    }) => {
      const pid = project?.id;
      const client = collabClientRef.current;
      if (!pid || !client) return;
      const yText = client.doc.getText(input.filePath);
      const text = yText.toString();
      const off = (line: number, col: number) => {
        let o = 0;
        let l = 1;
        for (let i = 0; i < text.length && l < line; i++) {
          if (text[i] === "\n") {
            l++;
            o = i + 1;
          }
        }
        return o + (col - 1);
      };
      let s = off(input.selection.startLine, input.selection.startColumn);
      let e = off(input.selection.endLine, input.selection.endColumn);
      if (s === e) {
        // no selection → anchor the whole clicked line
        const lineStart = off(input.selection.startLine, 1);
        const nl = text.indexOf("\n", lineStart);
        s = lineStart;
        e = nl === -1 ? text.length : nl;
      }
      const anchor = await encodeAnchor(yText, s, e);
      const body = window.prompt("Comment on this code:");
      if (!body || !body.trim()) return;
      try {
        const res = await commentsApi.createThread(pid, {
          filePath: input.filePath,
          anchor,
          body: body.trim(),
          mentions: [],
        });
        commentStoreRef.current?.upsertThread(res.thread);
        reloadActiveComments();
        setOpenCommentThreadId(res.thread.id);
      } catch {
        /* surfaced by the api error path */
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project?.id, reloadActiveComments],
  );

  const handleCommentResolve = useCallback(async () => {
    const pid = project?.id;
    if (!pid || !openCommentThreadId) return;
    try {
      const res = await commentsApi.resolveThread(pid, openCommentThreadId);
      commentStoreRef.current?.upsertThread(res.thread);
      reloadActiveComments();
    } catch {
      /* api error path */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, openCommentThreadId, reloadActiveComments]);

  const handleCommentReopen = useCallback(async () => {
    const pid = project?.id;
    if (!pid || !openCommentThreadId) return;
    try {
      const res = await commentsApi.reopenThread(pid, openCommentThreadId);
      commentStoreRef.current?.upsertThread(res.thread);
      reloadActiveComments();
    } catch {
      /* api error path */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, openCommentThreadId, reloadActiveComments]);

  const handleCommentReply = useCallback(
    async (payload: { body: string; mentions: number[] }) => {
      const pid = project?.id;
      if (!pid || !openCommentThreadId) return;
      try {
        const res = await commentsApi.addReply(pid, openCommentThreadId, payload);
        commentStoreRef.current?.upsertThread(res.thread);
        reloadActiveComments();
      } catch {
        /* api error path */
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project?.id, openCommentThreadId, reloadActiveComments],
  );

  const handleCommentEdit = useCallback(
    async (commentId: string, payload: { body: string; mentions: number[] }) => {
      const pid = project?.id;
      if (!pid) return;
      try {
        const res = await commentsApi.editComment(pid, commentId, payload);
        commentStoreRef.current?.upsertThread(res.thread);
        reloadActiveComments();
      } catch {
        /* api error path */
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project?.id, reloadActiveComments],
  );

  const handleCommentDelete = useCallback(
    async (commentId: string) => {
      const pid = project?.id;
      if (!pid) return;
      try {
        const res = await commentsApi.deleteComment(pid, commentId);
        commentStoreRef.current?.upsertThread(res.thread);
        reloadActiveComments();
      } catch {
        /* api error path */
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project?.id, reloadActiveComments],
  );

  const handleCommentReact = useCallback(
    async (commentId: string, emoji: string) => {
      const pid = project?.id;
      if (!pid) return;
      try {
        const res = await commentsApi.react(pid, commentId, emoji);
        commentStoreRef.current?.upsertThread(res.thread);
        reloadActiveComments();
      } catch {
        /* api error path */
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project?.id, reloadActiveComments],
  );

  const handleCommentUnreact = useCallback(
    async (commentId: string, emoji: string) => {
      const pid = project?.id;
      if (!pid) return;
      try {
        const res = await commentsApi.unreact(pid, commentId, emoji);
        commentStoreRef.current?.upsertThread(res.thread);
        reloadActiveComments();
      } catch {
        /* api error path */
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project?.id, reloadActiveComments],
  );

  const handleMentionGoTo = useCallback(
    (m: CommentMentionWire) => {
      void openAndRevealLocation(handleOpenFile, {
        filePath: m.filePath,
        line: m.line,
        column: 1,
      });
      setOpenCommentThreadId(m.threadId);
      setMentionCards((c) => c.filter((x) => x.commentId !== m.commentId));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Load the active file's threads whenever it changes.
  useEffect(() => {
    if (activeFile && commentStoreRef.current) {
      void commentStoreRef.current.load(activeFile);
      setCommentThreadsByFile(commentStoreRef.current.threadsFor(activeFile));
    } else {
      setCommentThreadsByFile([]);
    }
  }, [activeFile, collabClient]);

  const handleTimelineLoadMore = useCallback(() => {
    if (!project || !timelineNextBefore || timelineLoadingMore) return;
    const pid = project.id;
    setTimelineLoadingMore(true);
    void fetchCollabTimeline(pid, {
      limit: 40,
      before: timelineNextBefore,
    })
      .then((r) => {
        if (pid !== activeProjectIdRef.current) return;
        setTimeline((prev) => mergeTimeline(prev, r.events, 400));
        setTimelineNextBefore(r.nextBefore);
      })
      .catch(() => {
        // M68: the "Load more" control stays visible, so it is the retry.
        notify({
          kind: "warning",
          text: "Couldn't load older activity. Try again.",
          ttl: 6000,
          dedupeKey: "timeline-more",
        });
      })
      .finally(() => setTimelineLoadingMore(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, timelineNextBefore, timelineLoadingMore, notify]);

  const handleWhileAwayDismiss = useCallback(() => {
    const groups = whileAwayGroups;
    setWhileAwayGroups(null);
    if (!groups || !project) return;
    const pid = project.id;
    const newest = groups
      .flatMap((g) => g.events)
      .reduce<TimelineEvent | null>(
        (a, b) => (a && a.at > b.at ? a : b),
        null,
      );
    if (newest) void ackWhileAway(pid, newest.at).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whileAwayGroups, project?.id]);

  // M60: most-recent edit/callout per collaborator, for the popover "last change"
  // line. `timeline` is already sorted newest-first, so first seen wins.
  const lastChangeByUser = useMemo(() => {
    const m = new Map<number, TimelineEvent>();
    for (const e of timeline) {
      if (
        (e.kind === "edit_burst" || e.kind === "callout") &&
        e.actor.userId != null &&
        !m.has(e.actor.userId)
      ) {
        m.set(e.actor.userId, e);
      }
    }
    return m;
  }, [timeline]);

  // M60: fetch the initial timeline page the first time the Team panel opens.
  useEffect(() => {
    if (!teamPanelOpen || timelineLoaded || !collabClient || !project) return;
    const pid = project.id;
    setTimelineLoaded(true);
    void fetchCollabTimeline(pid, { limit: 40 })
      .then((r) => {
        // M68: a slow page for a project the user has since switched away
        // from must not merge into the now-current project's timeline.
        if (pid !== activeProjectIdRef.current) return;
        setTimeline((prev) => mergeTimeline(prev, r.events, 200));
        setTimelineNextBefore(r.nextBefore);
        dismissNoticeKey("timeline-load");
      })
      .catch(() => {
        if (pid !== activeProjectIdRef.current) return;
        // M68: keep `timelineLoaded` true so the effect does not immediately
        // refetch in a tight loop against a down server. The failure is a
        // persistent, retryable notice; Retry flips the flag once.
        notify({
          kind: "warning",
          text: "Couldn't load team activity.",
          ttl: null,
          dedupeKey: "timeline-load",
          actions: [{ label: "Retry", onClick: () => setTimelineLoaded(false) }],
        });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamPanelOpen, timelineLoaded, collabClient, project?.id, notify, dismissNoticeKey]);

  // M58: every attention gesture (Point / Callout / request "Go there")
  // navigates through the SAME open-then-reveal primitive.
  const handleAttentionNavigate = useCallback((evt: AttentionEvent) => {
    void openAndRevealLocation(handleOpenFile, {
      filePath: evt.file,
      line: evt.range.startLine,
      column: evt.range.startColumn,
    });
  }, []);

  // M59: "Go there" on an attention event — ends a follow of a DIFFERENT
  // collaborator (anchor preserved), navigates, does NOT start Follow.
  const handleAttentionGoThere = useCallback(
    (evt: AttentionEvent) => {
      focusOn(evt.author.userId, { follow: false });
      handleAttentionNavigate(evt);
    },
    [focusOn, handleAttentionNavigate],
  );

  // M59: "Follow" from an attention event — navigate then follow the author
  // (only if they are still a connected collaborator).
  const handleAttentionFollow = useCallback(
    (evt: AttentionEvent) => {
      handleAttentionNavigate(evt);
      if (
        collaboratorsRef.current.some((c) => c.userId === evt.author.userId)
      ) {
        focusOn(evt.author.userId, { follow: true });
      }
    },
    [focusOn, handleAttentionNavigate],
  );

  // M59: callout-bubble / point-chip clicks in the Editor dispatch these.
  useEffect(() => {
    const byId = (id: unknown) =>
      typeof id === "string"
        ? attentionRef.current.find((e) => e.id === id) ?? null
        : null;
    const onActivate = (ev: Event) => {
      const e = byId((ev as CustomEvent).detail?.id);
      if (e) handleAttentionGoThere(e);
    };
    const onFollow = (ev: Event) => {
      const e = byId((ev as CustomEvent).detail?.id);
      if (e) handleAttentionFollow(e);
    };
    document.addEventListener("ide-attention-activate", onActivate);
    document.addEventListener("ide-attention-follow", onFollow);
    return () => {
      document.removeEventListener("ide-attention-activate", onActivate);
      document.removeEventListener("ide-attention-follow", onFollow);
    };
  }, [handleAttentionGoThere, handleAttentionFollow]);

  // M61-A: Keep as comment — promote an ephemeral M58 callout to a persistent
  // M61 thread via the existing comment creation path. The original callout
  // keeps its ephemeral lifecycle and is never mutated into persistent state.
  useEffect(() => {
    const onKeep = async (ev: Event) => {
      const id = (ev as CustomEvent).detail?.id;
      if (typeof id !== "string") return;
      const evt = attentionRef.current.find((e) => e.id === id);
      if (!evt) return;
      const pid = project?.id;
      const client = collabClientRef.current;
      if (!pid || !client) return;
      const res = await keepCalloutAsComment({ callout: evt, doc: client.doc, projectId: pid }, keepDeduperRef.current);
      if (!res) return;
      commentStoreRef.current?.upsertThread(res.thread);
      void commentStoreRef.current?.load(evt.file);
      void commentStoreRef.current?.loadUnresolved();
      setOpenCommentThreadId(res.thread.id);
    };
    document.addEventListener("ide-attention-keep-as-comment", onKeep as EventListener);
    return () =>
      document.removeEventListener("ide-attention-keep-as-comment", onKeep as EventListener);
  }, [project?.id]);

  const handleViewCollaborator = useCallback(
    (userId: number) => {
      const c = collaborators.find((x) => x.userId === userId);
      if (c) handleJumpToCollaborator(c);
    },
    [collaborators, handleJumpToCollaborator],
  );

  const handleAttentionDismiss = useCallback(
    (id: string, acted?: boolean) => {
      collabClientRef.current?.dismissAttentionRequest(id, acted);
    },
    [],
  );

  // M58: only ACTIONABLE incoming targeted requests are counted on the chip —
  // never ordinary points/callouts.
  const incomingRequestCount = useMemo(
    () =>
      user
        ? attention.filter(
            (e) =>
              e.kind === "request" &&
              e.targetUserId === user.id &&
              e.author.userId !== user.id,
          ).length
        : 0,
    [attention, user],
  );

  const handleToggleDnd = useCallback((dnd: boolean) => {
    setIsDnd(dnd);
    collabClientRef.current?.setDnd(dnd);
  }, []);

  const handleUserEdit = useCallback(() => {
    if (followedUserId !== null) {
      setFollowedUserId(null);
      setFollowPaused(false);
      setFollowPauseReason("");
    }
  }, [followedUserId]);

  // M48: Update collaboration activity on run events
  useEffect(() => {
    const handleRunStarted = () => {
      collabClientRef.current?.setActivity("running");
    };
    const handleRunStopped = () => {
      collabClientRef.current?.restoreActivity();
    };
    // M53: the run lifecycle dispatches "run-started" / "run-stopped" (from the
    // execution session, previously Output.tsx). The "ide-run-*" names this
    // effect used were never dispatched by anything, so M48's "running"
    // activity never actually fired.
    document.addEventListener("run-started", handleRunStarted);
    document.addEventListener("run-stopped", handleRunStopped);
    return () => {
      document.removeEventListener("run-started", handleRunStarted);
      document.removeEventListener("run-stopped", handleRunStopped);
    };
  }, []);

  // M48: Update collaboration activity on workspace search
  useEffect(() => {
    if (isWorkspaceSearchOpen) {
      collabClientRef.current?.setActivity("searching");
    } else {
      collabClientRef.current?.restoreActivity();
    }
  }, [isWorkspaceSearchOpen]);

  // M48: Update collaboration activity on terminal
  useEffect(() => {
    if (bottomTab === "terminal" && !isBottomCollapsed) {
      collabClientRef.current?.setActivity("terminal");
    } else if (bottomTab !== "terminal") {
      collabClientRef.current?.restoreActivity();
    }
  }, [bottomTab, isBottomCollapsed]);

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
          notify({
            kind: "success",
            text: `Formatted with ${res.formatter}`,
            ttl: 2000,
            surface: "statusbar",
            dedupeKey: "save-toast",
          });
        } else if (res.warning) {
          notify({
            kind: "info",
            text: `Format note: ${res.warning}`,
            ttl: 3000,
            surface: "statusbar",
            dedupeKey: "save-toast",
          });
        }
      } catch (err: any) {
        console.warn("Formatting skipped:", err.message);
      }
    },
    [project, activeFile, resolveLiveFileContent, notify],
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
        // M64: non-blocking, persistent — a save that produced nothing to
        // write must not vanish on a timer. Dismissed explicitly or by the
        // next successful save of this path.
        notify({
          kind: "error",
          text: `Save failed: no editable content available for ${path}`,
          ttl: null,
          dedupeKey: `save-fail:${path}`,
        });
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
        // M64: a successful save clears any standing persistent save-failure
        // notice for this path (DECISION 1 — cleared by a state-changing path).
        dismissNoticeKey(`save-fail:${path}`);
        notify({
          kind: "success",
          text: `Saved ${path.split("/").pop()}`,
          ttl: 2000,
          surface: "statusbar",
          dedupeKey: "save-toast",
        });
      } catch (err: any) {
        handleSaveError(err, path, {
          // Not a failure: the server safely refused to overwrite a
          // collaborator's unsaved edits. Surface it as a truthful,
          // non-blocking conflict notice (the shared "ext-mutation" slot) and
          // leave the buffer dirty so the user can retry once the collaborator
          // saves.
          onCollabConflict: (message) => {
            notify({
              kind: "warning",
              text: message,
              ttl: 8000,
              dedupeKey: "ext-mutation",
            });
          },
          // M64: real save failure — non-blocking, persistent, deduped per
          // path. No blocking dialog; it never auto-dismisses.
          onFailure: (message) => {
            notify({
              kind: "error",
              text: `Save failed: ${message}`,
              ttl: null,
              dedupeKey: `save-fail:${path}`,
            });
          },
        });
      }
    };

    document.addEventListener("ide-save", handleSave);
    return () => document.removeEventListener("ide-save", handleSave);
  }, [
    project,
    formatOnSave,
    resolveLiveFileContent,
    notify,
    dismissNoticeKey,
  ]);

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

      // M45: switch to output tab and expand drawer if collapsed. Must be
      // flushSync — see the identical M44 comment on the ide-install effect
      // below for why: React 18 batches this state update, so without
      // flushSync, Output isn't mounted (and its ide-run-confirmed listener
      // isn't registered) by the time the dispatch below runs whenever the
      // user wasn't already on the Output tab. Live-confirmed: Run from the
      // Terminal or Problems tab silently did nothing pre-fix — the tab
      // switched to Output but no run ever started. The dirty-file-save
      // await above only masked this when there were actual unsaved
      // changes to save.
      flushSync(() => {
        setBottomTab("output");
        setIsBottomCollapsed(false);
      });

      // Dispatch confirmed execution event
      document.dispatchEvent(
        new CustomEvent("ide-run-confirmed", {
          detail: { language, activeFile: reqFile, langDisplay },
        }),
      );
    };

    document.addEventListener("ide-run", handleRunRequest);
    return () => document.removeEventListener("ide-run", handleRunRequest);
  }, [project, openFiles, resolveLiveFileContent, setIsBottomCollapsed]);

  // M43/M44: Output (which owns the actual install request/stream) only
  // exists in the DOM while bottomTab === "output" and the panel isn't
  // collapsed. M44's live browser verification proved that plain
  // setBottomTab("output") followed by an immediate dispatch is NOT
  // sufficient to guarantee this: React 18 batches that state update, so
  // when Output wasn't already mounted (e.g. the user is on the Problems
  // tab, which every failing run with diagnostics auto-switches to —
  // exactly the case M44's own "Install Dependencies" action fires from),
  // ide-install-confirmed fired into a DOM where nothing was listening yet
  // and the install silently never started. flushSync forces the tab
  // switch (and Output's mount + its ide-install-confirmed listener
  // registration) to commit synchronously before the dispatch below runs.
  useEffect(() => {
    const handleInstallRequest = () => {
      if (!project) return;
      flushSync(() => {
        setBottomTab("output");
        setIsBottomCollapsed(false);
      });
      document.dispatchEvent(new Event("ide-install-confirmed"));
    };

    document.addEventListener("ide-install", handleInstallRequest);
    return () =>
      document.removeEventListener("ide-install", handleInstallRequest);
  }, [project, setIsBottomCollapsed]);

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
  }, [setIsBottomCollapsed]);

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
        shortcut: kbLabel("workbench.action.quickOpen", false),
        macShortcut: kbLabel("workbench.action.quickOpen", true),
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
        shortcut: kbLabel("workbench.action.showCommands", false),
        macShortcut: kbLabel("workbench.action.showCommands", true),
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
      {
        id: "comments.action.nextInFile",
        title: "Comments: Next in File",
        description: "Navigate to the next unresolved comment in the current file",
        category: "Navigation",
        handler: () => {
          const file = activeFileRef.current;
          if (!file) return;
          const store = commentStoreRef.current;
          if (!store) return;
          const next = nextInFile(store.threadsFor(file), openCommentThreadIdRef.current);
          if (!next) return;
          void openAndRevealLocation(handleOpenFile, { filePath: next.filePath, line: next.anchor.startLine, column: 1 });
          setOpenCommentThreadId(next.id);
        },
      },
      {
        id: "comments.action.previousInFile",
        title: "Comments: Previous in File",
        description: "Navigate to the previous unresolved comment in the current file",
        category: "Navigation",
        handler: () => {
          const file = activeFileRef.current;
          if (!file) return;
          const store = commentStoreRef.current;
          if (!store) return;
          const prev = previousInFile(store.threadsFor(file), openCommentThreadIdRef.current);
          if (!prev) return;
          void openAndRevealLocation(handleOpenFile, { filePath: prev.filePath, line: prev.anchor.startLine, column: 1 });
          setOpenCommentThreadId(prev.id);
        },
      },
      {
        id: "comments.action.goToUnresolved",
        title: "Comments: Go to Unresolved",
        description: "Navigate to the next unresolved comment across the project",
        category: "Navigation",
        handler: () => {
          const store = commentStoreRef.current;
          if (!store) return;
          const next = nextUnresolved(store.unresolved(), openCommentThreadIdRef.current);
          if (!next) return;
          void openAndRevealLocation(handleOpenFile, { filePath: next.filePath, line: next.anchor.startLine, column: 1 });
          setOpenCommentThreadId(next.id);
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
          const next = !formatOnSave;
          void handleUpdatePreferences({ formatOnSave: next });
          notify({
            kind: "info",
            text: `Format on Save: ${next ? "Enabled" : "Disabled"}`,
            ttl: 2500,
            surface: "statusbar",
            dedupeKey: "save-toast",
          });
        },
      },
      {
        id: "workbench.action.toggleSidebar",
        title: "Toggle Sidebar",
        description: "Show or hide the workspace file tree",
        category: "UI",
        shortcut: kbLabel("workbench.action.toggleSidebar", false),
        macShortcut: kbLabel("workbench.action.toggleSidebar", true),
        handler: () => setIsSidebarHidden((prev) => !prev),
      },
      {
        id: "workbench.action.toggleBottomPanel",
        title: "Toggle Bottom Console Drawer",
        description: "Expand or collapse the output/terminal drawer",
        category: "UI",
        shortcut: kbLabel("workbench.action.toggleBottomPanel", false),
        macShortcut: kbLabel("workbench.action.toggleBottomPanel", true),
        handler: () => setIsBottomCollapsed((prev) => !prev),
      },
      {
        id: "workbench.action.saveFile",
        title: "Save Active File",
        description: "Save dirty buffer to workspace disk storage",
        category: "UI",
        shortcut: kbLabel("workbench.action.saveFile", false),
        macShortcut: kbLabel("workbench.action.saveFile", true),
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
        id: "workbench.action.manageSecrets",
        title: "Manage Environment Variables & Secrets",
        description:
          "Owner-only: add encrypted project secrets injected into runs and terminals",
        category: "Collaboration",
        available: () => !!project && projectRole === "owner",
        handler: () => setIsSecretsModalOpen(true),
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
    handleUpdatePreferences,
    handleFormatDocument,
    handleSaveActiveFile,
    handleTriggerAIAction,
    handleOpenFile,
    notify,
    setIsSidebarHidden,
    setIsBottomCollapsed,
    resolvedKeymap,
    kbLabel,
  ]);

  // Central Keyboard Shortcuts Dispatcher (M70: keymap-driven)
  useKeyboardShortcuts(
    {
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
    },
    true,
    resolvedKeymap,
  );

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
      // M67: persist the settled dimension once per completed drag gesture —
      // never on the individual mousemoves above.
      if (isDraggingSidebar) persistSidebarWidth();
      if (isDraggingBottom) persistBottomHeight();
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
  }, [
    isDraggingSidebar,
    isDraggingBottom,
    persistSidebarWidth,
    persistBottomHeight,
    setSidebarWidth,
    setBottomHeight,
  ]);

  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter(
    (d) => d.severity === "warning",
  ).length;

  // M64: the save/format status-bar badge (surface:"statusbar") — kept in its
  // existing footer slot, only its lifecycle now runs through useNotices.
  const statusbarNotice =
    activeNotices.find((n) => n.surface === "statusbar")?.text ?? null;

  const ideLayout = (
    <div className="ide-layout">
      {/* Liquid Glass Sidebar */}
      {!isSidebarHidden && (
        <Sidebar
          user={user}
          projects={projects}
          project={project}
          onSelectProject={handleSelectProject}
          onCreateProject={loadProjects}
          onProjectBootstrapped={handleProjectBootstrapped}
          tree={tree}
          treeStatus={treeStatus}
          onRetryTree={handleRetryTree}
          onOpenFile={handleOpenFile}
          activeFile={activeFile}
          onLogout={onLogout}
          refreshTree={loadTree}
          width={sidebarWidth}
          onOpenTour={handleOpenTour}
          onOpenSettings={handleOpenSettingsFromSidebar}
          collaborators={collaboratorsForTree}
          runStatuses={runStatuses}
          currentUserId={user.id}
          commentCountsByFile={commentCountsByFile}
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
          runStatuses={runStatuses}
          collabStatus={collabStatus}
          isDnd={isDnd}
          followingUserId={followedUserId}
          onToggleDnd={handleToggleDnd}
          onFollowCollaborator={handleFollowCollaborator}
          onJumpToCollaborator={handleJumpToCollaborator}
          onOpenShareModal={() => setIsShareModalOpen(true)}
          onOpenSecretsModal={
            projectRole === "owner"
              ? () => setIsSecretsModalOpen(true)
              : undefined
          }
          onOpenTeamPanel={() => setTeamPanelOpen((v) => !v)}
          incomingRequestCount={incomingRequestCount}
          attention={attention}
        />
        {user && (
          <AttentionTray
            events={attention}
            currentUserId={user.id}
            rateLimited={hasNotice("attn-rate")}
            onNavigate={handleAttentionGoThere}
            onDismiss={handleAttentionDismiss}
            onFollow={(e) => {
              handleAttentionFollow(e);
              handleAttentionDismiss(e.id, true);
            }}
            mentionCards={mentionCards}
            onMentionGoTo={handleMentionGoTo}
            onMentionDismiss={(commentId) =>
              setMentionCards((c) => c.filter((x) => x.commentId !== commentId))
            }
          />
        )}
        {teamPanelOpen && user && (
          <div className="team-panel-anchor">
            <TeamPanel
              collaborators={collaborators}
              runStatuses={runStatuses}
              currentUserId={user.id}
              isDnd={isDnd}
              followingUserId={followedUserId}
              onClose={() => setTeamPanelOpen(false)}
              onSetIntent={(t) => collabClientRef.current?.setIntent(t)}
              onToggleDnd={handleToggleDnd}
              onFollow={handleFollowCollaborator}
              onJump={handleJumpToCollaborator}
              timeline={timeline}
              timelineHasMore={timelineNextBefore != null}
              timelineLoadingMore={timelineLoadingMore}
              onTimelineLoadMore={handleTimelineLoadMore}
              onTimelineNavigate={handleTimelineNavigate}
              lastChangeByUser={lastChangeByUser}
            />
            <CommentsPanel
              activeFile={activeFile}
              threads={commentThreadsByFile}
              unresolved={unresolvedComments}
              showResolved={showResolvedComments}
              onToggleResolved={setShowResolvedComments}
              onNavigate={handleCommentNavigate}
            />
          </div>
        )}

        {openCommentThread && user && (
          <div
            className="comment-thread-overlay"
            style={teamPanelOpen ? { right: 340 } : undefined}
          >
            <CommentThread
              thread={openCommentThread}
              currentUserId={user.id}
              members={commentMembers}
              projectOwnerId={projectRole === "owner" ? user.id : undefined}
              onReply={handleCommentReply}
              onEdit={handleCommentEdit}
              onDelete={handleCommentDelete}
              onResolve={handleCommentResolve}
              onReopen={handleCommentReopen}
              onReact={handleCommentReact}
              onUnreact={handleCommentUnreact}
              onClose={() => setOpenCommentThreadId(null)}
            />
          </div>
        )}

        {whileAwayGroups && (
          <WhileYouWereAway
            groups={whileAwayGroups}
            colorForUser={(uid) =>
              collaboratorsRef.current.find((c) => c.userId === uid)?.color ??
              "#89b4fa"
            }
            onNavigate={handleTimelineNavigate}
            onDismiss={handleWhileAwayDismiss}
            autoDismissMs={20000}
          />
        )}

        {/* Central Editor & Bottom Workspace */}
        <div className="ide-workspace" style={{ flexDirection: "column" }}>
          <div className="ide-editor-area" style={{ position: "relative" }}>
            {/* M63: connection + unsynced-edit state, always in the editor
                region and independent of the collaborator avatar stack. */}
            <CollabConnectionBanner
              status={collabStatus}
              pendingLocalUpdates={pendingCollabUpdates}
              reconnectExhausted={collabReconnectExhausted}
              onRetry={() => collabClientRef.current?.retry()}
            />
            {followedUser && (
              <FollowBanner
                followedUser={followedUser}
                isPaused={followPaused}
                pauseReason={followPauseReason}
                onStopFollowing={handleStopFollowing}
                hasAnchor={followedUserId != null || hasNotice("follow-left")}
                onReturnToLocation={handleReturnToMyLocation}
                followedRange={followedFocusRange}
              />
            )}
            {/* M64: the "X left" follow notice — lifecycle in useNotices,
                still rendered here in the editor region with its actions. */}
            {activeNotices
              .filter((n) => n.surface === "editor")
              .map((n) => (
                <div
                  key={n.id}
                  className="follow-left-notice"
                  role="status"
                >
                  <span>⚠ {n.text}</span>
                  {n.actions?.map((a) => (
                    <button
                      key={a.label}
                      type="button"
                      onClick={a.onClick}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              ))}
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
                  resolvedTheme={resolvedTheme}
                  saveChord={resolvedKeymap.byCommand["workbench.action.saveFile"]}
                  diagnostics={diagnostics}
                  collabClient={collabClient}
                  collaborators={collaborators}
                  currentUserId={user.id}
                  attention={attention}
                  onAttentionNavigate={handleAttentionNavigate}
                  onViewCollaborator={handleViewCollaborator}
                  onUserEdit={handleUserEdit}
                  isReadOnly={projectRole === "viewer"}
                  liveApiRef={liveApiRef}
                  editorViewApiRef={editorViewApiRef}
                  preferences={preferences}
                  commentThreads={commentThreadsByFile}
                  projectId={project?.id}
                  commentCountsByFile={commentCountsByFile}
                  onOpenCommentThread={handleOpenCommentThread}
                  onCreateComment={handleCreateComment}
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

                <button
                  className={`panel-tab ${bottomTab === "git" && !isBottomCollapsed ? "active" : ""}`}
                  onClick={() => {
                    setBottomTab("git");
                    setIsBottomCollapsed(false);
                  }}
                  role="tab"
                >
                  <IconGitBranch size={12} />
                  <span>Source Control</span>
                  {gitInitialized && gitBranch && (
                    <span
                      className="glass-badge glass-badge-info"
                      style={{
                        fontSize: "9px",
                        padding: "1px 5px",
                        marginLeft: "4px",
                      }}
                    >
                      {gitBranch}
                    </span>
                  )}
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
                  <Output
                    project={project}
                    onRefreshTree={loadTree}
                    sharedRunOutputs={sharedRunOutputs}
                    runStatuses={runStatuses}
                    currentUserId={user.id}
                    collabConnected={collabStatus === "connected"}
                  />
                )}
                {bottomTab === "problems" && (
                  <ProblemsPanel
                    diagnostics={diagnostics}
                    onSelectDiagnostic={(filePath, line, column) => {
                      // The diagnostic's file may not be an open tab (an error
                      // in a file the user never opened). Open it first —
                      // ide-reveal-location only acts on already-open tabs.
                      void openAndRevealLocation(handleOpenFile, {
                        filePath,
                        line,
                        column,
                      });
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
                    onInstallDependency={() => {
                      // M44: identical to Toolbar's own Install button — the
                      // existing ide-install listener just above (added in
                      // M43) switches bottomTab back to "output" and hands
                      // off to Output's install effect, which owns the
                      // actual request from here.
                      document.dispatchEvent(new Event("ide-install"));
                    }}
                  />
                )}
                {bottomTab === "resources" && (
                  <ResourcesView project={project} />
                )}
                {bottomTab === "terminal" && (
                  <Terminal project={project} resolvedTheme={resolvedTheme} />
                )}
                {bottomTab === "preview" && project && (
                  <Preview key={project.id} project={project} />
                )}
                {bottomTab === "git" && (
                  <SourceControlPanel
                    project={project}
                    projectRole={projectRole}
                    getDirtyOpenPaths={getDirtyOpenPaths}
                    onReconcileBuffers={reconcileExternalFileChanges}
                    onGitState={(s) => {
                      setGitInitialized(s.initialized);
                      setGitBranch(s.branch);
                    }}
                  />
                )}
              </div>
            )}
          </div>
        </div>

        {/* M64: unified transient-notice stack — save feedback, external
            mutation, and the persistent invalid-route / reconcile notices. */}
        <NoticeStack
          notices={activeNotices.filter((n) => n.surface === "stack")}
          onDismiss={dismissNotice}
        />

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
            {statusbarNotice && (
              <span
                className="glass-badge glass-badge-success"
                style={{ animation: "fadeIn 150ms ease" }}
              >
                <IconCheck size={9} />
                <span>{statusbarNotice}</span>
              </span>
            )}
            <span
              className="ide-statusbar-item"
              onClick={() => {
                const next = !formatOnSave;
                void handleUpdatePreferences({ formatOnSave: next });
                notify({
                  kind: "info",
                  text: `Format on Save: ${next ? "On" : "Off"}`,
                  ttl: 2000,
                  surface: "statusbar",
                  dedupeKey: "save-toast",
                });
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
        projectRole={projectRole}
        onReplaceApplied={handleReplaceApplied}
        onSelectResult={(filePath, line, column, matchLength) =>
          // A result's target file may not already be an open tab — unlike
          // setActiveFile (which only switches among already-open tabs),
          // handleOpenFile fetches+opens it first (no-op if already open),
          // so the reveal always has a loaded model to act on.
          openAndRevealLocation(handleOpenFile, {
            filePath,
            line,
            column,
            matchLength,
          })
        }
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

      {/* Project Environment Variables & Secrets Modal (owner only) */}
      {project && projectRole === "owner" && (
        <ProjectSecretsModal
          projectId={project.id}
          projectName={project.name}
          isOpen={isSecretsModalOpen}
          onClose={() => setIsSecretsModalOpen(false)}
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
        username={user.username}
        userId={user.id}
        isDemo={isDemo}
      />
    </div>
  );

  // M53: the execution session owns the /ws/execute run + install stream for
  // the lifetime of this project, NOT the <Output> component's mount. Wrapping
  // the whole layout here means switching the bottom panel away from Output (or
  // collapsing it) can never unmount the session and kill a running program.
  return (
    <ExecutionSessionProvider projectId={project?.id ?? null}>
      {ideLayout}
    </ExecutionSessionProvider>
  );
}
