/**
 * Typed registry of the document-level IDE events. The runtime transport is
 * unchanged (plain DOM events, so tests and non-React code can still dispatch
 * them); this only gives `document.addEventListener("ide-…")` and
 * `new CustomEvent("ide-…")` call sites a checked `detail`.
 */
export interface IdeEventDetails {
  "ide-save": { path: string | null; content?: string };
  "ide-live-content-change": { path: string };
  "ide-ai-action": {
    action: "explain" | "refactor" | "generate_tests" | "optimize";
    path: string | null;
    selectedCode?: string;
    selectionRange?: { startLine: number; endLine: number; [key: string]: unknown } | null;
  };
  "ide-restore-view-state": { filePath: string; viewState: unknown; cursor: unknown };
  "ide-reveal-location": {
    filePath: string;
    line: number;
    column?: number;
    matchLength?: number;
  };
  "ide-open-and-reveal": { filePath: string; line: number; column: number };
  "ide-run": { language: string; activeFile: string | null; langDisplay: string };
  "ide-run-confirmed": { language: string; activeFile: string | null; langDisplay: string };
  "ide-debug": { activeFile: string | null };
  "ide-debug-confirmed": { activeFile: string | null };
  "ide-attention-activate": { id: string };
  "ide-attention-follow": { id: string };
  "ide-attention-keep-as-comment": { id: string };
  "ide-execution-result": { result: unknown; activeFile?: string | null; [key: string]: unknown };
}

/** Events that carry no payload. */
export type IdeSignalEvent =
  | "ide-stop"
  | "ide-install"
  | "ide-install-confirmed"
  | "ide-workflow-run-all"
  | "ide-focus-attention-tray"
  | "run-started"
  | "run-stopped"
  | "install-started"
  | "install-stopped"
  | "debug-started"
  | "debug-stopped";

declare global {
  interface DocumentEventMap {
    "ide-save": CustomEvent<IdeEventDetails["ide-save"]>;
    "ide-live-content-change": CustomEvent<IdeEventDetails["ide-live-content-change"]>;
    "ide-ai-action": CustomEvent<IdeEventDetails["ide-ai-action"]>;
    "ide-restore-view-state": CustomEvent<IdeEventDetails["ide-restore-view-state"]>;
    "ide-reveal-location": CustomEvent<IdeEventDetails["ide-reveal-location"]>;
    "ide-open-and-reveal": CustomEvent<IdeEventDetails["ide-open-and-reveal"]>;
    "ide-run": CustomEvent<IdeEventDetails["ide-run"]>;
    "ide-run-confirmed": CustomEvent<IdeEventDetails["ide-run-confirmed"]>;
    "ide-debug": CustomEvent<IdeEventDetails["ide-debug"]>;
    "ide-debug-confirmed": CustomEvent<IdeEventDetails["ide-debug-confirmed"]>;
    "ide-attention-activate": CustomEvent<IdeEventDetails["ide-attention-activate"]>;
    "ide-attention-follow": CustomEvent<IdeEventDetails["ide-attention-follow"]>;
    "ide-attention-keep-as-comment": CustomEvent<IdeEventDetails["ide-attention-keep-as-comment"]>;
    "ide-execution-result": CustomEvent<IdeEventDetails["ide-execution-result"]>;
  }
}

/** Dispatch a payload-carrying IDE event on `document`. */
export function emitIdeEvent<K extends keyof IdeEventDetails>(
  name: K,
  detail: IdeEventDetails[K],
): void {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

/** Dispatch a payload-free IDE signal on `document`. */
export function emitIdeSignal(name: IdeSignalEvent): void {
  document.dispatchEvent(new Event(name));
}

/** Subscribe to a payload-carrying IDE event; returns the unsubscribe function. */
export function onIdeEvent<K extends keyof IdeEventDetails>(
  name: K,
  handler: (detail: IdeEventDetails[K]) => void,
): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<IdeEventDetails[K]>).detail);
  document.addEventListener(name, listener);
  return () => document.removeEventListener(name, listener);
}
