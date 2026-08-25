export interface User {
  id: number;
  username: string;
  role?: 'user' | 'admin';
  isDemo?: boolean;
}

export interface UserPreferences {
  fontSize: number;
  tabSize: number;
  wordWrap: 'off' | 'on' | 'wordWrapColumn' | 'bounded';
  minimap: boolean;
  lineNumbers: 'on' | 'off' | 'relative' | 'interval';
  cursorBlinking: 'blink' | 'smooth' | 'phase' | 'expand' | 'solid';
  renderWhitespace: 'none' | 'boundary' | 'selection' | 'trailing' | 'all';
  updatedAt?: string;
}

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
  type: 'file' | 'dir';
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
  type: 'success' | 'compile_error' | 'missing_toolchain' | 'no_language' | 'no_main_file' | 'not_runnable';
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
}

// Admin Control Plane Types
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
  status: 'running' | 'idle';
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
  role: 'user' | 'admin';
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
