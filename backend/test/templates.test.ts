import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestConfig, startTestApi, type TestApi } from './helpers.js';
import {
  STARTER_TEMPLATES,
  validateTemplates,
  type ProjectTemplate,
} from '../src/projects/templates.js';
import { getLang } from '../src/execution/languages.js';
import { resolveMainFile } from '../src/execution/detect.js';

let api: TestApi;
let cfg: ReturnType<typeof makeTestConfig>;
let token: string;

beforeAll(async () => {
  cfg = makeTestConfig();
  api = await startTestApi(cfg);

  const authRes = await api.request('POST', '/api/auth/register', {
    body: { username: 'tpltester', password: 'password123' },
  });
  token = authRes.data.token;
});

afterAll(async () => {
  await api?.close();
});

const EXPECTED_IDS = [
  'python',
  'node',
  'typescript',
  'c',
  'cpp-systems',
  'java',
  'static-web',
  'python-data',
  'node-web',
];

describe('Starter template catalog invariants', () => {
  it('validateTemplates() reports no issues for the shipped catalog', () => {
    expect(validateTemplates()).toEqual([]);
  });

  it('contains exactly the intended starter ids, all unique', () => {
    const ids = STARTER_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it('Python is first so it is the modal default', () => {
    expect(STARTER_TEMPLATES[0].id).toBe('python');
  });

  it('every template has valid metadata and a real entry file', () => {
    for (const t of STARTER_TEMPLATES) {
      expect(t.name.trim().length).toBeGreaterThan(0);
      expect(t.description.trim().length).toBeGreaterThan(0);
      expect(getLang(t.language), `language for ${t.id}`).not.toBeNull();
      const paths = t.files.map((f) => f.path);
      expect(paths, `${t.id} entryFile`).toContain(t.entryFile);
    }
  });

  it('no template declares a malformed or escaping file path', () => {
    for (const t of STARTER_TEMPLATES) {
      for (const f of t.files) {
        expect(f.path).toBe(f.path.trim());
        expect(f.path.startsWith('/')).toBe(false);
        expect(f.path.startsWith('\\')).toBe(false);
        expect(/^[a-zA-Z]:/.test(f.path)).toBe(false);
        expect(f.path.split(/[\\/]/)).not.toContain('..');
        expect(f.path.split(/[\\/]/)[0]).not.toBe('.git');
      }
    }
  });

  it('the real run pipeline resolves a main file for every runnable starter', () => {
    for (const t of STARTER_TEMPLATES) {
      const lang = getLang(t.language)!;
      if (!lang.run) continue;
      const main = resolveMainFile(
        lang,
        t.files.map((f) => f.path),
        null,
      );
      expect(main, `resolved main for ${t.id}`).not.toBeNull();
    }
  });

  it('rejects a template whose entry file is missing from its file set', () => {
    const bad: ProjectTemplate = {
      id: 'broken',
      name: 'Broken',
      description: 'x',
      language: 'python',
      entryFile: 'nope.py',
      files: [{ path: 'main.py', content: 'print(1)\n' }],
    };
    const issues = validateTemplates([bad]);
    expect(issues.some((i) => /entryFile/.test(i.problem))).toBe(true);
  });

  it('rejects a template with an escaping file path', () => {
    const bad: ProjectTemplate = {
      id: 'escaper',
      name: 'Escaper',
      description: 'x',
      language: 'python',
      entryFile: 'main.py',
      files: [{ path: '../evil.py', content: 'x' }],
    };
    const issues = validateTemplates([bad]);
    expect(issues.some((i) => /unsafe/.test(i.problem))).toBe(true);
  });

  it('rejects duplicate ids and duplicate display names', () => {
    const a: ProjectTemplate = {
      id: 'dup',
      name: 'Dup',
      description: 'x',
      language: 'python',
      entryFile: 'main.py',
      files: [{ path: 'main.py', content: 'print(1)\n' }],
    };
    const issues = validateTemplates([a, { ...a }]);
    expect(issues.some((i) => /duplicate template id/.test(i.problem))).toBe(true);
    expect(issues.some((i) => /duplicate display name/.test(i.problem))).toBe(true);
  });
});

describe('Project Starter Templates API', () => {
  it('GET /api/projects/templates/catalog returns every starter with files + entryFile', async () => {
    const res = await api.request('GET', '/api/projects/templates/catalog', { token });
    expect(res.status).toBe(200);

    const ids = res.data.templates.map((t: any) => t.id);
    expect([...ids].sort()).toEqual([...EXPECTED_IDS].sort());

    for (const t of res.data.templates) {
      expect(Array.isArray(t.files)).toBe(true);
      expect(t.files.length).toBeGreaterThan(0);
      expect(t.files.map((f: any) => f.path)).toContain(t.entryFile);
    }
  });

  it('POST /api/projects/from-template creates a pre-populated workspace', async () => {
    const res = await api.request('POST', '/api/projects/from-template', {
      token,
      body: { templateId: 'python-data', name: 'My Python Project' },
    });

    expect(res.status).toBe(201);
    expect(res.data.project).toBeDefined();
    expect(res.data.project.name).toBe('My Python Project');

    const treeRes = await api.request('GET', `/api/projects/${res.data.project.id}/tree`, { token });
    expect(treeRes.status).toBe(200);

    const names = treeRes.data.tree.map((n: any) => n.name);
    expect(names).toContain('main.py');
    expect(names).toContain('README.md');
  });

  it('every starter creates a project with the right language and its files on disk', async () => {
    for (const tpl of STARTER_TEMPLATES) {
      const res = await api.request('POST', '/api/projects/from-template', {
        token,
        body: { templateId: tpl.id, name: `starter ${tpl.id}` },
      });
      expect(res.status, `create ${tpl.id}`).toBe(201);
      expect(res.data.project.language, `language ${tpl.id}`).toBe(tpl.language);

      const dir = join(cfg.workspacesDir, res.data.project.id);
      const onDisk = readdirSync(dir);
      for (const f of tpl.files) {
        expect(onDisk, `${tpl.id} wrote ${f.path}`).toContain(f.path);
      }
      expect(onDisk, `${tpl.id} entry file present`).toContain(tpl.entryFile);
    }
  });

  it('rejects an unknown template id', async () => {
    const res = await api.request('POST', '/api/projects/from-template', {
      token,
      body: { templateId: 'does-not-exist', name: 'nope' },
    });
    expect(res.status).toBe(400);
  });
});
