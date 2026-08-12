import { describe, it, expect } from 'vitest';
import { detectLanguage, resolveMainFile } from '../src/execution/detect.js';

describe('language detection', () => {
  it('detects Node.js from a package.json marker', () => {
    expect(detectLanguage(['package.json', 'index.js'])?.id).toBe('node');
  });

  it('detects Python from the dominant extension', () => {
    expect(detectLanguage(['app.py'])?.id).toBe('python');
  });

  it('detects C and C++ from extensions', () => {
    expect(detectLanguage(['main.c'])?.id).toBe('c');
    expect(detectLanguage(['main.cpp'])?.id).toBe('cpp');
  });

  it('returns null for unknown files', () => {
    expect(detectLanguage(['unknown.abc'])).toBeNull();
  });

  it('respects an explicit language override', () => {
    expect(detectLanguage(['foo.py'], 'node')?.id).toBe('node');
  });
});

describe('main file resolution', () => {
  const python = detectLanguage(['main.py', 'util.py'], 'python')!;
  const c = detectLanguage(['main.c', 'foo.c'], 'c')!;

  it('prefers the canonical main file', () => {
    expect(resolveMainFile(python, ['main.py', 'util.py'])).toBe('main.py');
  });

  it('falls back to a single file of the language', () => {
    expect(resolveMainFile(python, ['only.py'])).toBe('only.py');
  });

  it('returns null when ambiguous', () => {
    expect(resolveMainFile(python, ['a.py', 'b.py'])).toBeNull();
  });

  it('handles compiled languages', () => {
    expect(resolveMainFile(c, ['main.c', 'foo.c'])).toBe('main.c');
  });
});
