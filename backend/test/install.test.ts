import { describe, it, expect, afterEach } from 'vitest';
import { resolveInstallSpec } from '../src/projects/install.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'install-spec-'));
}

describe('resolveInstallSpec', () => {
  afterEach(() => {
    // cleanup temp dirs created by makeWorkspace
  });

  it('case 1: package.json only → { cmd: "npm", args: ["install", "--ignore-scripts"] }', async () => {
    const dir = makeWorkspace();
    writeFileSync(join(dir, 'package.json'), '{"name":"test"}');
    const result = await resolveInstallSpec({ workspaceDir: dir, language: 'auto' });
    expect(result.cmd).toBe('npm');
    expect(result.args).toEqual(['install', '--ignore-scripts']);
    expect(result.message).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });

  it('case 2: requirements.txt only → { cmd: "sh", args: [...] }', async () => {
    const dir = makeWorkspace();
    writeFileSync(join(dir, 'requirements.txt'), 'requests==2.31.0\n');
    const result = await resolveInstallSpec({ workspaceDir: dir, language: 'auto' });
    expect(result.cmd).toBe('sh');
    expect(result.args).toEqual(['-c', 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt']);
    expect(result.message).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });

  it('case 3: both manifests → Python venv (Python takes precedence)', async () => {
    const dir = makeWorkspace();
    writeFileSync(join(dir, 'package.json'), '{"name":"test"}');
    writeFileSync(join(dir, 'requirements.txt'), 'flask==3.0.0\n');
    const result = await resolveInstallSpec({ workspaceDir: dir, language: 'auto' });
    expect(result.cmd).toBe('sh');
    expect(result.args).toEqual(['-c', 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt']);
    expect(result.message).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });

  it('case 4: no manifests, language=node → npm', async () => {
    const dir = makeWorkspace();
    const result = await resolveInstallSpec({ workspaceDir: dir, language: 'node' });
    expect(result.cmd).toBe('npm');
    expect(result.args).toEqual(['install', '--ignore-scripts']);
    expect(result.message).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });

  it('case 5: no manifests, language=typescript → npm', async () => {
    const dir = makeWorkspace();
    const result = await resolveInstallSpec({ workspaceDir: dir, language: 'typescript' });
    expect(result.cmd).toBe('npm');
    expect(result.args).toEqual(['install', '--ignore-scripts']);
    expect(result.message).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });

  it('case 6: no manifests, language=python → Python venv', async () => {
    const dir = makeWorkspace();
    const result = await resolveInstallSpec({ workspaceDir: dir, language: 'python' });
    expect(result.cmd).toBe('sh');
    expect(result.args).toEqual(['-c', 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt']);
    expect(result.message).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });

  it('case 7: language=auto, no manifests → null', async () => {
    const dir = makeWorkspace();
    const result = await resolveInstallSpec({ workspaceDir: dir, language: 'auto' });
    expect(result.cmd).toBeNull();
    expect(result.args).toEqual([]);
    expect(result.message).toBe('No dependency configuration found for this language');
    rmSync(dir, { recursive: true, force: true });
  });
});
