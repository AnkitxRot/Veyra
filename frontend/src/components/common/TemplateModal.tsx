import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProjectTemplate } from "../../types";
import { api } from "../../api";
import { IconCheck, IconPlus } from "./Icons";

interface TemplateModalProps {
  isOpen: boolean;
  isCreating: boolean;
  onConfirm: (opts: {
    templateId: string | null;
    name: string;
    entryFile: string | null;
  }) => void;
  onCancel: () => void;
}

// Languages whose starters are directly runnable the moment the project opens.
const RUN_READY_LANGUAGES = new Set([
  "python",
  "node",
  "typescript",
  "c",
  "cpp",
  "java",
]);

// The starter selected by default when the catalog loads — chosen so the
// user's very first action can be Run.
const DEFAULT_TEMPLATE_ID = "python";

export function TemplateModal({
  isOpen,
  isCreating,
  onConfirm,
  onCancel,
}: TemplateModalProps) {
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    null,
  );
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Once the user clicks any card, stop letting the async catalog load move
  // the selection out from under them.
  const userPickedRef = useRef(false);

  // Every open is a fresh flow: start from the runnable default, regardless of
  // what was picked last time the modal was open. If the catalog can't load,
  // this stays as Blank Project (null) so creation still works.
  useEffect(() => {
    if (!isOpen) return;
    userPickedRef.current = false;
    setSelectedTemplateId(null);
    setName("");
    setCatalogError(null);
    setCatalogLoading(true);
    // Discard any templates from a previous successful open — otherwise a
    // failed re-fetch would leave stale cards visible and selectable while
    // the error message claims templates are unavailable.
    setTemplates([]);

    let cancelled = false;
    api<{ templates: ProjectTemplate[] }>("/api/projects/templates/catalog")
      .then((res) => {
        if (cancelled) return;
        setTemplates(res.templates);
        const preferred = res.templates.find(
          (t) => t.id === DEFAULT_TEMPLATE_ID,
        );
        if (preferred && !userPickedRef.current) {
          setSelectedTemplateId(preferred.id);
          setName((cur) => (cur === "" ? preferred.name : cur));
        }
      })
      .catch((err: any) => {
        if (cancelled) return;
        // Blank Project must stay usable even if the catalog can't load —
        // this is a non-blocking, inline notice, not the alert() used for
        // actual creation failures.
        setCatalogError(err.message || "Could not load templates");
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });

    setTimeout(() => inputRef.current?.focus(), 50);
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;
  if (typeof document === "undefined") return null;

  const selectBlank = () => {
    userPickedRef.current = true;
    setSelectedTemplateId(null);
    setName("");
  };

  const selectTemplate = (tpl: ProjectTemplate) => {
    userPickedRef.current = true;
    setSelectedTemplateId(tpl.id);
    setName(tpl.name);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isCreating) return;
    const tpl = templates.find((t) => t.id === selectedTemplateId);
    onConfirm({
      templateId: selectedTemplateId,
      name: name.trim(),
      entryFile: tpl?.entryFile ?? null,
    });
  };

  const cardBaseStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "12px",
    borderRadius: "var(--radius-md)",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "var(--glass-border)",
    background: "var(--glass-surface-2)",
    cursor: "pointer",
    textAlign: "left",
    position: "relative",
    minWidth: 0,
  };

  const selectedCardStyle: React.CSSProperties = {
    borderColor: "var(--accent)",
    background: "var(--glass-surface-3)",
    boxShadow: "var(--glass-specular-sharp), var(--shadow-xs)",
  };

  // Portaled to document.body: the Sidebar tree this modal is triggered from
  // has a backdrop-filter ancestor (.sidebar), which per spec creates a
  // containing block for position:fixed descendants — without the portal,
  // this modal (and its inset:0 backdrop) would be confined to the sidebar's
  // own width/height instead of the full viewport.
  return createPortal(
    <div className="glass-modal-backdrop" onClick={onCancel}>
      <div
        className="glass-floating"
        style={{
          width: "520px",
          maxWidth: "92vw",
          maxHeight: "85vh",
          overflowY: "auto",
          padding: "24px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <h3
            style={{
              margin: 0,
              fontSize: "var(--text-lg)",
              fontWeight: 600,
              color: "var(--fg-primary)",
            }}
          >
            Create Project
          </h3>
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-sm)",
              color: "var(--fg-muted)",
              lineHeight: 1.4,
            }}
          >
            Pick a starter and press Run — every starter works with no setup.
            Or choose Blank for an empty workspace.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          style={{ display: "flex", flexDirection: "column", gap: "16px" }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
              gap: "10px",
            }}
          >
            <button
              type="button"
              onClick={selectBlank}
              style={{
                ...cardBaseStyle,
                ...(selectedTemplateId === null ? selectedCardStyle : {}),
              }}
              aria-pressed={selectedTemplateId === null}
            >
              {selectedTemplateId === null && (
                <IconCheck
                  size={14}
                  color="var(--accent)"
                  style={{ position: "absolute", top: "10px", right: "10px" }}
                />
              )}
              <IconPlus size={16} color="var(--fg-muted)" />
              <span
                style={{
                  fontSize: "var(--text-sm)",
                  fontWeight: 600,
                  color: "var(--fg-primary)",
                }}
              >
                Blank Project
              </span>
              <span
                style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}
              >
                Start with an empty workspace
              </span>
            </button>

            {catalogLoading && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "12px",
                  fontSize: "var(--text-xs)",
                  color: "var(--fg-muted)",
                }}
              >
                Loading templates…
              </div>
            )}

            {!catalogLoading &&
              templates.map((tpl) => {
                const isSelected = selectedTemplateId === tpl.id;
                return (
                  <button
                    type="button"
                    key={tpl.id}
                    onClick={() => selectTemplate(tpl)}
                    style={{
                      ...cardBaseStyle,
                      ...(isSelected ? selectedCardStyle : {}),
                    }}
                    aria-pressed={isSelected}
                  >
                    {isSelected && (
                      <IconCheck
                        size={14}
                        color="var(--accent)"
                        style={{
                          position: "absolute",
                          top: "10px",
                          right: "10px",
                        }}
                      />
                    )}
                    <span
                      style={{
                        fontSize: "var(--text-sm)",
                        fontWeight: 600,
                        color: "var(--fg-primary)",
                      }}
                    >
                      {tpl.name}
                    </span>
                    <span
                      style={{
                        fontSize: "var(--text-xs)",
                        color: "var(--fg-muted)",
                        lineHeight: 1.35,
                      }}
                    >
                      {tpl.description}
                    </span>
                    <span
                      style={{
                        display: "flex",
                        gap: "6px",
                        flexWrap: "wrap",
                        alignSelf: "flex-start",
                      }}
                    >
                      <span className="glass-badge glass-badge-accent">
                        {tpl.language}
                      </span>
                      {RUN_READY_LANGUAGES.has(tpl.language) && (
                        <span className="glass-badge">▶ Runs on create</span>
                      )}
                    </span>
                  </button>
                );
              })}
          </div>

          {catalogError && (
            <p
              style={{
                margin: 0,
                fontSize: "var(--text-xs)",
                color: "var(--warning)",
              }}
            >
              Templates unavailable ({catalogError}) — you can still create a
              blank project.
            </p>
          )}

          <input
            ref={inputRef}
            className="glass-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project Name"
            autoFocus
          />

          <div
            style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}
          >
            <button type="button" className="glass-btn" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="submit"
              className="glass-btn glass-btn-primary"
              disabled={!name.trim() || isCreating}
            >
              {isCreating ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
