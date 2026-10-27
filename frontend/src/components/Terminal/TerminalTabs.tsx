import { useEffect, useReducer } from "react";
import Terminal from "./Terminal";
import {
  MAX_TERMINAL_TABS,
  loadTermTabs,
  saveTermTabs,
  termTabsReducer,
} from "../../terminalTabs";

/**
 * M102: multiple terminal sessions per project. Every tab stays mounted (its
 * session is owned by useTerminalSession, M79) and `visible` only toggles
 * display. The per-user terminal cap is enforced by the server.
 */
export default function TerminalTabs({
  projectId,
  userId,
  resolvedTheme,
  visible,
}: {
  projectId: string;
  userId?: number;
  resolvedTheme: "dark" | "light";
  visible: boolean;
}) {
  const [state, dispatch] = useReducer(termTabsReducer, projectId, loadTermTabs);

  useEffect(() => {
    saveTermTabs(projectId, state);
  }, [projectId, state]);

  const shown = (slot: string) => slot === state.active || slot === state.split;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className="terminal-tabs" role="tablist" style={{ display: "flex", gap: 4, padding: "2px 8px" }}>
        {state.tabs.map((t) => (
          <span key={t.slot} className={`terminal-tab ${t.slot === state.active ? "active" : ""}`}>
            <button
              type="button"
              role="tab"
              aria-selected={t.slot === state.active}
              className="glass-btn"
              style={{ fontSize: 11, padding: "2px 8px" }}
              onClick={() => dispatch({ type: "activate", slot: t.slot })}
            >
              {t.label}
            </button>
            {state.tabs.length > 1 && (
              <button
                type="button"
                className="glass-btn glass-btn-icon"
                aria-label={`Close ${t.label}`}
                onClick={() => dispatch({ type: "close", slot: t.slot })}
              >
                ×
              </button>
            )}
          </span>
        ))}
        <button
          type="button"
          className="glass-btn glass-btn-icon"
          title="New terminal"
          aria-label="New terminal"
          disabled={state.tabs.length >= MAX_TERMINAL_TABS}
          onClick={() => dispatch({ type: "add" })}
        >
          +
        </button>
        <button
          type="button"
          className="glass-btn"
          style={{ fontSize: 11, padding: "2px 8px" }}
          title="Split terminal"
          disabled={state.tabs.length < 2}
          onClick={() => dispatch({ type: "toggleSplit" })}
        >
          {state.split ? "Unsplit" : "Split"}
        </button>
      </div>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {state.tabs.map((t) => (
          <div
            key={t.slot}
            style={{ flex: 1, minWidth: 0, flexDirection: "column", display: shown(t.slot) ? "flex" : "none" }}
          >
            <Terminal
              projectId={projectId}
              userId={userId}
              resolvedTheme={resolvedTheme}
              slot={t.slot || undefined}
              visible={visible && shown(t.slot)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
