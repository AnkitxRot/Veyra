import { flattenSymbols, type OutlineSymbol } from "../../outline";

/** M104: outline of the active file; clicking a symbol reveals it in the editor. */
export default function OutlinePanel({
  filePath,
  symbols,
  onClose,
}: {
  filePath: string | null;
  symbols: OutlineSymbol[];
  onClose: () => void;
}) {
  const rows = flattenSymbols(symbols);
  return (
    <div
      className="outline-panel"
      style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: 260, zIndex: 5, overflow: "auto", background: "var(--bg)", borderLeft: "1px solid var(--border)", fontSize: 12 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 10px" }}>
        <strong>Outline</strong>
        <button type="button" className="glass-btn" aria-label="Close outline" onClick={onClose}>
          ×
        </button>
      </div>
      {rows.length === 0 && <div style={{ padding: "6px 10px", color: "var(--fg-muted)" }}>No symbols (language server not ready or file has none).</div>}
      {rows.map(({ symbol, depth }, i) => (
        <button
          key={`${symbol.name}:${symbol.range.startLine}:${i}`}
          type="button"
          className="outline-row"
          style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: 0, color: "inherit", padding: `2px 10px 2px ${10 + depth * 14}px`, cursor: "pointer" }}
          onClick={() =>
            filePath &&
            document.dispatchEvent(
              new CustomEvent("ide-reveal-location", { detail: { filePath, line: symbol.range.startLine } }),
            )
          }
        >
          {symbol.name}
        </button>
      ))}
    </div>
  );
}
