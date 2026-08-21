import { useEffect } from 'react';

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export interface ShortcutHandlers {
  onOpenCommandPalette: () => void;
  onOpenQuickOpen: () => void;
  onSave?: () => void;
  onRun?: () => void;
  onToggleSidebar?: () => void;
  onToggleBottomPanel?: () => void;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers, enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = IS_MAC ? e.metaKey : e.ctrlKey;
      const key = e.key.toLowerCase();

      // 1. Command Palette: Ctrl+Shift+P / Cmd+Shift+P
      if (isMod && e.shiftKey && key === 'p') {
        e.preventDefault();
        e.stopPropagation();
        handlers.onOpenCommandPalette();
        return;
      }

      // 2. Quick Open: Ctrl+P / Cmd+P (Must intercept over browser print)
      if (isMod && !e.shiftKey && !e.altKey && key === 'p') {
        e.preventDefault();
        e.stopPropagation();
        handlers.onOpenQuickOpen();
        return;
      }

      // 3. Save File: Ctrl+S / Cmd+S
      if (isMod && !e.shiftKey && key === 's') {
        e.preventDefault();
        e.stopPropagation();
        if (handlers.onSave) handlers.onSave();
        return;
      }

      // 4. Toggle Sidebar: Ctrl+B / Cmd+B
      if (isMod && !e.shiftKey && key === 'b') {
        // Only trigger if not typing inside an editable field that needs bold
        const target = e.target as HTMLElement | null;
        const isEditable = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
        if (!isEditable) {
          e.preventDefault();
          if (handlers.onToggleSidebar) handlers.onToggleSidebar();
        }
        return;
      }

      // 5. Toggle Bottom Drawer: Ctrl+J / Cmd+J
      if (isMod && !e.shiftKey && key === 'j') {
        e.preventDefault();
        if (handlers.onToggleBottomPanel) handlers.onToggleBottomPanel();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [handlers, enabled]);
}
