import React from "react";
import { IconAlertTriangle } from "./Icons";

interface ErrorBoundaryProps {
  label: string;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(
      `[ErrorBoundary:${this.props.label}]`,
      error,
      info.componentStack,
    );
  }

  render() {
    const { error } = this.state;
    const { label, children } = this.props;

    if (error) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            height: "100%",
            alignItems: "center",
            justifyContent: "center",
            gap: "12px",
            padding: "24px",
            textAlign: "center",
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: "40px",
              height: "40px",
              borderRadius: "10px",
              background: "rgba(243, 139, 168, 0.15)",
              color: "var(--error)",
            }}
          >
            <IconAlertTriangle size={20} />
          </div>
          <div
            style={{
              fontSize: "14px",
              fontWeight: 600,
              color: "var(--fg-primary)",
            }}
          >
            Failed to load {label}.
          </div>
          <div
            style={{
              fontSize: "12px",
              color: "var(--fg-muted)",
              maxWidth: "360px",
            }}
          >
            {error.message || "An unexpected error occurred."}
          </div>
          <button
            type="button"
            className="glass-btn"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }

    return children;
  }
}
