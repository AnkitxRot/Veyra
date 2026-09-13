export interface User {
  id: number;
  username: string;
  role?: "user" | "admin";
  isDemo?: boolean;
}

export interface UserPreferences {
  fontSize: number;
  tabSize: number;
  wordWrap: "off" | "on" | "wordWrapColumn" | "bounded";
  minimap: boolean;
  lineNumbers: "on" | "off" | "relative" | "interval";
  cursorBlinking: "blink" | "smooth" | "phase" | "expand" | "solid";
  renderWhitespace: "none" | "boundary" | "selection" | "trailing" | "all";
  /** M66: run the formatter on save. Moved out of browser localStorage into
   *  the typed, server-persisted preference store. */
  formatOnSave: boolean;
  /** M67: IDE panel layout — the four user-scoped layout dimensions that used
   *  to be throwaway IDE.tsx component state (reset on every reload). */
  sidebarWidth: number;
  bottomHeight: number;
  sidebarHidden: boolean;
  bottomCollapsed: boolean;
  /** M69: unified appearance. "system" follows the OS `prefers-color-scheme`;
   *  "dark" / "light" pin the effective theme. */
  theme: "system" | "dark" | "light";
  /** M70: configurable keybindings — command ID -> canonical chord, storing
   *  ONLY the commands the user has remapped (`{}` = all defaults). The
   *  command set + chord grammar live in `src/keymap/`. */
  keymap: Record<string, string>;
  updatedAt?: string;
}

/** The editor-tab subset of {@link UserPreferences} — the keys the settings
 *  modal owns. Layout keys persist through direct IDE interaction, never the
 *  modal, so a "Reset Defaults" there must not rewrite the user's layout. */
export const EDITOR_PREFERENCE_KEYS = [
  "fontSize",
  "tabSize",
  "wordWrap",
  "minimap",
  "lineNumbers",
  "cursorBlinking",
  "renderWhitespace",
  "formatOnSave",
  // M69: the appearance preference is edited in the same modal.
  "theme",
] as const;

export interface Project {
  id: string;
  name: string;
  language?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  oom: boolean;
  durationMs: number;
  language: string;
  type:
    | "success"
    | "compile_error"
    | "missing_toolchain"
    | "no_language"
    | "no_main_file"
    | "not_runnable";
  mainFile?: string;
}

export interface ToolInfo {
  available: boolean;
  version: string | null;
  path: string | null;
}

export type Tools = Record<string, ToolInfo>;

export interface ContainerStats {
  running: boolean;
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  pids: number;
  netIO: string;
  blockIO: string;
}

export interface RunRecord {
  id: string;
  project_id: string;
  user_id: number;
  language: string;
  file_path: string;
  status: string;
  exit_code: number | null;
  signal: string | null;
  duration_ms: number;
  peak_memory_bytes: number;
  created_at: string;
  username?: string;
  project_name?: string;
}

// M54: Collaborative Run Awareness. Server-authoritative, ephemeral — the
// browser only ever RECEIVES these (via the collaboration room), never sends
// them. Carries no stdout/stderr/command/env/secret content.
export type RunState = "running" | "success" | "failed" | "stopped";

export interface RunStatusEntry {
  executionId: string;
  userId: number;
  username: string;
  state: RunState;
  file: string | null;
  language: string | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
}

// M65: Shared Run Output. A bounded, ephemeral replay of another collaborator's
// run stdout/stderr, delivered to owner/editor room members only (never
// viewers, never sent by the browser). Carries no command/env/secret content.
export interface RunOutputChunk {
  stream: "stdout" | "stderr";
  data: string;
}

export interface SharedRunOutput {
  executionId: string;
  chunks: RunOutputChunk[];
  /** True once the server or the client dropped older output past its bound. */
  truncated: boolean;
}

export interface SnapshotRecord {
  id: string;
  project_id: string;
  user_id: number;
  name: string;
  size_bytes: number;
  created_at: string;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  language: string;
  /** Runnable entry file the IDE opens automatically after creation. */
  entryFile?: string;
}

// M51 — Local Git version control

export interface GitFileEntry {
  path: string;
  index: string;
  worktree: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  origPath?: string;
}

export interface GitRemote {
  name: string;
  url: string;
}

export interface GitStatus {
  initialized: boolean;
  branch: string | null;
  detached: boolean;
  hasCommits: boolean;
  clean: boolean;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  remote?: GitRemote | null;
  credentialsConfigured?: boolean;
}

