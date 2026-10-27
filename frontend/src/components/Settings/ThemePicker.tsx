import { useState } from "react";
import { BUILTIN_THEMES, type ColorTheme } from "../../colorThemes";
import type { FileIconTheme } from "../../hooks/useColorTheme";

/** M106: pick, import, export and remove colour themes; choose the file-icon theme. */
export default function ThemePicker({
  activeId,
  customThemes,
  fileIcons,
  onSelect,
  onImport,
  onRemove,
  onFileIcons,
  onClose,
}: {
  activeId: string | null;
  customThemes: ColorTheme[];
  fileIcons: FileIconTheme;
  onSelect: (id: string | null) => void;
  onImport: (json: string) => string | null;
  onRemove: (id: string) => void;
  onFileIcons: (v: FileIconTheme) => void;
  onClose: () => void;
}) {
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);

  const exportTheme = (t: ColorTheme) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(t, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${t.id}.veyra-theme.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const row = (t: ColorTheme, custom: boolean) => (
    <div key={t.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0" }}>
      <button type="button" role="radio" aria-checked={activeId === t.id} className="glass-btn" onClick={() => onSelect(t.id)} style={{ flex: 1, textAlign: "left", fontWeight: activeId === t.id ? 700 : 400 }}>
        <span style={{ display: "inline-block", width: 12, height: 12, marginRight: 8, background: t.palette.accent, border: `2px solid ${t.palette.bgBase}` }} />
        {t.label}
      </button>
      <button type="button" className="glass-btn" onClick={() => exportTheme(t)} aria-label={`Export ${t.label}`}>Export</button>
      {custom && <button type="button" className="glass-btn" onClick={() => onRemove(t.id)} aria-label={`Remove ${t.label}`}>Remove</button>}
    </div>
  );

  return (
    <div role="dialog" aria-label="Color Theme" style={{ position: "fixed", inset: "8% 28%", zIndex: 50, background: "var(--bg-surface)", border: "1px solid var(--glass-border)", borderRadius: 8, padding: 12, overflow: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <strong>Color Theme</strong>
        <button type="button" className="glass-btn" aria-label="Close themes" onClick={onClose}>×</button>
      </div>
      <button type="button" role="radio" aria-checked={activeId === null} className="glass-btn" onClick={() => onSelect(null)} style={{ display: "block", width: "100%", textAlign: "left", margin: "6px 0", fontWeight: activeId === null ? 700 : 400 }}>
        Default (follows the Theme preference)
      </button>
      {BUILTIN_THEMES.map((t) => row(t, false))}
      {customThemes.length > 0 && <div style={{ marginTop: 8 }}><em>Custom</em></div>}
      {customThemes.map((t) => row(t, true))}
      <div style={{ marginTop: 10 }}>
        <label>
          File icons{" "}
          <select aria-label="File icon theme" value={fileIcons} onChange={(e) => onFileIcons(e.target.value as FileIconTheme)}>
            <option value="default">Default</option>
            <option value="none">None</option>
          </select>
        </label>
      </div>
      <div style={{ marginTop: 10 }}>
        <textarea aria-label="Theme JSON" placeholder="Paste an exported theme JSON to import" value={json} onChange={(e) => setJson(e.target.value)} rows={4} style={{ width: "100%" }} />
        <button type="button" className="glass-btn" disabled={!json.trim()} onClick={() => { const err = onImport(json); setError(err); if (!err) setJson(""); }}>Import</button>
        {error && <span role="alert" style={{ color: "var(--error)", marginLeft: 8 }}>{error}</span>}
      </div>
    </div>
  );
}
