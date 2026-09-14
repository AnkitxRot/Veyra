import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Command, CommandCategory } from '../../utils/commands';
import { IndexedFile, searchFileIndex } from '../../utils/fileIndex';
import { IS_MAC } from '../../hooks/useKeyboardShortcuts';
import type { WorkspaceSymbolHit } from '../../lsp/workspaceSymbols';
import {
  IconCode,
  IconTerminal,
  IconMonitor,
  IconLayers,
  IconShield,
} from './Icons';

export type PaletteMode = 'commands' | 'files' | 'symbols';

export interface CommandPaletteModalProps {
  isOpen: boolean;
  initialMode?: PaletteMode;
  onClose: () => void;
  fileIndex: IndexedFile[];
  recentFiles: string[];
  onOpenFile: (path: string) => void;
  commands: Command[];
  onExecuteCommand: (id: string) => void;
  searchSymbols?: (query: string) => Promise<WorkspaceSymbolHit[]>;
  onOpenSymbol?: (hit: WorkspaceSymbolHit) => void;
}

export default function CommandPaletteModal({
  isOpen,
  initialMode = 'files',
  onClose,
  fileIndex,
  recentFiles,
  onOpenFile,
  commands,
  onExecuteCommand,
  searchSymbols,
  onOpenSymbol,
}: CommandPaletteModalProps) {
  const [mode, setMode] = useState<PaletteMode>(initialMode);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [symbols, setSymbols] = useState<WorkspaceSymbolHit[]>([]);
  const [symbolsLoading, setSymbolsLoading] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Sync mode when initialMode changes or modal opens
  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      setMode(initialMode);
      setQuery('');
      setSelectedIndex(0);
      setSymbols([]);
      setTimeout(() => {
        inputRef.current?.focus();
      }, 20);
    } else {
      if (previousFocusRef.current && typeof previousFocusRef.current.focus === 'function') {
        previousFocusRef.current.focus();
      }
    }
  }, [isOpen, initialMode]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val.startsWith('>')) {
      setMode('commands');
      setQuery(val.slice(1).trimStart());
    } else if (val.startsWith('#')) {
      setMode('symbols');
      setQuery(val.slice(1));
    } else {
      setQuery(val);
    }
    setSelectedIndex(0);
  };

  const filteredFiles = useMemo(() => {
    if (mode !== 'files') return [];
    return searchFileIndex(fileIndex, query, recentFiles);
  }, [mode, fileIndex, query, recentFiles]);

  const filteredCommands = useMemo(() => {
    if (mode !== 'commands') return [];
    const cleanQuery = query.trim().toLowerCase();
    const available = commands.filter((c) => (c.available ? c.available() : true));

    if (!cleanQuery) return available;

    return available.filter((c) => {
      const matchText = `${c.category} ${c.title} ${c.description || ''}`.toLowerCase();
      return matchText.includes(cleanQuery);
    });
  }, [mode, commands, query]);

  useEffect(() => {
    if (!isOpen || mode !== 'symbols') {
      setSymbols([]);
      setSymbolsLoading(false);
      return;
    }
    if (!searchSymbols) {
      setSymbols([]);
      return;
    }
    let cancelled = false;
    setSymbolsLoading(true);
    const timer = setTimeout(() => {
      void searchSymbols(query)
        .then((hits) => {
          if (!cancelled) setSymbols(hits);
        })
        .catch(() => {
          if (!cancelled) setSymbols([]);
        })
        .finally(() => {
          if (!cancelled) setSymbolsLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isOpen, mode, query, searchSymbols]);

  const totalItems =
    mode === 'files'
      ? filteredFiles.length
      : mode === 'symbols'
        ? symbols.length
        : filteredCommands.length;

  useEffect(() => {
    if (selectedIndex >= totalItems) {
      setSelectedIndex(Math.max(0, totalItems - 1));
    }
  }, [totalItems, selectedIndex]);

  useEffect(() => {
    if (!listRef.current) return;
    const selectedEl = listRef.current.querySelector('.command-palette-item.selected') as HTMLElement | null;
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleSelectCurrent = () => {
    if (totalItems === 0) return;

    if (mode === 'files') {
      const file = filteredFiles[selectedIndex];
      if (file) {
        onOpenFile(file.path);
        onClose();
      }
      return;
    }
    if (mode === 'symbols') {
      const hit = symbols[selectedIndex];
      if (hit && onOpenSymbol) {
        onOpenSymbol(hit);
        onClose();
      }
      return;
    }
    const cmd = filteredCommands[selectedIndex];
    if (cmd) {
      onExecuteCommand(cmd.id);
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1 < totalItems ? prev + 1 : 0));
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 >= 0 ? prev - 1 : Math.max(0, totalItems - 1)));
      return;
    }

    if (e.key === 'PageDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(totalItems - 1, prev + 8));
      return;
    }

    if (e.key === 'PageUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(0, prev - 8));
      return;
    }

    if (e.key === 'Home') {
      e.preventDefault();
      setSelectedIndex(0);
      return;
    }

    if (e.key === 'End') {
      e.preventDefault();
      setSelectedIndex(Math.max(0, totalItems - 1));
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      handleSelectCurrent();
      return;
    }
  };

  if (!isOpen) return null;

  const renderFileIcon = (ext: string) => {
    switch (ext) {
      case 'py':
        return <span style={{ color: '#f9e2af', fontSize: '13px', fontWeight: 700 }}>Py</span>;
      case 'c':
      case 'h':
        return <span style={{ color: '#89b4fa', fontSize: '13px', fontWeight: 700 }}>C</span>;
      case 'cpp':
      case 'hpp':
        return <span style={{ color: '#89dceb', fontSize: '13px', fontWeight: 700 }}>C++</span>;
      case 'js':
      case 'jsx':
        return <span style={{ color: '#f9e2af', fontSize: '13px', fontWeight: 700 }}>JS</span>;
      case 'ts':
      case 'tsx':
        return <span style={{ color: '#89b4fa', fontSize: '13px', fontWeight: 700 }}>TS</span>;
      case 'json':
        return <span style={{ color: '#a6e3a1', fontSize: '13px', fontWeight: 700 }}>{}</span>;
      case 'html':
      case 'css':
        return <span style={{ color: '#fab387', fontSize: '13px', fontWeight: 700 }}>&lt;&gt;</span>;
      default:
        return <IconCode size={13} color="var(--fg-muted)" />;
    }
  };

  const renderCategoryIcon = (category: CommandCategory) => {
    switch (category) {
      case 'Navigation':
        return <IconLayers size={13} color="#89b4fa" />;
      case 'Workspace':
        return <IconCode size={13} color="#a6e3a1" />;
      case 'Execution':
        return <IconTerminal size={13} color="#f9e2af" />;
      case 'UI':
        return <IconMonitor size={13} color="#cba6f7" />;
      case 'Admin':
        return <IconShield size={13} color="#f38ba8" />;
      default:
        return <IconLayers size={13} color="var(--fg-muted)" />;
    }
  };

  const ariaLabel =
    mode === 'commands'
      ? 'Command Palette'
      : mode === 'symbols'
        ? 'Go to Symbol in Workspace'
        : 'Quick Open File';

  return (
    <div
      className="command-palette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div className="command-palette-card" onKeyDown={handleKeyDown}>
        <div className="command-palette-header">
          <span
            className={`command-palette-mode-badge ${mode}`}
            onClick={() =>
              setMode(mode === 'commands' ? 'files' : mode === 'files' ? 'symbols' : 'commands')
            }
            title="Click to toggle mode"
            style={{ cursor: 'pointer' }}
          >
            {mode === 'commands' ? 'Commands' : mode === 'symbols' ? 'Symbols' : 'Files'}
          </span>

          <input
            ref={inputRef}
            type="text"
            className="command-palette-input"
            data-testid="command-palette-input"
            placeholder={
              mode === 'commands'
                ? 'Type a command to run...'
                : mode === 'symbols'
                  ? 'Search workspace symbols...'
                  : 'Search files by name (type > for commands, # for symbols)...'
            }
            value={query}
            onChange={handleInputChange}
            aria-autocomplete="list"
            aria-controls="command-palette-list"
          />
        </div>

        <div className="command-palette-results" ref={listRef} id="command-palette-list" role="listbox">
          {mode === 'files' ? (
            filteredFiles.length === 0 ? (
              <div className="command-palette-empty">
                <span>No matching files found in workspace</span>
              </div>
            ) : (
              filteredFiles.map((file, idx) => {
                const isSelected = idx === selectedIndex;
                const isRecent = recentFiles.includes(file.path);
                return (
                  <button
                    key={file.path}
                    type="button"
                    className={`command-palette-item ${isSelected ? 'selected' : ''}`}
                    onClick={() => {
                      onOpenFile(file.path);
                      onClose();
                    }}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    role="option"
                    aria-selected={isSelected}
                  >
                    <div className="command-palette-item-left">
                      <div className="command-palette-item-icon">
                        {renderFileIcon(file.extension)}
                      </div>
                      <div className="command-palette-item-text">
                        <span className="command-palette-item-title">{file.filename}</span>
                        <span className="command-palette-item-sub">
                          {file.directory || '.'}
                        </span>
                      </div>
                    </div>

                    {isRecent && !query && (
                      <span className="glass-badge glass-badge-info" style={{ fontSize: '9px', padding: '1px 6px' }}>
                        RECENT
                      </span>
                    )}
                  </button>
                );
              })
            )
          ) : mode === 'symbols' ? (
            symbolsLoading && symbols.length === 0 ? (
              <div className="command-palette-empty">
                <span>Searching symbols…</span>
              </div>
            ) : symbols.length === 0 ? (
              <div className="command-palette-empty" data-testid="command-palette-symbols-empty">
                <span>
                  {searchSymbols
                    ? 'No matching symbols. Open a Python or TypeScript file so the language server is ready.'
                    : 'Workspace symbols require a language server.'}
                </span>
              </div>
            ) : (
              symbols.map((hit, idx) => {
                const isSelected = idx === selectedIndex;
                return (
                  <button
                    key={`${hit.filePath}:${hit.line}:${hit.name}:${idx}`}
                    type="button"
                    className={`command-palette-item ${isSelected ? 'selected' : ''}`}
                    data-testid="command-palette-symbol"
                    onClick={() => {
                      onOpenSymbol?.(hit);
                      onClose();
                    }}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    role="option"
                    aria-selected={isSelected}
                  >
                    <div className="command-palette-item-left">
                      <div className="command-palette-item-icon">
                        <IconLayers size={13} color="#89b4fa" />
                      </div>
                      <div className="command-palette-item-text">
                        <span className="command-palette-item-title">{hit.name}</span>
                        <span className="command-palette-item-sub">
                          {hit.containerName ? `${hit.containerName} · ` : ''}
                          {hit.filePath}:{hit.line}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })
            )
          ) : filteredCommands.length === 0 ? (
            <div className="command-palette-empty">
              <span>No matching commands found</span>
            </div>
          ) : (
            filteredCommands.map((cmd, idx) => {
              const isSelected = idx === selectedIndex;
              const shortcutDisplay = IS_MAC && cmd.macShortcut ? cmd.macShortcut : cmd.shortcut;

              return (
                <button
                  key={cmd.id}
                  type="button"
                  className={`command-palette-item ${isSelected ? 'selected' : ''}`}
                  onClick={() => {
                    onExecuteCommand(cmd.id);
                    onClose();
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  role="option"
                  aria-selected={isSelected}
                >
                  <div className="command-palette-item-left">
                    <div className="command-palette-item-icon">
                      {renderCategoryIcon(cmd.category)}
                    </div>
                    <div className="command-palette-item-text">
                      <span className="command-palette-item-title">{cmd.title}</span>
                      {cmd.description && (
                        <span className="command-palette-item-sub">{cmd.description}</span>
                      )}
                    </div>
                  </div>

                  {shortcutDisplay && (
                    <span className="command-palette-item-shortcut">{shortcutDisplay}</span>
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="command-palette-footer">
          <div className="command-palette-hints">
            <span>
              <kbd className="command-palette-key">↑</kbd>
              <kbd className="command-palette-key">↓</kbd> Navigate
            </span>
            <span>
              <kbd className="command-palette-key">↵</kbd> Select
            </span>
            <span>
              <kbd className="command-palette-key">Esc</kbd> Close
            </span>
          </div>

          <div>
            <span>
              {mode === 'files' ? (
                <span>
                  Tip: Type <kbd className="command-palette-key">&gt;</kbd> for commands,{' '}
                  <kbd className="command-palette-key">#</kbd> for symbols
                </span>
              ) : mode === 'symbols' ? (
                <span>Language-server workspace symbols</span>
              ) : (
                <span>Category: All</span>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
