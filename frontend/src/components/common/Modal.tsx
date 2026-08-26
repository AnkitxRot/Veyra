import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface PromptModalProps {
  isOpen: boolean;
  title: string;
  message?: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  isDestructive?: boolean;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function PromptModal({
  isOpen,
  title,
  message,
  initialValue = "",
  placeholder = "",
  confirmLabel = "Confirm",
  isDestructive = false,
  onConfirm,
  onCancel,
}: PromptModalProps) {
  const [val, setVal] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setVal(initialValue);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 50);
    }
  }, [isOpen, initialValue]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;
  // Any ancestor with backdrop-filter (the app's "glass" panels all have
  // one — sidebar, toolbar, editor, admin panels) establishes a containing
  // block for position:fixed, which would confine this backdrop to that
  // ancestor's box instead of the viewport. Portal to document.body so
  // every call site renders full-viewport regardless of where it's
  // triggered from.
  if (typeof document === "undefined") return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!val.trim() && placeholder !== "Folder Name") return;
    onConfirm(val.trim());
  };

  return createPortal(
    <div className="glass-modal-backdrop" onClick={onCancel}>
      <div
        className="glass-floating"
        style={{
          width: "380px",
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
            {title}
          </h3>
          {message && (
            <p
              style={{
                margin: 0,
                fontSize: "var(--text-sm)",
                color: "var(--fg-muted)",
                lineHeight: 1.4,
              }}
            >
              {message}
            </p>
          )}
        </div>

        <form
          onSubmit={handleSubmit}
          style={{ display: "flex", flexDirection: "column", gap: "16px" }}
        >
          <input
            ref={inputRef}
            className="glass-input"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            placeholder={placeholder}
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
              className={`glass-btn ${isDestructive ? "glass-btn-danger" : "glass-btn-primary"}`}
              disabled={!val.trim()}
            >
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  isDestructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  isOpen,
  title,
  message,
  confirmLabel = "Delete",
  isDestructive = true,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
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

  return createPortal(
    <div className="glass-modal-backdrop" onClick={onCancel}>
      <div
        className="glass-floating"
        style={{
          width: "380px",
          padding: "24px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <h3
            style={{
              margin: 0,
              fontSize: "var(--text-lg)",
              fontWeight: 600,
              color: "var(--fg-primary)",
            }}
          >
            {title}
          </h3>
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-sm)",
              color: "var(--fg-muted)",
              lineHeight: 1.4,
            }}
          >
            {message}
          </p>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "8px",
            marginTop: "8px",
          }}
        >
          <button type="button" className="glass-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`glass-btn ${isDestructive ? "glass-btn-danger" : "glass-btn-primary"}`}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
