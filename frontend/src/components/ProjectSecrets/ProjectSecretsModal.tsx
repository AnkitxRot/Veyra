import React, { useState, useEffect, useCallback } from "react";
import { IconClose, IconShield, IconTrash, IconCheck } from "../common/Icons";

export interface SecretMetadata {
  name: string;
  environment: string | null;
  isSecret: boolean;
  fingerprint: string | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface ProjectSecretsModalProps {
  projectId: string;
  projectName: string;
  isOpen: boolean;
  onClose: () => void;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function errMsg(data: any, fallback: string): string {
  return data?.error?.message || data?.message || fallback;
}

export default function ProjectSecretsModal({
  projectId,
  projectName,
  isOpen,
  onClose,
}: ProjectSecretsModalProps) {
  const [secrets, setSecrets] = useState<SecretMetadata[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Create form. `value` is only ever held transiently here and is cleared
  // immediately after a successful write — it is never stored elsewhere.
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newEnv, setNewEnv] = useState("");
  const [newIsSecret, setNewIsSecret] = useState(true);
  const [saving, setSaving] = useState(false);

  // Inline "update value" editor keyed by `name env`.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const rowKey = (s: SecretMetadata) => `${s.name} ${s.environment ?? ""}`;

  const fetchSecrets = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/secrets`, {
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(errMsg(data, "Failed to load secrets"));
      setSecrets(data.secrets || []);
    } catch (err: any) {
      setError(err.message || "Failed to load secrets");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (isOpen) {
      fetchSecrets();
      setSuccessMsg(null);
      setError(null);
      setNewName("");
      setNewValue("");
      setNewEnv("");
      setNewIsSecret(true);
      setEditingKey(null);
      setEditValue("");
    }
  }, [isOpen, projectId, fetchSecrets]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setError(null);
    setSuccessMsg(null);
    if (!NAME_RE.test(newName)) {
      setError(
        "Name must be letters, digits and underscores, and cannot start with a digit.",
      );
      return;
    }
    if (newValue.length === 0) {
      setError("Value is required.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/secrets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: newName,
          value: newValue,
          environment: newEnv.trim() || undefined,
          isSecret: newIsSecret,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(errMsg(data, "Failed to create secret"));
      setSuccessMsg(`Saved ${newName}`);
      setNewName("");
      setNewValue("");
      setNewEnv("");
      setNewIsSecret(true);
      fetchSecrets();
    } catch (err: any) {
      setError(err.message || "Failed to create secret");
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async (s: SecretMetadata) => {
    if (saving) return;
    setError(null);
    setSuccessMsg(null);
    if (editValue.length === 0) {
      setError("Value is required.");
      return;
    }
    setSaving(true);
    try {
      const qs = s.environment
        ? `?environment=${encodeURIComponent(s.environment)}`
        : "";
      const res = await fetch(
        `/api/projects/${projectId}/secrets/${encodeURIComponent(s.name)}${qs}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            value: editValue,
            environment: s.environment ?? undefined,
            isSecret: s.isSecret,
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(errMsg(data, "Failed to update secret"));
      setSuccessMsg(`Updated ${s.name}`);
      setEditingKey(null);
      setEditValue("");
      fetchSecrets();
    } catch (err: any) {
      setError(err.message || "Failed to update secret");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (s: SecretMetadata) => {
    if (saving) return;
    if (
      !window.confirm(
        `Delete ${s.isSecret ? "secret" : "variable"} "${s.name}"? This cannot be undone.`,
      )
    )
      return;
    setError(null);
    setSuccessMsg(null);
    setSaving(true);
    try {
      const qs = s.environment
        ? `?environment=${encodeURIComponent(s.environment)}`
        : "";
      const res = await fetch(
        `/api/projects/${projectId}/secrets/${encodeURIComponent(s.name)}${qs}`,
        { method: "DELETE", credentials: "include" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errMsg(data, "Failed to delete secret"));
      setSuccessMsg(`Deleted ${s.name}`);
      fetchSecrets();
    } catch (err: any) {
      setError(err.message || "Failed to delete secret");
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(10, 12, 18, 0.75)",
        backdropFilter: "blur(12px)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="secrets-modal-title"
    >
      <div
        className="glass-panel"
        style={{
          width: "100%",
          maxWidth: "560px",
          backgroundColor: "#161922",
          border: "1px solid rgba(255, 255, 255, 0.12)",
          borderRadius: "12px",
          boxShadow: "0 24px 48px rgba(0, 0, 0, 0.6)",
          display: "flex",
          flexDirection: "column",
          maxHeight: "90vh",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div
              style={{
                width: "32px",
                height: "32px",
                borderRadius: "8px",
                backgroundColor: "rgba(203, 166, 247, 0.15)",
                color: "#cba6f7",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <IconShield size={18} />
            </div>
            <div>
              <h2
                id="secrets-modal-title"
                style={{
                  fontSize: "15px",
                  fontWeight: 600,
                  margin: 0,
                  color: "#cdd6f4",
                }}
              >
                Environment Variables & Secrets
              </h2>
              <div style={{ fontSize: "12px", color: "#a6adc8" }}>
                Project: <strong>{projectName}</strong>
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="glass-btn icon-only"
            aria-label="Close modal"
            style={{ width: "28px", height: "28px" }}
          >
            <IconClose size={14} />
          </button>
        </div>

        <div
          style={{
            padding: "20px",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
          }}
        >
          {error && (
            <div
              style={{
                padding: "10px 14px",
                borderRadius: "6px",
                background: "rgba(243, 139, 168, 0.15)",
                border: "1px solid rgba(243, 139, 168, 0.3)",
                color: "#f38ba8",
                fontSize: "12px",
              }}
            >
              {error}
            </div>
          )}
          {successMsg && (
            <div
              style={{
                padding: "10px 14px",
                borderRadius: "6px",
                background: "rgba(166, 227, 161, 0.15)",
                border: "1px solid rgba(166, 227, 161, 0.3)",
                color: "#a6e3a1",
                fontSize: "12px",
                display: "flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <IconCheck size={14} />
              <span>{successMsg}</span>
            </div>
          )}

          <form
            onSubmit={handleCreate}
            style={{ display: "flex", flexDirection: "column", gap: "8px" }}
          >
            <div style={{ display: "flex", gap: "8px" }}>
              <input
                type="text"
                placeholder="NAME"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="glass-input"
                style={{ flex: 1, fontSize: "13px", padding: "8px 12px" }}
                disabled={saving}
                aria-label="Secret name"
              />
              <input
                type="text"
                placeholder="environment (optional)"
                value={newEnv}
                onChange={(e) => setNewEnv(e.target.value)}
                className="glass-input"
                style={{
                  width: "150px",
                  fontSize: "13px",
                  padding: "8px 12px",
                }}
                disabled={saving}
                aria-label="Environment"
              />
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <input
                type={newIsSecret ? "password" : "text"}
                placeholder="value"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                className="glass-input"
                style={{ flex: 1, fontSize: "13px", padding: "8px 12px" }}
                disabled={saving}
                autoComplete="new-password"
                aria-label="Secret value"
              />
              <button
                type="submit"
                className="glass-btn primary"
                disabled={saving || !newName || !newValue}
                style={{
                  padding: "8px 16px",
                  fontSize: "12px",
                  fontWeight: 600,
                }}
              >
                {saving ? "Saving…" : "Add"}
              </button>
            </div>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                fontSize: "12px",
                color: "#a6adc8",
              }}
            >
              <input
                type="checkbox"
                checked={newIsSecret}
                onChange={(e) => setNewIsSecret(e.target.checked)}
                disabled={saving}
              />
              Treat as a secret (write-only — the value is never shown again)
            </label>
          </form>

          <div>
            <div
              style={{
                fontSize: "12px",
                fontWeight: 600,
                color: "#bac2de",
                marginBottom: "8px",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
              }}
            >
              Defined ({secrets.length})
            </div>

            {loading ? (
              <div
                style={{
                  fontSize: "12px",
                  color: "#6c7086",
                  padding: "12px 0",
                }}
              >
                Loading…
              </div>
            ) : secrets.length === 0 ? (
              <div
                style={{
                  padding: "16px",
                  background: "rgba(255, 255, 255, 0.02)",
                  borderRadius: "8px",
                  border: "1px dashed rgba(255, 255, 255, 0.08)",
                  textAlign: "center",
                  fontSize: "12px",
                  color: "#a6adc8",
                }}
              >
                No variables yet. Add one above — it is injected into runs and
                terminals as an environment variable.
              </div>
            ) : (
              <div
                style={{ display: "flex", flexDirection: "column", gap: "6px" }}
              >
                {secrets.map((s) => {
                  const k = rowKey(s);
                  return (
                    <div
                      key={k}
                      style={{
                        padding: "10px 14px",
                        background: "rgba(255, 255, 255, 0.03)",
                        borderRadius: "8px",
                        border: "1px solid rgba(255, 255, 255, 0.06)",
                        display: "flex",
                        flexDirection: "column",
                        gap: "6px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "8px",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            minWidth: 0,
                          }}
                        >
                          <span
                            style={{
                              fontSize: "13px",
                              fontWeight: 600,
                              color: "#cdd6f4",
                              fontFamily: "monospace",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {s.name}
                          </span>
                          {s.environment && (
                            <span
                              style={{
                                fontSize: "10px",
                                padding: "2px 6px",
                                borderRadius: "10px",
                                background: "rgba(137, 180, 250, 0.15)",
                                color: "#89b4fa",
                              }}
                            >
                              {s.environment}
                            </span>
                          )}
                          <span
                            style={{
                              fontSize: "10px",
                              padding: "2px 6px",
                              borderRadius: "10px",
                              background: s.isSecret
                                ? "rgba(203, 166, 247, 0.15)"
                                : "rgba(166, 227, 161, 0.12)",
                              color: s.isSecret ? "#cba6f7" : "#a6e3a1",
                              textTransform: "uppercase",
                            }}
                          >
                            {s.isSecret ? "Secret" : "Config"}
                          </span>
                        </div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                          }}
                        >
                          <button
                            className="glass-btn"
                            style={{ padding: "3px 8px", fontSize: "11px" }}
                            onClick={() => {
                              setEditingKey(editingKey === k ? null : k);
                              setEditValue("");
                            }}
                          >
                            {editingKey === k ? "Cancel" : "Update"}
                          </button>
                          <button
                            onClick={() => handleDelete(s)}
                            className="glass-btn icon-only"
                            style={{
                              color: "#f38ba8",
                              width: "26px",
                              height: "26px",
                            }}
                            title={`Delete ${s.name}`}
                            aria-label={`Delete ${s.name}`}
                          >
                            <IconTrash size={12} />
                          </button>
                        </div>
                      </div>

                      <div style={{ fontSize: "11px", color: "#6c7086" }}>
                        {s.isSecret ? (
                          <span>
                            ••••••••
                            {s.fingerprint ? (
                              <span style={{ fontFamily: "monospace" }}>
                                {s.fingerprint}
                              </span>
                            ) : null}
                          </span>
                        ) : (
                          <span>configuration value</span>
                        )}
                        {s.lastUsedAt && (
                          <span>
                            {"  ·  last used "}
                            {new Date(s.lastUsedAt).toLocaleString()}
                          </span>
                        )}
                      </div>

                      {editingKey === k && (
                        <div style={{ display: "flex", gap: "8px" }}>
                          <input
                            type={s.isSecret ? "password" : "text"}
                            placeholder="new value"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            className="glass-input"
                            style={{
                              flex: 1,
                              fontSize: "12px",
                              padding: "6px 10px",
                            }}
                            autoComplete="new-password"
                            aria-label={`New value for ${s.name}`}
                          />
                          <button
                            className="glass-btn primary"
                            style={{ padding: "6px 12px", fontSize: "11px" }}
                            disabled={saving || !editValue}
                            onClick={() => handleUpdate(s)}
                          >
                            Save
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid rgba(255, 255, 255, 0.08)",
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <button
            onClick={onClose}
            className="glass-btn"
            style={{ padding: "6px 16px", fontSize: "12px" }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
