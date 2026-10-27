import { renderMarkdown } from "../../markdown";

export type ViewerKind = "image" | "pdf" | "binary";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i;

/** Decide how a file with no editable text should be shown. */
export function viewerKindFor(path: string, binary: boolean): ViewerKind | null {
  if (IMAGE_EXT.test(path)) return "image";
  if (/\.pdf$/i.test(path)) return "pdf";
  return binary ? "binary" : null;
}

/**
 * M103: read-only viewer for images/PDF/binary files. Bytes come from the
 * server's /raw route, which sandboxes the response (CSP + nosniff); SVG is
 * shown through <img>, so scripts never execute.
 */
export function FileViewer({
  projectId,
  path,
  kind,
  onClose,
}: {
  projectId: string;
  path: string;
  kind: ViewerKind;
  onClose: () => void;
}) {
  const src = `/api/projects/${projectId}/raw?path=${encodeURIComponent(path)}`;
  return (
    <div
      className="file-viewer"
      style={{ position: "absolute", inset: 0, zIndex: 5, display: "flex", flexDirection: "column", background: "var(--bg)" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 12px", fontSize: 12 }}>
        <span>{path}</span>
        <button type="button" className="glass-btn" onClick={onClose} aria-label="Close viewer">
          Close
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto" }}>
        {kind === "image" && <img src={src} alt={path} style={{ maxWidth: "100%", maxHeight: "100%" }} />}
        {kind === "pdf" && <iframe title={path} src={src} sandbox="" style={{ width: "100%", height: "100%", border: 0 }} />}
        {kind === "binary" && (
          <div style={{ textAlign: "center", color: "var(--fg-muted)" }}>
            <p>Binary file — not shown in the editor.</p>
            <a href={src} download className="glass-btn">
              Download
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

/** Side-by-side markdown preview; content is escaped by renderMarkdown. */
export function MarkdownPreview({ content, onClose }: { content: string; onClose: () => void }) {
  return (
    <div
      className="markdown-preview"
      style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: "50%", zIndex: 5, overflow: "auto", padding: "8px 16px", background: "var(--bg)", borderLeft: "1px solid var(--border)" }}
    >
      <button type="button" className="glass-btn" style={{ float: "right" }} onClick={onClose} aria-label="Close preview">
        ×
      </button>
      <div dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
    </div>
  );
}
