import React, { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../../api";
import { Project } from "../../types";
import { ConfirmModal } from "../common/Modal";
import {
  IconSearch,
  IconChevronDown,
  IconChevronRight,
  IconCode,
  IconRefresh,
  IconEdit,
} from "../common/Icons";

export interface SearchMatch {
  filePath: string;
  lineNumber: number;
  column: number;
  lineContent: string;
  matchLength: number;
  /** Only present when previewing a replacement (Replace mode is active). */
  replacedLineContent?: string;
}

export interface SearchFileGroup {
  filePath: string;
  matches: SearchMatch[];
}

export interface SearchResponse {
  groups: SearchFileGroup[];
  totalMatches: number;
  filesSearched: number;
  durationMs: number;
  truncated: boolean;
}

interface ReplaceApplyResult {
  applied: true;
  filesChanged: number;
  matchesReplaced: number;
  truncated: boolean;
  snapshotId?: string | null;
  results: Array<{
    filePath: string;
    status: "replaced" | "skipped" | "error";
    matchCount: number;
    reason?: string;
  }>;
}

export interface WorkspaceSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  project: Project | null;
  /** Access role for the current user on this project. Only the owner can
   *  create the pre-replace safety snapshot (snapshots are an owner-only
   *  capability), so the toggle defaults on for owners and is unavailable
   *  otherwise. */
  projectRole?: "owner" | "editor" | "viewer";
  onSelectResult: (
    filePath: string,
    line: number,
    column: number,
    matchLength: number,
  ) => void;
  /** Called after a successful Replace All apply with the workspace-relative
   *  paths that were actually written. IDE.tsx uses this to reconcile any
   *  already-open editor buffers so a later save cannot silently revert the
   *  replacement (M50). */
  onReplaceApplied?: (changedPaths: string[]) => void;
}

