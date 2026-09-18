import { execSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { IS_WINDOWS } from './config.js';

const execFileAsync = promisify(execFile);

export function commandExists(cmd: string): boolean {
  try {
    if (IS_WINDOWS) {
      execSync(`where.exe ${cmd}`, { stdio: 'ignore' });
    } else {
      execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

interface CacheEntry<T> {
  value: T;
  timestamp: number;
}

let dockerCache: CacheEntry<boolean> | null = null;
let runnerCache: CacheEntry<boolean> | null = null;
let inFlightDockerCheck: Promise<boolean> | null = null;
let inFlightRunnerCheck: Promise<boolean> | null = null;
const CACHE_TTL_MS = 15000;

export function resetDockerCacheForTests(): void {
  dockerCache = null;
  runnerCache = null;
  inFlightDockerCheck = null;
  inFlightRunnerCheck = null;
}

export async function isDockerRunningAsync(): Promise<boolean> {
  const now = Date.now();
  if (dockerCache && now - dockerCache.timestamp < CACHE_TTL_MS) {
    return dockerCache.value;
  }
  if (inFlightDockerCheck) {
    return inFlightDockerCheck;
  }
  inFlightDockerCheck = (async () => {
    try {
      await execFileAsync('docker', ['info']);
      dockerCache = { value: true, timestamp: Date.now() };
      return true;
    } catch {
      dockerCache = { value: false, timestamp: Date.now() };
      return false;
    } finally {
      inFlightDockerCheck = null;
    }
  })();
  return inFlightDockerCheck;
}

export async function isRunnerImageAvailableAsync(): Promise<boolean> {
  const now = Date.now();
  if (runnerCache && now - runnerCache.timestamp < CACHE_TTL_MS) {
    return runnerCache.value;
  }
  if (inFlightRunnerCheck) {
    return inFlightRunnerCheck;
  }
  inFlightRunnerCheck = (async () => {
    try {
      const { stdout } = await execFileAsync('docker', ['image', 'inspect', 'cloudeeeide-runner:latest']);
      const available = stdout.includes('cloudeeeide-runner:latest');
      runnerCache = { value: available, timestamp: Date.now() };
      return available;
    } catch {
      runnerCache = { value: false, timestamp: Date.now() };
      return false;
    } finally {
      inFlightRunnerCheck = null;
    }
  })();
  return inFlightRunnerCheck;
}

export function isDockerRunning(): boolean {
  const now = Date.now();
  if (dockerCache && now - dockerCache.timestamp < CACHE_TTL_MS) {
    return dockerCache.value;
  }
  if (!commandExists('docker')) {
    dockerCache = { value: false, timestamp: now };
    return false;
  }
  try {
    execSync('docker info', { stdio: 'ignore' });
    dockerCache = { value: true, timestamp: now };
    return true;
  } catch {
    dockerCache = { value: false, timestamp: now };
    return false;
  }
}

export function isRunnerImageAvailable(): boolean {
  const now = Date.now();
  if (runnerCache && now - runnerCache.timestamp < CACHE_TTL_MS) {
    return runnerCache.value;
  }
  if (!isDockerRunning()) return false;
  try {
    const result = execSync('docker image inspect cloudeeeide-runner:latest', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const available = result.includes('cloudeeeide-runner:latest');
    runnerCache = { value: available, timestamp: now };
    return available;
  } catch {
    runnerCache = { value: false, timestamp: now };
    return false;
  }
}

export interface Capabilities {
  docker: boolean;
  runnerImage: boolean;
  languages: {
    python: boolean;
    node: boolean;
    typescript: boolean;
    c: boolean;
    cpp: boolean;
    java: boolean;
  };
  toolchains: {
    python: boolean;
    node: boolean;
    'ts-node': boolean;
    gcc: boolean;
    'g++': boolean;
    jdk: boolean;
  };
  languageServers: {
    python: boolean;
    typescript: boolean;
  };
  debugger: {
    python: boolean;
    node: boolean;
  };
}

export async function getSystemCapabilitiesAsync(): Promise<Capabilities> {
  const docker = await isDockerRunningAsync();
  const runner = docker ? await isRunnerImageAvailableAsync() : false;
  const hasToolchains = docker && runner;

  return {
    docker,
    runnerImage: runner,
    languages: {
      python: hasToolchains,
      node: hasToolchains,
      typescript: hasToolchains,
      c: hasToolchains,
      cpp: hasToolchains,
      java: hasToolchains
    },
    toolchains: {
      python: hasToolchains,
      node: hasToolchains,
      'ts-node': hasToolchains,
      gcc: hasToolchains,
      'g++': hasToolchains,
      jdk: hasToolchains
    },
    languageServers: {
      python: hasToolchains,
      typescript: hasToolchains,
    },
    debugger: {
      python: hasToolchains,
      node: hasToolchains,
    },
  };
}

export function getSystemCapabilities(): Capabilities {
  const docker = isDockerRunning();
  const runner = isRunnerImageAvailable();
  const hasToolchains = docker && runner;

  return {
    docker,
    runnerImage: runner,
    languages: {
      python: hasToolchains,
      node: hasToolchains,
      typescript: hasToolchains,
      c: hasToolchains,
      cpp: hasToolchains,
      java: hasToolchains
    },
    toolchains: {
      python: hasToolchains,
      node: hasToolchains,
      'ts-node': hasToolchains,
      gcc: hasToolchains,
      'g++': hasToolchains,
      jdk: hasToolchains
    },
    languageServers: {
      python: hasToolchains,
      typescript: hasToolchains,
    },
    debugger: {
      python: hasToolchains,
      node: hasToolchains,
    },
  };
}
