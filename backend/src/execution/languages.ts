import { posix } from 'node:path';

export interface LangCtx {
  workspaceDir: string;
  mainFile: string;
  buildDir: string;
  files: string[];
}

export interface LanguageRuntime {
  id: string;
  name: string;
  extensions: string[];
  markers: string[];
  toolchain: string[];
  mainFiles: string[];
  compile?: {
    cmd: string;
    args: (ctx: LangCtx) => string[];
  };
  run?: {
    cmd: (ctx: LangCtx) => string;
    args: (ctx: LangCtx) => string[];
  };
}

const C_SOURCES = (files: string[], ext: RegExp) => files.filter((f) => ext.test(f));
const executableName = () => 'a.out';

export const registry: LanguageRuntime[] = [
  {
    id: 'python',
    name: 'Python',
    extensions: ['py'],
    markers: ['requirements.txt'],
    toolchain: ['python3'],
    mainFiles: ['main.py'],
    run: {
      cmd: () => 'python3',
      args: (ctx) => ['-u', ctx.mainFile],
    },
  },
  {
    id: 'node',
    name: 'JavaScript (Node.js)',
    extensions: ['js', 'mjs', 'cjs'],
    markers: ['package.json'],
    toolchain: ['node'],
    mainFiles: ['main.js', 'index.js'],
    run: {
      cmd: () => 'node',
      args: (ctx) => [ctx.mainFile],
    },
  },
  {
    id: 'c',
    name: 'C',
    extensions: ['c'],
    markers: [],
    toolchain: ['gcc'],
    mainFiles: ['main.c'],
    compile: {
      cmd: 'gcc',
      args: (ctx) => [
        '-O2',
        '-Wall',
        '-Wextra',
        '-o',
        posix.join(ctx.buildDir, executableName()),
        ...C_SOURCES(ctx.files, /\.c$/),
      ],
    },
    run: {
      cmd: (ctx) => posix.join(ctx.buildDir, executableName()),
      args: () => [],
    },
  },
  {
    id: 'cpp',
    name: 'C++',
    extensions: ['cpp', 'cc', 'cxx'],
    markers: [],
    toolchain: ['g++'],
    mainFiles: ['main.cpp', 'main.cc'],
    compile: {
      cmd: 'g++',
      args: (ctx) => [
        '-std=c++17',
        '-O2',
        '-Wall',
        '-Wextra',
        '-o',
        posix.join(ctx.buildDir, executableName()),
        ...C_SOURCES(ctx.files, /\.(cpp|cc|cxx)$/),
      ],
    },
    run: {
      cmd: (ctx) => posix.join(ctx.buildDir, executableName()),
      args: () => [],
    },
  },
  {
    id: 'java',
    name: 'Java',
    extensions: ['java'],
    markers: [],
    toolchain: ['javac', 'java'],
    mainFiles: ['Main.java', 'main.java'],
    compile: {
      cmd: 'javac',
      args: (ctx) => ['-d', ctx.buildDir, ...ctx.files.filter((f) => f.endsWith('.java'))],
    },
    run: {
      cmd: () => 'java',
      args: (ctx) => ['-cp', ctx.buildDir, javaMainClass(ctx)],
    },
  },
  {
    id: 'typescript',
    name: 'TypeScript',
    extensions: ['ts'],
    markers: ['tsconfig.json'],
    toolchain: ['tsx'],
    mainFiles: ['main.ts', 'index.ts'],
    run: {
      cmd: () => 'tsx',
      args: (ctx) => [ctx.mainFile],
    },
  },
  {
    id: 'html',
    name: 'HTML',
    extensions: ['html', 'htm'],
    markers: [],
    toolchain: [],
    mainFiles: ['index.html'],
  },
  {
    id: 'css',
    name: 'CSS',
    extensions: ['css'],
    markers: [],
    toolchain: [],
    mainFiles: ['styles.css', 'index.css'],
  },
  {
    id: 'json',
    name: 'JSON',
    extensions: ['json'],
    markers: [],
    toolchain: [],
    mainFiles: [],
  },
  {
    id: 'markdown',
    name: 'Markdown',
    extensions: ['md'],
    markers: [],
    toolchain: [],
    mainFiles: ['README.md'],
  },
  {
    id: 'react',
    name: 'React',
    extensions: ['jsx', 'tsx'],
    markers: [],
    toolchain: [],
    mainFiles: ['App.tsx', 'App.jsx'],
  }
];

function javaMainClass(ctx: LangCtx): string {
  const candidate = ctx.files.find((f) => f.endsWith('.java')) ?? 'Main.java';
  return candidate.replace(/\.java$/, '').split('/').pop() ?? 'Main';
}

export function getLang(id: string): LanguageRuntime | null {
  return registry.find((l) => l.id === id) ?? null;
}
