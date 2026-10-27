import { useEffect, useState } from "react";
import { monaco } from "../monacoSetup";
import { fetchOutlineSymbols } from "../lsp/providers";
import { symbolPathAt, type OutlineSymbol } from "../outline";

const modelFor = (path: string) =>
  monaco.editor.getModels().find((m) => m.uri.path.replace(/^\//, "") === path) ?? null;

/**
 * M104: document symbols of the active file (via the LSP documentSymbol
 * provider path) plus the symbol path under the cursor, for the outline view
 * and the status-bar breadcrumb. Refreshes on edit (debounced).
 */
export function useOutline(activeFile: string | null): {
  symbols: OutlineSymbol[];
  crumbs: string[];
} {
  const [symbols, setSymbols] = useState<OutlineSymbol[]>([]);
  const [line, setLine] = useState(1);

  useEffect(() => {
    setSymbols([]);
    if (!activeFile) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const model = modelFor(activeFile);
    const load = () => {
      if (!model || model.isDisposed()) return;
      fetchOutlineSymbols(model)
        .then((r) => !cancelled && r && setSymbols(r))
        .catch(() => {});
    };
    load();
    const sub = model?.onDidChangeContent(() => {
      clearTimeout(timer);
      timer = setTimeout(load, 1200);
    });
    const ed = monaco.editor.getEditors().find((e) => e.getModel() === model);
    setLine(ed?.getPosition()?.lineNumber ?? 1);
    const cur = ed?.onDidChangeCursorPosition((e) => setLine(e.position.lineNumber));
    return () => {
      cancelled = true;
      clearTimeout(timer);
      sub?.dispose();
      cur?.dispose();
    };
  }, [activeFile]);

  return { symbols, crumbs: symbolPathAt(symbols, line) };
}