export interface GitDiffLine {
  type: "add" | "del" | "context" | "meta";
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface GitDiffHunk {
  header: string;
  lines: GitDiffLine[];
}

export interface GitFileDiff {
  path: string;
  staged: boolean;
  binary: boolean;
  truncated: boolean;
  isNew: boolean;
  isDeleted: boolean;
  hunks: GitDiffHunk[];
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  shortHash: string | null;
  unborn: boolean;
}

// Admin Control Plane Types

export type BackupHealthStatus = "ok" | "stale" | "critical" | "never";

export interface AdminBackupHealth {
  database: {
    status: BackupHealthStatus;
    backupCount: number;
    latestBackupCreatedAt: string | null;
    latestBackupAgeMs: number | null;
    warningAgeMs: number;
    criticalAgeMs: number;
  };
  workspaces: {
    status: BackupHealthStatus;
    totalProjects: number;
    coveredProjects: number;
    uncoveredProjects: number;
    coveragePercent: number;
    oldestLatestBackupAgeMs: number | null;
    warningAgeMs: number;
    criticalAgeMs: number;
  };
}

export interface AdminOverviewData {
  system: {
    status: string;
    uptimeSeconds: number;
    nodeVersion: string;
    platform: string;
    arch: string;
    memoryRssBytes: number;
  };
  infrastructure: {
    docker: boolean;
    runnerImage: boolean;
    database: boolean;
    cgroupRoot: string;
    maxSandboxes: number;
    projectQuota: number;
  };
  counters: {
    totalUsers: number;
    demoSessions: number;
    totalProjects: number;
    activeSandboxes: number;
    totalExecutions: number;
  };
  aggregateTelemetry: {
    cpuPercent: number;
    memoryUsageBytes: number;
    memoryLimitBytes: number;
    pids: number;
  };
}

export interface AdminSandboxData {
  containerId: string;
  projectId: string;
  projectName: string;
  ownerUsername: string;
  ports: Record<number, number>;
  lastUsed: number;
  idleSeconds: number;
  status: "running" | "idle";
  cpuPercent: number;
  memoryUsageBytes: number;
  pids: number;
  limits: {
    memoryBytes: number;
    cpuQuota: number;
    pidsLimit: number;
  };
}

export interface AdminExecutionMetrics {
  totalRuns: number;
  successCount: number;
  failureCount: number;
  timeoutCount: number;
  oomCount: number;
  avgDurationMs: number;
  successRatePercent: number;
}

export interface AdminUserData {
  id: number;
  username: string;
  role: "user" | "admin";
  created_at: string;
  project_count: number;
  execution_count: number;
  isDemo?: boolean;
}

export interface AdminProjectData {
  id: string;
  name: string;
  language: string;
  owner_id: number;
  owner_username: string;
  created_at: string;
  updated_at: string;
  snapshot_count: number;
  run_count: number;
}

export interface AdminAuditRecord {
  id: number;
  user_id: number | null;
  username?: string | null;
  project_id: string | null;
  project_name?: string | null;
  event_type: string;
  details: Record<string, any>;
  ip_address: string | null;
  created_at: string;
}

export interface AdminUserDetails {
  user: AdminUserData;
  counts: {
    projectCount: number;
    executionCount: number;
    snapshotCount: number;
    activeSandboxesCount: number;
  };
  projects: Array<{
    id: string;
    name: string;
    language: string;
    created_at: string;
    updated_at: string;
  }>;
  snapshots: Array<{
    id: string;
    project_id: string;
    name: string;
    size_bytes: number;
    created_at: string;
    project_name?: string;
  }>;
  recentExecutions: RunRecord[];
  activeSandboxes: AdminSandboxData[];
  recentAuditLogs: AdminAuditRecord[];
}

export interface LatencySnapshot {
  count: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface GcKindStats {
  count: number;
  totalDurationMs: number;
}

export interface AdminObservabilityData {
  timestamp: string;
  eventLoopLagMs: {
    minMs: number;
    maxMs: number;
    meanMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  } | null;
  dbCalls: {
    overall: LatencySnapshot;
    byOperation: Record<string, LatencySnapshot>;
  };
  activeWsConnections: number;
  activeCollabRooms: number;
  activeSandboxes: number;
  totalCollabBroadcastSends: number;
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
  };
  cpuUsageMicros: {
    userMicros: number;
    systemMicros: number;
  };
  gc: Record<string, GcKindStats>;
}

// ---------------------------------------------------------------------------
// M60: Change Attribution & Collaboration History.
// Kept hand-synced with backend/src/collab/timeline.ts (TimelineEvent) and
// backend/src/collab/historian.ts (CollabChangeWire) — there is no shared
// cross-package module (same convention as the rest of this file).
// ---------------------------------------------------------------------------

export type TimelineEventKind =
  | "edit_burst"
  | "callout"
  | "run"
  | "commit"
  | "snapshot"
  | "comment";

export interface TimelineEvent {
  /** "<source>:<sourceId>" — globally unique; the pagination tie-break key. */
  id: string;
  kind: TimelineEventKind;
  /** ISO ms — the primary sort key. */
  at: string;
  actor: { userId: number | null; username: string };
  filePath?: string;
  lineRange?: { startLine: number; endLine: number };
  title: string;
  subtitle?: string;
  navigable: boolean;
}

export interface TimelinePage {
  events: TimelineEvent[];
  nextBefore: string | null;
}

export interface WhileAwayGroup {
  userId: number;
  username: string;
  events: TimelineEvent[];
}

export interface WhileAwayResponse {
  since: string;
  events: TimelineEvent[];
  groupedByAuthor: WhileAwayGroup[];
}

/** The receive-only MESSAGE_CUSTOM frame the server broadcasts on burst close. */
export interface CollabChangeWire {
  type: "collab_change";
  id: string;
  kind: "edit_burst" | "callout";
  at: string;
  actor: { userId: number; username: string };
  filePath: string;
  lineRange: { startLine: number; endLine: number } | null;
  updateCount: number;
  linesAdded: number;
  linesRemoved: number;
  calloutPreview?: string;
}

// ---------------------------------------------------------------------------
// M61-A: Contextual Comments. Hand-synced with backend/src/comments/routes.ts
// (CommentThreadDTO / CommentDTO) and backend/src/collab/manager.ts
// (comment_event / comment_mention wire frames).
// ---------------------------------------------------------------------------

/** Opaque anchor payload — the client encodes/resolves it against the live
 *  Y.Text; the server stores relStart/relEnd verbatim and never decodes them. */
export interface CommentAnchor {
  relStart: string | null;
  relEnd: string | null;
  slice: string;
  startLine: number;
  endLine: number;
  prefixHash: string;
}

export interface CommentReactionGroup {
  emoji: string;
  userIds: number[];
}

export interface CommentDTO {
  id: string;
  threadId: string;
  parentId: string | null;
  authorId: number;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  reactions: CommentReactionGroup[];
}

export interface CommentThreadDTO {
  id: string;
  projectId: string;
  filePath: string;
  anchor: CommentAnchor;
  anchorStatus: "ok" | "stale";
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBy: number | null;
  root: CommentDTO;
  replies: CommentDTO[];
  mentions: { userId: number; username: string }[];
}

/** Receive-only MESSAGE_CUSTOM cache-invalidation ping — carries no bodies. */
export interface CommentEventWire {
  type: "comment_event";
  threadId: string;
  filePath: string;
  kind: "created" | "replied" | "edited" | "deleted" | "resolved" | "reopened" | "reacted";
  at: number;
}

/** Targeted MESSAGE_CUSTOM mention ping (M58 targeted-delivery semantics). */
export interface CommentMentionWire {
  type: "comment_mention";
  threadId: string;
  commentId: string;
  filePath: string;
  line: number;
  author: { userId: number; username: string };
  preview: string;
  at: number;
}

/** Receive-only profile-bundle invalidation ping (M61-C). */
export interface ProfileEventWire {
  type: "profile_event";
  userId: number;
}

/**
 * M62: the self-service profile identity, exactly as `GET`/`PUT
 * /api/auth/profile` return it. Every field is independently nullable — a
 * `null` means "not set" / "cleared", never an empty string.
 */
export interface UserProfile {
  displayName: string | null;
  pronouns: string | null;
  bio: string | null;
  updatedAt: string | null;
  /** M72: 0 when no avatar is set, else a monotonic cache-buster. Never a
   *  media id or path. */
  avatarVersion: number;
}

/**
 * M62: the Profile tab's local form state. Always strings (a controlled
 * input never holds `null`); the `null` <-> "" mapping happens only at the
 * API boundary.
 */
export interface ProfileDraft {
  displayName: string;
  pronouns: string;
  bio: string;
}

/**
 * M62: one collaborator as `GET /api/projects/:id/collaborators` returns it.
 * `displayName` is the server-resolved EFFECTIVE label (never null — it
 * falls back to `username` server-side). `userId` / `username` remain the
 * technical identity for keys, mentions, ownership and attribution.
 */
export interface CollaboratorInfo {
  userId: number;
  username: string;
  displayName: string;
  /** M72: avatar cache-buster (0 = none). Optional — an older server that
   *  predates M72 omits it and every surface falls back to initials. */
  avatarVersion?: number;
  role: "owner" | "editor" | "viewer";
  createdAt: string;
}
