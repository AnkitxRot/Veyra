export type DebugSessionState =
  | "idle"
  | "starting"
  | "running"
  | "paused"
  | "stopping"
  | "terminated"
  | "failed"
  | "unavailable";

export interface DebugStatus {
  type: "status";
  state: DebugSessionState;
  language: string | null;
  entryFile?: string | null;
  message?: string;
}

export interface DebugFrame {
  id: number;
  name: string;
  path: string | null;
  line: number;
  column: number;
}

export interface DebugScope {
  name: string;
  variablesReference: number;
  expensive?: boolean;
}

export interface DebugVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

export interface DebugBreakpoint {
  line: number;
  verified: boolean;
}

export const DEBUG_STATUS_EVENT = "ide-debug-status";
export const DEBUG_BREAKPOINTS_EVENT = "ide-debug-breakpoints";
export const DEBUG_EXECUTION_EVENT = "ide-debug-execution";
export const DEBUG_TOGGLE_BP_EVENT = "ide-debug-toggle-breakpoint";
export const DEBUG_STARTED_EVENT = "debug-started";
export const DEBUG_STOPPED_EVENT = "debug-stopped";
