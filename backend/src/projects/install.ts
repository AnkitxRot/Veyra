import { promises as fs, constants } from 'node:fs';
import { join } from 'node:path';

export interface InstallSpec {
  workspaceDir: string;
  language: string;
}

export interface InstallResult {
  cmd: string | null;
  args: string[];
  message: string;
}

const NODE_ARGS = ['install', '--ignore-scripts'];
const PYTHON_ARGS = ['install', '-r', 'requirements.txt'];

/**
 * Determine which dependency manager to run for a project.
 *
 * Priority:
 * 1. requirements.txt (Python)
 * 2. package.json (Node.js)
 * 3. language === 'node' | 'typescript' → npm
 * 4. language === 'python' → pip3
 * 5. null (no configuration)
 *
 * This function has no Docker or process side effects — it only inspects
 * the filesystem and the project's language field.
 */
export async function resolveInstallSpec(spec: InstallSpec): Promise<InstallResult> {
  let pkgExists = false;
  let reqExists = false;

  try {
    await fs.access(join(spec.workspaceDir, 'package.json'), constants.F_OK);
    pkgExists = true;
  } catch {
    /* not found */
  }

  try {
    await fs.access(join(spec.workspaceDir, 'requirements.txt'), constants.F_OK);
    reqExists = true;
  } catch {
    /* not found */
  }

  // 1. requirements.txt takes precedence
  if (reqExists) {
    return { cmd: 'pip3', args: PYTHON_ARGS, message: '' };
  }

  // 2. package.json → npm
  if (pkgExists) {
    return { cmd: 'npm', args: NODE_ARGS, message: '' };
  }

  // 3. Language field fallback
  if (spec.language === 'node' || spec.language === 'typescript') {
    return { cmd: 'npm', args: NODE_ARGS, message: '' };
  }

  if (spec.language === 'python') {
    return { cmd: 'pip3', args: PYTHON_ARGS, message: '' };
  }

  return { cmd: null, args: [], message: 'No dependency configuration found for this language' };
}
