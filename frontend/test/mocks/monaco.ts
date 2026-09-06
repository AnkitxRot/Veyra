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
  // 0 = LF, 1 = CRLF — mirrors monaco.editor.EndOfLineSequence.
  private eol: 0 | 1 = 0;

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

  setEOL(eol: 0 | 1): void {
    this.eol = eol;
  }

  getEOL(): string {
    return this.eol === 1 ? "\r\n" : "\n";
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

  private selectionListeners: Array<(e: unknown) => void> = [];
  onDidChangeCursorSelection(cb: (e: unknown) => void) {
    this.selectionListeners.push(cb);
    return { dispose: () => {} };
  }

  // --- M58: decorations + content widgets ---
  public decorationCollections: FakeDecorationsCollection[] = [];
  public contentWidgets = new Map<string, { getDomNode: () => HTMLElement }>();
  private selection = {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 1,
    getStartPosition: () => ({ lineNumber: 1, column: 1 }),
  };

  createDecorationsCollection() {
    const c = new FakeDecorationsCollection();
    this.decorationCollections.push(c);
    return c;
  }
  addContentWidget(w: { getId: () => string; getDomNode: () => HTMLElement }) {
    this.contentWidgets.set(w.getId(), w);
    const node = w.getDomNode();
    node.setAttribute("data-cw-id", w.getId());
    document.body.appendChild(node);
  }
  removeContentWidget(w: { getId: () => string; getDomNode: () => HTMLElement }) {
    this.contentWidgets.delete(w.getId());
    w.getDomNode().remove();
  }
  layoutContentWidget() {}
  getScrolledVisiblePosition() {
    return { top: 40, left: 40, height: 18 };
  }
  getPosition() {
    return { lineNumber: 1, column: 1 };
  }
  getSelection() {
    return this.selection;
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

  // --- M59: Monaco view-state save/restore ---
  private viewStateCounter = 0;
  public restoreCalls: Array<{ vs: unknown; modelPath: string | null }> = [];
  public lastRestoredViewState: unknown = undefined;

  saveViewState(): { __vs: true; id: number } | null {
    if (!this.model) return null;
    return { __vs: true, id: ++this.viewStateCounter };
  }

  restoreViewState(vs: unknown): void {
    const modelPath = this.model
      ? this.model.uri.path.replace(/^\//, "")
      : null;
    this.lastRestoredViewState = vs;
    this.restoreCalls.push({ vs, modelPath });
  }

  // --- test helpers (not part of the real Monaco API) ---
  _fireContentChange() {
    for (const cb of this.contentListeners) cb();
  }
  _fireCursorChange(position: { lineNumber: number; column: number }) {
    for (const cb of this.cursorListeners) cb({ position });
  }
  _fireSelectionChange(sel: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  }) {
    this.selection = {
      ...sel,
      getStartPosition: () => ({
        lineNumber: sel.startLineNumber,
        column: sel.startColumn,
      }),
    };
    for (const cb of this.selectionListeners) cb({ selection: this.selection });
  }
}

export class FakeDecorationsCollection {
  public decorations: unknown[] = [];
  set(decos: unknown[]) {
    this.decorations = decos;
  }
  clear() {
    this.decorations = [];
  }
}

let modelRegistry = new Map<string, FakeModel>();
let lastEditorInstance: FakeEditorInstance | null = null;
let editorCreateCount = 0;
let setThemeCalls: string[] = [];

const editor = {
  create: (_el: unknown, options: Record<string, unknown>) => {
    editorCreateCount += 1;
    lastEditorInstance = new FakeEditorInstance(options);
    return lastEditorInstance;
  },
  // M69: global theme swap — the real API updates every live editor in place
  // without recreating anything.
  setTheme: (theme: string) => {
    setThemeCalls.push(theme);
    if (lastEditorInstance) lastEditorInstance.options.theme = theme;
  },
  createModel: (
    value: string,
    _languageId: string,
    uri: { path: string; toString: () => string },
  ) => {
    const m = new FakeModel(value, uri);
    // Mirrors real Monaco: content containing no "\r" is LF-detected, but an
    // entirely empty initial value has no line breaks to detect from, so it
    // falls back to a platform default — CRLF on Windows. Reproducing that
    // fallback here is what makes Editor.tsx's explicit setEOL(LF) pin (the
    // fix for the live-verified cross-client EOL divergence) a real,
    // failing-without-it regression test rather than a no-op assertion.
    if (value === "") m.setEOL(1);
    modelRegistry.set(uri.toString(), m);
    return m;
  },
  getModel: (uri: { toString: () => string }) =>
    modelRegistry.get(uri.toString()) ?? null,
  getModels: () => Array.from(modelRegistry.values()),
  setModelLanguage: (_model: unknown, _languageId: string) => {},
  setModelMarkers: (_model: unknown, _owner: string, _markers: unknown[]) => {},
  EndOfLineSequence: { LF: 0, CRLF: 1 } as const,
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

class Selection extends Range {
  getStartPosition() {
    return { lineNumber: this.startLineNumber, column: this.startColumn };
  }
}

(editor as Record<string, unknown>).OverviewRulerLane = {
  Left: 1,
  Center: 2,
  Right: 4,
  Full: 7,
};
(editor as Record<string, unknown>).ContentWidgetPositionPreference = {
  EXACT: 0,
  ABOVE: 1,
  BELOW: 2,
};

export const monaco = {
  editor,
  Uri,
  KeyMod,
  KeyCode,
  MarkerSeverity,
  Range,
  Selection,
};

export function __resetMonacoMocks() {
  modelRegistry = new Map();
  lastEditorInstance = null;
  editorCreateCount = 0;
  setThemeCalls = [];
}

export function __getLastEditorInstance(): FakeEditorInstance | null {
  return lastEditorInstance;
}

/** M69: how many times `monaco.editor.create` has been called this test. */
export function __getEditorCreateCount(): number {
  return editorCreateCount;
}

/** M69: the sequence of `monaco.editor.setTheme` arguments this test. */
export function __getSetThemeCalls(): string[] {
  return [...setThemeCalls];
}
