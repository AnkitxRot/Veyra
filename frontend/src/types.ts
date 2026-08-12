export interface User {
  id: number;
  username: string;
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
