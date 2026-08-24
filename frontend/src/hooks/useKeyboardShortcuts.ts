import { useEffect, useRef } from 'react';

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

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

export function useKeyboardShortcuts(handlers: ShortcutHandlers, enabled = true) {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = IS_MAC ? e.metaKey : e.ctrlKey;
      const key = e.key.toLowerCase();
      const currentHandlers = handlersRef.current;

      // 1. Command Palette: Ctrl+Shift+P / Cmd+Shift+P
      if (isMod && e.shiftKey && key === 'p') {
        e.preventDefault();
        e.stopPropagation();
        currentHandlers.onOpenCommandPalette();
        return;
      }

      // 2. Quick Open: Ctrl+P / Cmd+P (Must intercept over browser print)
      if (isMod && !e.shiftKey && !e.altKey && key === 'p') {
        e.preventDefault();
        e.stopPropagation();
        currentHandlers.onOpenQuickOpen();
        return;
      }

      // 3. Save File: Ctrl+S / Cmd+S → canonical ide-save dispatch.
      //    preventDefault suppresses the browser "save page" dialog;
      //    stopPropagation keeps Monaco's own Ctrl+S command from double-
      //    firing: both paths converge on the same listener, but only one
      //    event must be dispatched per keystroke.
      if (isMod && !e.shiftKey && key === 's') {
        e.preventDefault();
        e.stopPropagation();
        document.dispatchEvent(
          new CustomEvent('ide-save', {
            detail: { path: currentHandlers.getActiveFile?.() ?? null },
          }),
        );
        return;
      }

      // 4. Toggle Sidebar: Ctrl+B / Cmd+B
      if (isMod && !e.shiftKey && key === 'b') {
        // Only trigger if not typing inside an editable field that needs bold
        const target = e.target as HTMLElement | null;
        const isEditable = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
        if (!isEditable) {
          e.preventDefault();
          if (currentHandlers.onToggleSidebar) currentHandlers.onToggleSidebar();
        }
        return;
      }

      // 5. Toggle Bottom Drawer: Ctrl+J / Cmd+J
      if (isMod && !e.shiftKey && key === 'j') {
        e.preventDefault();
        if (currentHandlers.onToggleBottomPanel) currentHandlers.onToggleBottomPanel();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [enabled]);
}
