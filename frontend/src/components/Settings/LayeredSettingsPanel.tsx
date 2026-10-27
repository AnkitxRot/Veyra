import { useState } from "react";
import { filterSchema, type SettingDef, type SettingsLayer } from "../../settingsSchema";

type Scope = "user" | "project";
type Val = string | number | boolean;

/** M105: schema-driven settings editor with search and User/Project scope tabs. */
export default function LayeredSettingsPanel({
  userLayer,
  projectLayer,
  canEditProject,
  onSetUser,
  onSetProject,
  onClose,
}: {
  userLayer: SettingsLayer;
  projectLayer: SettingsLayer;
  canEditProject: boolean;
  onSetUser: (key: string, v: Val) => void;
  onSetProject: (key: string, v: Val | undefined) => void;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<Scope>("user");
  const [query, setQuery] = useState("");
  const layer = scope === "user" ? userLayer : projectLayer;
  const set = (d: SettingDef, v: Val) => (scope === "user" ? onSetUser(d.key, v) : onSetProject(d.key, v));

  return (
    <div role="dialog" aria-label="Settings" className="layered-settings" style={{ position: "fixed", inset: "8% 20%", zIndex: 50, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, display: "flex", flexDirection: "column", padding: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <input autoFocus placeholder="Search settings" aria-label="Search settings" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: 1 }} />
        {(["user", "project"] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={scope === s} className="glass-btn" disabled={s === "project" && !canEditProject} onClick={() => setScope(s)} style={{ fontWeight: scope === s ? 700 : 400 }}>
            {s === "user" ? "User" : "Project"}
          </button>
        ))}
        <button type="button" className="glass-btn" aria-label="Close settings" onClick={onClose}>×</button>
      </div>
      <div style={{ overflow: "auto", flex: 1 }}>
        {filterSchema(query).map((d) => {
          const overridden = d.key in projectLayer;
          const v = layer[d.key];
          return (
            <div key={d.key} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
              <div>
                <div>{d.label} {overridden && scope === "user" && <em style={{ color: "var(--accent)" }}>(overridden by project)</em>}</div>
                <small style={{ color: "var(--fg-muted)" }}>{d.description}</small>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {d.type === "boolean" && <input type="checkbox" aria-label={d.label} checked={v === true} onChange={(e) => set(d, e.target.checked)} />}
                {d.type === "number" && <input type="number" aria-label={d.label} min={d.min} max={d.max} value={typeof v === "number" ? v : ""} onChange={(e) => e.target.value !== "" && set(d, Number(e.target.value))} style={{ width: 80 }} />}
                {d.type === "enum" && (
                  <select aria-label={d.label} value={typeof v === "string" ? v : ""} onChange={(e) => set(d, e.target.value)}>
                    {v === undefined && <option value="">(default)</option>}
                    {d.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                )}
                {d.type === "string" && <input aria-label={d.label} defaultValue={typeof v === "string" ? v : ""} onBlur={(e) => e.target.value && set(d, e.target.value)} style={{ width: 160 }} />}
                {scope === "project" && d.key in projectLayer && <button type="button" className="glass-btn" onClick={() => onSetProject(d.key, undefined)} title="Remove project override">Reset</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
