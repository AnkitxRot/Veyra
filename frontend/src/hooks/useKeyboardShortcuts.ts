import { useEffect, useRef } from 'react';
import {
  chordFromEvent,
  getCommand,
  resolveKeymap,
  IS_MAC,
  type CommandId,
  type ResolvedKeymap,
} from '../keymap/keymap';

// Re-exported for the many call sites that import IS_MAC from this module.
export { IS_MAC };

export interface ShortcutHandlers {
  onOpenCommandPalette: () => void;
  onOpenQuickOpen: () => void;
  /**
   * M1: Ctrl+S no longer routes through a save callback that could read stale
   * React state. The hook resolves the active file path via this accessor and
   * dispatches the canonical `ide-save` CustomEvent; IDE's single save
   * listener re-resolves content from the live Monaco model and persists it.
   */
  getActiveFile?: () => string | null;
  onToggleSidebar?: () => void;
  onToggleBottomPanel?: () => void;
}

/** `mod+s` / `mod+p` are always suppressed at the window level (they are the
 *  IDE's save / quick-open defaults). Even when remapped away, letting the
 *  browser "save page" / "print" dialog appear on those chords is worse for an
 *  IDE than doing nothing. */
const ALWAYS_SUPPRESS = new Set(['mod+s', 'mod+p']);

const EMPTY_RESOLVED = resolveKeymap({});

function isTextInput(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.isContentEditable === true
  );
}

function dispatch(id: CommandId, h: ShortcutHandlers): void {
  switch (id) {
    case 'workbench.action.showCommands':
      h.onOpenCommandPalette();
      break;
    case 'workbench.action.quickOpen':
      h.onOpenQuickOpen();
      break;
    case 'workbench.action.saveFile':
      // M1 canonical save dispatch — path only; IDE re-resolves live content.
      document.dispatchEvent(
        new CustomEvent('ide-save', {
          detail: { path: h.getActiveFile?.() ?? null },
        }),
      );
      break;
    case 'workbench.action.toggleSidebar':
      h.onToggleSidebar?.();
      break;
    case 'workbench.action.toggleBottomPanel':
      h.onToggleBottomPanel?.();
      break;
  }
}

/**
 * M70: the window-level dispatcher for the five configurable IDE-chrome
 * commands. `resolvedKeymap` is read through a ref so a remap never
 * re-registers the listener (no churn, no leak, no double-fire); the listener
 * lifecycle is bound only to `enabled`.
 */
export function useKeyboardShortcuts(
  handlers: ShortcutHandlers,
  enabled = true,
  resolvedKeymap: ResolvedKeymap = EMPTY_RESOLVED,
) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const keymapRef = useRef(resolvedKeymap);
  keymapRef.current = resolvedKeymap;

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const chord = chordFromEvent(e);
      if (!chord) return;

      const id = keymapRef.current.byChord.get(chord);
      if (!id) {
        if (ALWAYS_SUPPRESS.has(chord)) e.preventDefault();
        return;
      }

      const cmd = getCommand(id);
      if (cmd?.skipInTextInput && isTextInput(e.target)) return;

      e.preventDefault();
      e.stopPropagation();
      dispatch(id, handlersRef.current);
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () =>
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [enabled]);
}
