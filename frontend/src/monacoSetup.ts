// Monaco Editor Web Worker configuration for Vite.
// This file MUST be imported before any Monaco editor usage.
// Without workers, Monaco cannot tokenize/highlight ANY language — everything renders as plain text.

import * as monaco from "monaco-editor";

// Vite's ?worker import syntax bundles each worker as a separate entry point.
// These workers handle language-specific tokenization, validation, and completion.
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less")
      return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor")
      return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

if (typeof window !== "undefined") {
  (window as any).monaco = monaco;
}

export { monaco };
