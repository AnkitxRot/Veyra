import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { safeResolve, tree, listFiles } from '../src/files/service.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('safeResolve', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'sr-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  function makeRoot(name: string): string {
    const root = join(tmp, name);
    mkdirSync(root, { recursive: true });
    return root;
  }

  it('resolves a simple relative path', () => {
    const root = makeRoot('r0');
    const result = safeResolve(root, 'foo/bar.txt');
    expect(result).toBe(join(root, 'foo/bar.txt'));
  });

  it('rejects empty path', () => {
    expect(() => safeResolve(makeRoot('r1'), '')).toThrow('path is required');
  });

  it('rejects absolute Unix path', () => {
    expect(() => safeResolve(makeRoot('r2'), '/etc/passwd')).toThrow('path escapes the workspace');
  });

  it('rejects Windows absolute path', () => {
    expect(() => safeResolve(makeRoot('r3'), 'C:\\Windows\\System32')).toThrow('path escapes the workspace');
  });

  it('rejects UNC path', () => {
    expect(() => safeResolve(makeRoot('r4'), '\\\\server\\share')).toThrow('path escapes the workspace');
  });

  it('rejects null byte', () => {
    expect(() => safeResolve(makeRoot('r5'), 'foo\0bar.txt')).toThrow('path escapes the workspace');
  });

  it('allows path traversal within workspace', () => {
    const root = makeRoot('r6');
    const result = safeResolve(root, 'a/../b/c.txt');
    expect(result).toBe(join(root, 'b/c.txt'));
  });

  it('rejects path that escapes workspace', () => {
    expect(() => safeResolve(makeRoot('r7'), '../outside.txt')).toThrow('path escapes the workspace');
  });
});

describe('tree', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'tree-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('returns empty array for non-existent directory', async () => {
    const nodes = await tree(join(tmp, 'nonexistent'));
    expect(nodes).toEqual([]);
  });

  it('skips BUILD_PREFIX directories', async () => {
    const root = join(tmp, 'tree-root');
    mkdirSync(join(root, '.cloudide-build-abc'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'main.js'), 'console.log("hi");');
    const files: string[] = [];
    await listFiles(root, '', files);
    expect(files).toContain('src/main.js');
    expect(files.filter(f => f.startsWith('.cloudide-build-'))).toHaveLength(0);
  });
});

describe('listFiles', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'list-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('returns files in nested directories', async () => {
    const root = join(tmp, 'list-root');
    mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'c', 'deep.txt'), 'deep');
    writeFileSync(join(root, 'top.txt'), 'top');

    const files: string[] = [];
    await listFiles(root, '', files);
    expect(files.sort()).toEqual(['a/b/c/deep.txt', 'top.txt']);
  });

  it('skips node_modules, .venv, and .git', async () => {
    const root = join(tmp, 'list-skip');
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(root, '.venv', 'lib'), { recursive: true });
    mkdirSync(join(root, '.git', 'objects'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), '');
    writeFileSync(join(root, '.venv', 'lib', 'run.py'), '');
    writeFileSync(join(root, '.git', 'objects', 'abc'), '');
    writeFileSync(join(root, 'src', 'main.ts'), '');

    const files: string[] = [];
    await listFiles(root, '', files);
    expect(files).toEqual(['src/main.ts']);
  });
});
