import { extname } from 'node:path';
import type { LanguageRuntime } from './languages.js';
import { registry } from './languages.js';

export function detectLanguage(files: string[], explicit?: string | null, activeFile?: string | null): LanguageRuntime | null {
  if (explicit && explicit !== 'auto') return registry.find((l) => l.id === explicit) ?? null;
  
  if (activeFile) {
    const ext = extname(activeFile).slice(1);
    const activeLang = registry.find((l) => l.extensions.includes(ext));
    if (activeLang) return activeLang;
  }

  for (const lang of registry) {
    if (lang.markers.some((m) => files.includes(m))) return lang;
  }
  let best: LanguageRuntime | null = null;
  let bestCount = 0;
  for (const lang of registry) {
    const count = files.filter((f) => lang.extensions.includes(extname(f).slice(1))).length;
    if (count > bestCount) {
      best = lang;
      bestCount = count;
    }
  }
  return bestCount > 0 ? best : null;
}

export function resolveMainFile(lang: LanguageRuntime, files: string[], activeFile?: string | null): string | null {
  if (activeFile && lang.extensions.includes(extname(activeFile).slice(1))) {
    return activeFile;
  }
  for (const main of lang.mainFiles) {
    if (files.includes(main)) return main;
  }
  const candidates = files.filter((f) => lang.extensions.includes(extname(f).slice(1)));
  return candidates.length === 1 ? candidates[0] : null;
}
