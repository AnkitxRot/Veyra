import { execSync } from 'node:child_process';
import { IS_WINDOWS } from './config.js';

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

export function isDockerRunning(): boolean {
  if (!commandExists('docker')) return false;
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function isRunnerImageAvailable(): boolean {
  if (!commandExists('docker')) return false;
  try {
    const result = execSync('docker image inspect cloudeeeide-runner:latest', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return result.includes('cloudeeeide-runner:latest');
  } catch {
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
}

export function getSystemCapabilities(): Capabilities {
  const docker = isDockerRunning();
  const runner = isRunnerImageAvailable();
  
  // If the runner image is present, we assume all required toolchains are baked into it.
  // If not, we report false for execution capabilities since the host shouldn't be used.
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
    }
  };
}