export default function WorkspaceSearchModal({
  isOpen,
  onClose,
  project,
  projectRole = "owner",
  onSelectResult,
  onReplaceApplied,
}: WorkspaceSearchModalProps) {
  const isOwner = projectRole === "owner";
  const [query, setQuery] = useState("");
  const [isCaseSensitive, setIsCaseSensitive] = useState(false);
  const [isWholeWord, setIsWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [includePattern, setIncludePattern] = useState("");
  const [excludePattern, setExcludePattern] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [replaceText, setReplaceText] = useState("");
  const [confirmReplaceOpen, setConfirmReplaceOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ReplaceApplyResult | null>(
    null,
  );
  // M50: take a rollback snapshot before writing. Owner-only; default on for
  // owners.
  const [createSnapshot, setCreateSnapshot] = useState(isOwner);
  // M50: files the user has explicitly excluded from Replace All. Empty means
  // "every matched file is selected". Reset whenever a fresh preview lands.
  const [deselectedFiles, setDeselectedFiles] = useState<Set<string>>(
    new Set(),
  );

  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());

  useEffect(() => {
    setCreateSnapshot(isOwner);
  }, [isOwner]);

  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Focus management
  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      setTimeout(() => inputRef.current?.focus(), 20);
    } else {
      if (
        previousFocusRef.current &&
        typeof previousFocusRef.current.focus === "function"
      ) {
        previousFocusRef.current.focus();
      }
    }
  }, [isOpen]);

  const executeSearch = useCallback(
    async (searchQuery: string) => {
      if (!project || !searchQuery || !searchQuery.trim()) {
        setResults(null);
        setError(null);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        // Replace mode reuses the same matching engine (dryRun defaults to
        // true, so this call never writes to disk) — it's a strict superset
        // of the search response, adding a per-match `replacedLineContent`
        // preview, so the same results list below renders either shape.
        const endpoint = showReplace ? "search/replace" : "search";
        const res = await api<SearchResponse>(
          `/api/projects/${project.id}/${endpoint}`,
          {
            method: "POST",
            body: JSON.stringify({
              query: searchQuery,
              ...(showReplace ? { replacement: replaceText } : {}),
              isCaseSensitive,
              isWholeWord,
              isRegex,
              includePattern: includePattern.trim() || undefined,
              excludePattern: excludePattern.trim() || undefined,
            }),
          },
        );
        setResults(res);
        // A fresh preview supersedes any previous per-file selection — start
        // again with every matched file selected.
        setDeselectedFiles(new Set());
      } catch (err: any) {
        setError(err.message || "Search failed");
        setResults(null);
      } finally {
        setLoading(false);
      }
    },
    [
      project,
      showReplace,
      replaceText,
      isCaseSensitive,
      isWholeWord,
      isRegex,
      includePattern,
      excludePattern,
    ],
  );

  // Trigger search (or replace preview) on query / filter / replacement
  // change with 250ms debounce.
  useEffect(() => {
    if (!isOpen) return;
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    setApplyResult(null);

    if (query.trim().length === 0) {
      setResults(null);
      setError(null);
      return;
    }

    searchTimeoutRef.current = setTimeout(() => {
      executeSearch(query);
    }, 250);

    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, [
    query,
    isCaseSensitive,
    isWholeWord,
    isRegex,
    includePattern,
    excludePattern,
    showReplace,
    replaceText,
    isOpen,
    executeSearch,
  ]);

  // Files currently selected for Replace All (all matched files minus any the
  // user explicitly unchecked).
  const selectedFilePaths = (results?.groups ?? [])
    .map((g) => g.filePath)
    .filter((p) => !deselectedFiles.has(p));
  const selectedMatchCount = (results?.groups ?? [])
    .filter((g) => !deselectedFiles.has(g.filePath))
    .reduce((n, g) => n + g.matches.length, 0);
  const allSelected =
    !!results && deselectedFiles.size === 0 && results.groups.length > 0;

  const toggleFileSelected = (filePath: string) => {
    setDeselectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (!results) return;
    setDeselectedFiles((prev) =>
      prev.size === 0
        ? new Set(results.groups.map((g) => g.filePath))
        : new Set(),
    );
  };

  const handleReplaceAll = async () => {
    if (
      !project ||
      !query.trim() ||
      !results ||
      results.totalMatches === 0 ||
      selectedFilePaths.length === 0
    )
      return;
    setConfirmReplaceOpen(false);
    setApplying(true);
    setError(null);
    try {
      const res = await api<ReplaceApplyResult>(
        `/api/projects/${project.id}/search/replace`,
        {
          method: "POST",
          body: JSON.stringify({
            query,
            replacement: replaceText,
            isCaseSensitive,
            isWholeWord,
            isRegex,
            includePattern: includePattern.trim() || undefined,
            excludePattern: excludePattern.trim() || undefined,
            dryRun: false,
            // Only constrain the server when the user actually narrowed the
            // set; otherwise let it act on the fresh match set it computes.
            files: deselectedFiles.size > 0 ? selectedFilePaths : undefined,
            createSafetySnapshot: isOwner && createSnapshot,
          }),
        },
      );
      setApplyResult(res);
      // M50: hand the actually-written paths to IDE.tsx so any open editor
      // buffer for those files is refreshed — without this a later save from
      // a stale Monaco model silently reverts the replacement.
      const changed = res.results
        .filter((r) => r.status === "replaced")
        .map((r) => r.filePath);
      if (changed.length > 0) onReplaceApplied?.(changed);
      // Re-run the preview so the list reflects what (if anything) remains —
      // e.g. files skipped for being truncated/oversized still show matches.
      await executeSearch(query);
    } catch (err: any) {
      setError(err.message || "Replace failed");
    } finally {
      setApplying(false);
    }
  };

  const toggleFile = (filePath: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div
        className="command-palette-backdrop"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Workspace Text Search"
      >
        <div
          className="command-palette-card"
          style={{ width: "740px", maxHeight: "82vh" }}
          onKeyDown={handleKeyDown}
        >
          {/* Search Header */}
          <div
            style={{
              padding: "14px 18px",
              borderBottom: "1px solid var(--glass-border-subtle)",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div
                style={{
                  width: "30px",
                  height: "30px",
                  borderRadius: "8px",
                  background: "rgba(137, 180, 250, 0.15)",
                  color: "#89b4fa",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <IconSearch size={15} />
              </div>

              <input
                ref={inputRef}
                type="text"
                className="command-palette-input"
                placeholder="Search text in files..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{ fontSize: "14px" }}
              />

              {/* Toggle Badges: Case Sensitive, Whole Word, Regex */}
              <div style={{ display: "flex", gap: "4px", flexShrink: 0 }}>
                <button
                  type="button"
                  className={`glass-btn ${isCaseSensitive ? "glass-btn-primary" : "glass-btn-ghost"}`}
                  onClick={() => setIsCaseSensitive(!isCaseSensitive)}
                  title="Match Case (Alt+C)"
                  style={{
                    fontSize: "11px",
                    padding: "3px 7px",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  Aa
                </button>

                <button
                  type="button"
                  className={`glass-btn ${isWholeWord ? "glass-btn-primary" : "glass-btn-ghost"}`}
                  onClick={() => setIsWholeWord(!isWholeWord)}
                  title="Match Whole Word (Alt+W)"
                  style={{
                    fontSize: "11px",
                    padding: "3px 7px",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  \b
                </button>

                <button
                  type="button"
                  className={`glass-btn ${isRegex ? "glass-btn-primary" : "glass-btn-ghost"}`}
                  onClick={() => setIsRegex(!isRegex)}
                  title="Use Regular Expression (Alt+R)"
                  style={{
                    fontSize: "11px",
                    padding: "3px 7px",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  .*
                </button>

                <button
                  type="button"
                  className={`glass-btn ${showFilters ? "glass-btn-primary" : "glass-btn-ghost"}`}
                  onClick={() => setShowFilters(!showFilters)}
                  title="Toggle Include/Exclude File Filters"
                  style={{ fontSize: "11px", padding: "3px 8px" }}
                >
                  Filters
                </button>

                <button
                  type="button"
                  className={`glass-btn ${showReplace ? "glass-btn-primary" : "glass-btn-ghost"}`}
                  onClick={() => setShowReplace(!showReplace)}
                  title="Toggle Replace"
                  style={{
                    fontSize: "11px",
                    padding: "3px 8px",
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                >
                  <IconEdit size={11} />
                  Replace
                </button>
              </div>
            </div>

            {/* Replace Input Row */}
            {showReplace && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                  }}
                >
                  <div style={{ width: "30px", flexShrink: 0 }} />
                  <input
                    type="text"
                    className="command-palette-input"
                    placeholder="Replace with... (leave empty to delete matches)"
                    value={replaceText}
                    onChange={(e) => setReplaceText(e.target.value)}
                    style={{ fontSize: "14px" }}
                  />
                  <button
                    type="button"
                    className="glass-btn glass-btn-primary"
                    disabled={
                      !query.trim() ||
                      !results ||
                      results.totalMatches === 0 ||
                      selectedFilePaths.length === 0 ||
                      applying
                    }
                    onClick={() => setConfirmReplaceOpen(true)}
                    style={{
                      fontSize: "11px",
                      padding: "5px 10px",
                      flexShrink: 0,
                      whiteSpace: "nowrap",
                    }}
                    title="Replace matches in the selected files"
                  >
                    {applying
                      ? "Replacing..."
                      : `Replace ${
                          results && deselectedFiles.size > 0
                            ? "Selected"
                            : "All"
                        }${results ? ` (${selectedMatchCount})` : ""}`}
                  </button>
                </div>

                {/* M50: safety-snapshot toggle */}
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    fontSize: "11px",
                    color: isOwner ? "var(--fg-secondary)" : "var(--fg-muted)",
                    paddingLeft: "40px",
                    cursor: isOwner ? "pointer" : "default",
                  }}
                  title={
                    isOwner
                      ? "Creates a snapshot before changes so you can restore them from the Snapshots tab"
                      : "Only the project owner can create a safety snapshot"
                  }
                >
                  <input
                    type="checkbox"
                    checked={isOwner && createSnapshot}
                    disabled={!isOwner}
                    onChange={(e) => setCreateSnapshot(e.target.checked)}
                  />
                  <span>
                    Create a safety snapshot first
                    {isOwner
                      ? " — restore anytime from the Snapshots tab"
                      : " (owner only)"}
                  </span>
                </label>
              </div>
            )}

            {/* Last Apply Summary */}
            {applyResult && (
              <div
                style={{
                  fontSize: "11px",
                  color:
                    applyResult.filesChanged > 0
                      ? "#a6e3a1"
                      : "var(--fg-muted)",
                  padding: "2px 2px",
                }}
              >
                Replaced {applyResult.matchesReplaced}{" "}
                {applyResult.matchesReplaced === 1 ? "match" : "matches"} across{" "}
                {applyResult.filesChanged}{" "}
                {applyResult.filesChanged === 1 ? "file" : "files"}.
                {applyResult.snapshotId && (
                  <span style={{ color: "var(--fg-muted)" }}>
                    {" "}
                    A safety snapshot was created — restore it anytime from the
                    Snapshots tab.
                  </span>
                )}
                {applyResult.results.some((r) => r.status === "skipped") && (
                  <span style={{ color: "#fab387" }}>
                    {" "}
                    {
                      applyResult.results.filter((r) => r.status === "skipped")
                        .length
                    }{" "}
                    file(s) skipped (too large or results were truncated) —
                    narrow your search and try again.
                  </span>
                )}
                {applyResult.results.some((r) => r.status === "error") && (
                  <span style={{ color: "#f38ba8" }}>
                    {" "}
                    {
                      applyResult.results.filter((r) => r.status === "error")
                        .length
                    }{" "}
                    file(s) failed to write — see server logs.
                  </span>
                )}
              </div>
            )}

            {/* Collapsible Include / Exclude Filters */}
            {showFilters && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "10px",
                  paddingTop: "4px",
                }}
              >
                <div className="glass-form-group">
                  <input
                    type="text"
                    className="glass-input"
                    placeholder="files to include (e.g. *.ts, src/*)"
                    value={includePattern}
                    onChange={(e) => setIncludePattern(e.target.value)}
                    style={{ fontSize: "12px", padding: "4px 8px" }}
                  />
                </div>
                <div className="glass-form-group">
                  <input
                    type="text"
                    className="glass-input"
                    placeholder="files to exclude (e.g. *.json, test/*)"
                    value={excludePattern}
                    onChange={(e) => setExcludePattern(e.target.value)}
                    style={{ fontSize: "12px", padding: "4px 8px" }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Results Metadata Summary */}
          {results && (
            <div
              style={{
                padding: "6px 18px",
                borderBottom: "1px solid var(--glass-border-subtle)",
                background: "rgba(0, 0, 0, 0.2)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontSize: "11px",
                color: "var(--fg-muted)",
              }}
            >
              <span
                style={{ display: "flex", alignItems: "center", gap: "10px" }}
              >
                {showReplace && results.groups.length > 0 && (
                  <button
                    type="button"
                    className="glass-btn glass-btn-ghost"
                    onClick={toggleSelectAll}
                    style={{ fontSize: "10px", padding: "2px 6px" }}
                    title="Toggle every file in this result set"
                  >
                    {allSelected ? "Deselect all" : "Select all"}
                  </button>
                )}
                <span>
                  {showReplace
                    ? `${selectedMatchCount} of ${results.totalMatches}`
                    : results.totalMatches}{" "}
                  {results.totalMatches === 1 ? "match" : "matches"}
                  {showReplace ? " selected" : ""} in {results.groups.length}{" "}
                  {results.groups.length === 1 ? "file" : "files"} (searched{" "}
                  {results.filesSearched} files in {results.durationMs}ms)
                </span>
              </span>
              {results.truncated && (
                <span style={{ color: "#fab387", fontWeight: 600 }}>
                  Capped at {results.totalMatches} results
                </span>
              )}
            </div>
          )}

          {/* Search Results List */}
          <div
            className="command-palette-results"
            style={{ maxHeight: "460px", padding: "10px" }}
            tabIndex={0}
          >
            {loading ? (
              <div className="command-palette-empty">
                <IconRefresh size={18} className="spinning" color="#89b4fa" />
                <span>Scanning workspace files...</span>
              </div>
            ) : error ? (
              <div
                className="command-palette-empty"
                style={{ color: "#f38ba8" }}
              >
                <span>{error}</span>
              </div>
            ) : !query.trim() ? (
              <div className="command-palette-empty">
                <span>
                  Type text above to search across all workspace files.
                </span>
              </div>
            ) : results && results.groups.length === 0 ? (
              <div className="command-palette-empty">
                <span>No matching results found in workspace.</span>
              </div>
            ) : results ? (
              results.groups.map((group) => {
                const isCollapsed = collapsedFiles.has(group.filePath);

                return (
                  <div
                    key={group.filePath}
                    style={{
                      background: "rgba(255, 255, 255, 0.02)",
                      border: "1px solid var(--glass-border-subtle)",
                      borderRadius: "var(--radius-sm)",
                      marginBottom: "8px",
                      overflow: "hidden",
                    }}
                  >
                    {/* File Header */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        background: "rgba(255, 255, 255, 0.03)",
                      }}
                    >
                      {showReplace && (
                        <input
                          type="checkbox"
                          checked={!deselectedFiles.has(group.filePath)}
                          onChange={() => toggleFileSelected(group.filePath)}
                          title="Include this file in Replace All"
                          aria-label={`Include ${group.filePath} in Replace All`}
                          style={{ margin: "0 2px 0 10px", flexShrink: 0 }}
                        />
                      )}
                      <button
                        type="button"
                        onClick={() => toggleFile(group.filePath)}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "6px 10px",
                          background: "transparent",
                          border: "none",
                          color: "var(--fg-primary)",
                          fontSize: "12px",
                          fontWeight: 600,
                          cursor: "pointer",
                          textAlign: "left",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                          }}
                        >
                          {isCollapsed ? (
                            <IconChevronRight size={12} />
                          ) : (
                            <IconChevronDown size={12} />
                          )}
                          <IconCode size={13} color="var(--accent)" />
                          <span>{group.filePath}</span>
                        </div>

                        <span
                          className="glass-badge glass-badge-info"
                          style={{ fontSize: "10px", padding: "1px 6px" }}
                        >
                          {group.matches.length}
                        </span>
                      </button>
                    </div>

                    {/* Matches In File */}
                    {!isCollapsed && (
                      <div style={{ display: "flex", flexDirection: "column" }}>
                        {group.matches.map((m, idx) => (
                          <button
                            key={`${group.filePath}-${m.lineNumber}-${m.column}-${idx}`}
                            type="button"
                            onClick={() => {
                              onSelectResult(
                                m.filePath,
                                m.lineNumber,
                                m.column,
                                m.matchLength,
                              );
                              onClose();
                            }}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "12px",
                              padding: "5px 12px 5px 28px",
                              background: "transparent",
                              border: "none",
                              borderTop: "1px solid rgba(255, 255, 255, 0.03)",
                              color: "var(--fg-secondary)",
                              fontSize: "12px",
                              fontFamily: "var(--font-mono)",
                              cursor: "pointer",
                              textAlign: "left",
                              transition: "background 100ms ease",
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background =
                                "rgba(137, 180, 250, 0.1)";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = "transparent";
                            }}
                          >
                            <span
                              style={{
                                color: "var(--fg-muted)",
                                minWidth: "32px",
                                textAlign: "right",
                              }}
                            >
                              {m.lineNumber}:
                            </span>

                            <span
                              style={{
                                overflow: "hidden",
                                flex: 1,
                                color: "var(--fg-primary)",
                                minWidth: 0,
                              }}
                            >
                              {showReplace &&
                              m.replacedLineContent !== undefined ? (
                                <span
                                  style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: "1px",
                                  }}
                                  data-testid="replace-diff"
                                >
                                  <span
                                    style={{
                                      color: "#f38ba8",
                                      whiteSpace: "pre-wrap",
                                      wordBreak: "break-all",
                                    }}
                                  >
                                    {"- "}
                                    {m.lineContent}
                                  </span>
                                  <span
                                    style={{
                                      color: "#a6e3a1",
                                      whiteSpace: "pre-wrap",
                                      wordBreak: "break-all",
                                    }}
                                  >
                                    {"+ "}
                                    {m.replacedLineContent}
                                  </span>
                                </span>
                              ) : (
                                <span
                                  style={{
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    display: "block",
                                  }}
                                >
                                  {m.lineContent}
                                </span>
                              )}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            ) : null}
          </div>

          {/* Footer */}
          <div className="command-palette-footer">
            <div className="command-palette-hints">
              <span>
                <kbd className="command-palette-key">Esc</kbd> Close
              </span>
              <span>
                <kbd className="command-palette-key">↵</kbd> Open match in
                editor
              </span>
            </div>
            <div>
              <span>Workspace Text Search</span>
            </div>
          </div>
        </div>
      </div>

      <ConfirmModal
        isOpen={confirmReplaceOpen}
        title="Replace in selected files"
        message={`Replace ${selectedMatchCount} ${
          selectedMatchCount === 1 ? "match" : "matches"
        } across ${selectedFilePaths.length} ${
          selectedFilePaths.length === 1 ? "file" : "files"
        } and write the changes to disk. ${
          isOwner && createSnapshot
            ? "A safety snapshot is taken first — you can restore it from the Snapshots tab."
            : "No safety snapshot will be created."
        }`}
        confirmLabel="Replace files"
        isDestructive={true}
        onConfirm={handleReplaceAll}
        onCancel={() => setConfirmReplaceOpen(false)}
      />
    </>
  );
}
