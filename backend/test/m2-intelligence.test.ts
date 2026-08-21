import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { searchProjectContent } from '../src/projects/search.js';
import { formatProjectFile } from '../src/projects/format.js';

describe('M2 Code Intelligence: Workspace Content Search', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cloudeee-search-test-'));

    // Populate mock project files
    writeFileSync(join(tempDir, 'main.py'), 'def hello():\n    print("Hello CloudeeeIDE")\n    x = 42\n');
    writeFileSync(join(tempDir, 'utils.py'), 'def calculate():\n    return 42\n# Hello world comment\n');
    
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'App.tsx'), 'import React from "react";\nexport const App = () => <div>Hello React</div>;\n');
    writeFileSync(join(tempDir, 'src', 'index.ts'), 'console.log("App starting...");\nconst HELLO_CONST = 100;\n');
    
    // Add binary mock file
    writeFileSync(join(tempDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x00, 0x00]));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('performs plain text content search across files', async () => {
    const res = await searchProjectContent(tempDir, { query: 'Hello' });
    expect(res.totalMatches).toBe(5); // main.py (2), utils.py (1), src/App.tsx (1), src/index.ts (1)
    expect(res.groups.length).toBe(4);
    expect(res.filesSearched).toBeGreaterThanOrEqual(4);
    expect(res.truncated).toBe(false);
  });

  it('respects case sensitivity flag', async () => {
    const caseInsensitiveRes = await searchProjectContent(tempDir, { query: 'hello', isCaseSensitive: false });
    expect(caseInsensitiveRes.totalMatches).toBe(5); // all case variations

    const caseSensitiveRes = await searchProjectContent(tempDir, { query: 'Hello', isCaseSensitive: true });
    expect(caseSensitiveRes.totalMatches).toBe(3); // main.py, utils.py, src/App.tsx
  });

  it('respects whole word matching flag', async () => {
    const allMatches = await searchProjectContent(tempDir, { query: 'App', isCaseSensitive: true });
    expect(allMatches.totalMatches).toBe(2); // src/App.tsx (App = () =>), src/index.ts (App starting)

    const wholeWordRes = await searchProjectContent(tempDir, { query: 'App', isWholeWord: true, isCaseSensitive: true });
    expect(wholeWordRes.totalMatches).toBe(2);
  });

  it('executes regular expression search safely', async () => {
    const regexRes = await searchProjectContent(tempDir, { query: 'x\\s*=\\s*\\d+', isRegex: true });
    expect(regexRes.totalMatches).toBe(1);
    expect(regexRes.groups[0].filePath).toBe('main.py');
    expect(regexRes.groups[0].matches[0].lineContent).toContain('x = 42');
  });

  it('ignores binary files automatically', async () => {
    const res = await searchProjectContent(tempDir, { query: 'PNG' });
    const binaryGroup = res.groups.find((g) => g.filePath.endsWith('.png'));
    expect(binaryGroup).toBeUndefined();
  });

  it('enforces maximum result limit and sets truncated flag', async () => {
    const res = await searchProjectContent(tempDir, { query: 'e', maxResults: 2 });
    expect(res.totalMatches).toBe(2);
    expect(res.truncated).toBe(true);
  });

  it('rejects invalid regex patterns with 400 error', async () => {
    await expect(
      searchProjectContent(tempDir, { query: '[unclosed regex', isRegex: true })
    ).rejects.toThrow();
  });
});

describe('M2 Code Intelligence: Auto-Formatting Engine', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cloudeee-format-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('formats JSON files with standard 2-space indentation', async () => {
    const rawJson = '{"name":"CloudeeeIDE","version":1,"features":["terminal","editor"]}';
    const res = await formatProjectFile(tempDir, 'package.json', rawJson);
    expect(res.changed).toBe(true);
    expect(res.formatted).toContain('  "name": "CloudeeeIDE"');
    expect(res.formatted.endsWith('\n')).toBe(true);
  });

  it('handles invalid JSON gracefully without destroying user code', async () => {
    const brokenJson = '{"broken": json}';
    const res = await formatProjectFile(tempDir, 'broken.json', brokenJson);
    expect(res.changed).toBe(false);
    expect(res.formatted).toBe(brokenJson);
    expect(res.warning).toBeDefined();
  });

  it('normalizes Python whitespace and trailing newlines', async () => {
    const rawPy = 'def add(a, b):   \n    return a + b    \n\n\n\n';
    const res = await formatProjectFile(tempDir, 'math.py', rawPy);
    expect(res.changed).toBe(true);
    expect(res.formatted).toBe('def add(a, b):\n    return a + b\n');
  });

  it('normalizes C/C++ source code whitespace and trailing lines', async () => {
    const rawC = '#include <stdio.h>   \nint main() {   \n    printf("hi\\n");   \n}   \n\n\n';
    const res = await formatProjectFile(tempDir, 'main.c', rawC);
    expect(res.changed).toBe(true);
    expect(res.formatted).toBe('#include <stdio.h>\nint main() {\n    printf("hi\\n");\n}\n');
  });

  it('blocks path traversal attempts on format', async () => {
    await expect(
      formatProjectFile(tempDir, '../escape.js', 'console.log("bad");')
    ).rejects.toThrow('Invalid file path');
  });
});
