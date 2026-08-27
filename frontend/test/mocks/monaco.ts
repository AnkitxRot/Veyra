// Minimal fake of the slice of the `monaco-editor` API surface that
// Editor.tsx touches. Real Monaco needs a browser (canvas, workers, real
// layout) that jsdom cannot provide, so tests mock the single import point
// (`src/monacoSetup.ts`) with this instead of mounting real Monaco.
//
// Not a general-purpose Monaco shim: it only implements what Editor.tsx's
// production code path actually calls, kept in lockstep with that file.

export class FakeModel {
  private value: string;
  private disposedFlag = false;
  public uri: { path: string; toString: () => string };

  constructor(value: string, uri: { path: string; toString: () => string }) {
    this.value = value;
    this.uri = uri;
  }

  getValue(): string {
    return this.value;
  }

  setValue(v: string): void {
    this.value = v;
  }

  isDisposed(): boolean {
    return this.disposedFlag;
  }

  dispose(): void {
    this.disposedFlag = true;
  }

  getFullModelRange() {
    return {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    };
  }

  // Mirrors real Monaco's full-content replace shape used by
  // applyLiveContent(): a single edit op whose `.text` is the new content.
  pushEditOperations(
    _before: unknown,
    ops: { range: unknown; text: string }[],
    _cb: unknown,
  ) {
    if (ops.length > 0) {
      this.value = ops[0].text;
    }
    return null;
  }
}

export class FakeEditorInstance {
  public options: Record<string, unknown>;
  public disposed = false;
  public commands = new Map<string, (...args: unknown[]) => unknown>();
  public actions = new Map<string, unknown>();
  public updateOptionsCalls: Record<string, unknown>[] = [];

  private model: FakeModel | null = null;
  private contentListeners: Array<() => void> = [];
  private cursorListeners: Array<(e: unknown) => void> = [];
  private commandCounter = 0;

  constructor(options: Record<string, unknown>) {
    this.options = options;
  }

  onDidChangeModelContent(cb: () => void) {
    this.contentListeners.push(cb);
    return { dispose: () => {} };
  }

  onDidChangeCursorPosition(cb: (e: unknown) => void) {
    this.cursorListeners.push(cb);
    return { dispose: () => {} };
  }

  onDidChangeCursorSelection(_cb: (e: unknown) => void) {
    return { dispose: () => {} };
  }

  addCommand(_keybinding: number, handler: (...args: unknown[]) => unknown) {
    const id = `cmd-${this.commandCounter++}`;
    this.commands.set(id, handler);
    // Editor.tsx registers exactly one addCommand (Ctrl+S). Tests reach it
    // through this stable alias instead of depending on keybinding encoding.
    this.commands.set("__last__", handler);
    return id;
  }

  addAction(action: { id: string }) {
    this.actions.set(action.id, action);
  }

  setModel(model: FakeModel | null) {
    this.model = model;
  }

  getModel() {
    return this.model;
  }

  getValue() {
    return this.model?.getValue();
  }

  updateOptions(opts: Record<string, unknown>) {
    this.options = { ...this.options, ...opts };
    this.updateOptionsCalls.push(opts);
  }

  layout() {}
  dispose() {
    this.disposed = true;
  }
  revealPositionInCenter() {}
  setPosition() {}
  setSelection() {}
  focus() {}

  // --- test helpers (not part of the real Monaco API) ---
  _fireContentChange() {
    for (const cb of this.contentListeners) cb();
  }
  _fireCursorChange(position: { lineNumber: number; column: number }) {
    for (const cb of this.cursorListeners) cb({ position });
  }
}

let modelRegistry = new Map<string, FakeModel>();
let lastEditorInstance: FakeEditorInstance | null = null;

const editor = {
  create: (_el: unknown, options: Record<string, unknown>) => {
    lastEditorInstance = new FakeEditorInstance(options);
    return lastEditorInstance;
  },
  createModel: (
    value: string,
    _languageId: string,
    uri: { path: string; toString: () => string },
  ) => {
    const m = new FakeModel(value, uri);
    modelRegistry.set(uri.toString(), m);
    return m;
  },
  getModel: (uri: { toString: () => string }) =>
    modelRegistry.get(uri.toString()) ?? null,
  getModels: () => Array.from(modelRegistry.values()),
  setModelLanguage: (_model: unknown, _languageId: string) => {},
  setModelMarkers: (_model: unknown, _owner: string, _markers: unknown[]) => {},
};

const Uri = {
  file: (p: string) => {
    const path = p.startsWith("/") ? p : `/${p}`;
    return { path, toString: () => `file://${path}` };
  },
};

const KeyMod = { CtrlCmd: 2048, Shift: 1024, Alt: 512 };
const KeyCode = { KeyS: 49 };
const MarkerSeverity = { Error: 8, Warning: 4, Info: 2, Hint: 1 };

class Range {
  constructor(
    public startLineNumber: number,
    public startColumn: number,
    public endLineNumber: number,
    public endColumn: number,
  ) {}
}

export const monaco = { editor, Uri, KeyMod, KeyCode, MarkerSeverity, Range };

export function __resetMonacoMocks() {
  modelRegistry = new Map();
  lastEditorInstance = null;
}

export function __getLastEditorInstance(): FakeEditorInstance | null {
  return lastEditorInstance;
}
