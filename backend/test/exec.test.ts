import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runProject } from '../src/execution/pipeline.js';
import { commandExists, isDockerRunning } from '../src/tools.js';
import { sandboxManager } from '../src/execution/sandbox.js';
import { makeTestConfig, makeWorkspace } from './helpers.js';

const cfg = makeTestConfig();

describe.skipIf(!isDockerRunning())('language execution', () => {
  afterAll(async () => {
    await sandboxManager.cleanupAllSandboxes();
  });

  it('python: runs and returns real stdout with exit code 0', async () => {
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, 'main.py'), 'print("hello from python")\n');
    const r = await runProject(cfg, `test-${randomUUID()}`, ws, {});
    expect(r.type).toBe('success');
    expect(r.stdout.trim()).toBe('hello from python');
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
  });

  it('python: captures stderr and a non-zero exit code', async () => {
    const ws = makeWorkspace(cfg);
    writeFileSync(
      join(ws, 'main.py'),
      'import sys\nprint("to stdout")\nsys.stderr.write("to stderr\\n")\nsys.exit(3)\n',
    );
    const r = await runProject(cfg, `test-${randomUUID()}`, ws, {});
    expect(r.type).toBe('success');
    expect(r.stdout.trim()).toBe('to stdout');
    expect(r.stderr.trim()).toBe('to stderr');
    expect(r.exitCode).toBe(3);
  });

  it('python: supports user-provided stdin', async () => {
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, 'main.py'), 'name = input()\nprint(f"hi {name}")\n');
    const r = await runProject(cfg, `test-${randomUUID()}`, ws, { stdin: 'alice\n' });
    expect(r.type).toBe('success');
    expect(r.stdout.trim()).toBe('hi alice');
    expect(r.exitCode).toBe(0);
  });

  it('node: runs and returns real stdout with exit code 0', async () => {
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, 'main.js'), 'console.log("hello from node")\n');
    const r = await runProject(cfg, `test-${randomUUID()}`, ws, {});
    expect(r.type).toBe('success');
    expect(r.stdout.trim()).toBe('hello from node');
    expect(r.exitCode).toBe(0);
  });

  it('node: captures stderr and a non-zero exit code', async () => {
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, 'main.js'), 'console.error("boom")\nprocess.exit(7)\n');
    const r = await runProject(cfg, `test-${randomUUID()}`, ws, {});
    expect(r.type).toBe('success');
    expect(r.stderr.trim()).toBe('boom');
    expect(r.exitCode).toBe(7);
  });

  it('python: reports runtime errors with a non-zero exit code', async () => {
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, 'main.py'), '1 / 0\n');
    const r = await runProject(cfg, `test-${randomUUID()}`, ws, {});
    expect(r.type).toBe('success');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('ZeroDivisionError');
  });

  it('returns no_main_file when no entry file is present', async () => {
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, 'helper.py'), 'x = 1\n');
    writeFileSync(join(ws, 'util.py'), 'y = 2\n');
    const r = await runProject(cfg, `test-${randomUUID()}`, ws, {});
    expect(r.type).toBe('no_main_file');
  });

  it('returns no_language for an unknown explicit language', async () => {
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, 'main.rs'), 'fn main() {}\n');
    const r = await runProject(cfg, `test-${randomUUID()}`, ws, { language: 'rust' });
    expect(r.type).toBe('no_language');
  });

  it('runs and returns real stdout with exit code 0 for Java when the JDK is available', async () => {
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, 'Main.java'), 'class Main { public static void main(String[] args) { System.out.println("hello java"); } }');
    const r = await runProject(cfg, `test-${randomUUID()}`, ws, { language: 'java' });
    expect(r.type).toBe('success');
    expect(r.stdout).toContain('hello java');
  }, 15000);

  it('resolves activeFile correctly when multiple files exist', async () => {
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, 'helper.py'), 'print("helper")\n');
    writeFileSync(join(ws, 'util.py'), 'print("util")\n');
    const r = await runProject(cfg, `test-${randomUUID()}`, ws, { activeFile: 'helper.py' });
    expect(r.type).toBe('success');
    expect(r.stdout.trim()).toBe('helper');
  });

  it('returns not_runnable when file type cannot be executed', async () => {
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, 'styles.css'), 'body {}');
    const r = await runProject(cfg, `test-${randomUUID()}`, ws, { activeFile: 'styles.css' });
    expect(r.type).toBe('not_runnable');
  });
});
