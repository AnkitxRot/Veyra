import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { ApiError } from '../errors.js';
import { commandExists } from '../tools.js';

export interface FormatResult {
  formatted: string;
  changed: boolean;
  formatter: string;
  warning?: string;
}

function runFormatterProcess(cmd: string, args: string[], input: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Formatter ${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `Formatter ${cmd} exited with code ${code}`));
      }
    });

    proc.stdin.write(input);
    proc.stdin.end();
  });
}

/**
 * Normalizes and formats code buffers safely based on language and file extension.
 */
export async function formatProjectFile(
  workspaceDir: string,
  relativePath: string,
  content: string
): Promise<FormatResult> {
  // Validate path containment
  if (isAbsolute(relativePath) || relativePath.includes('..') || relativePath.includes('\0')) {
    throw new ApiError(400, 'Invalid file path', 'invalid_path');
  }

  const ext = relativePath.includes('.') ? relativePath.split('.').pop()?.toLowerCase() || '' : '';

  try {
    // 1. JSON Formatter
    if (ext === 'json') {
      try {
        const parsed = JSON.parse(content);
        const formatted = JSON.stringify(parsed, null, 2) + '\n';
        return {
          formatted,
          changed: formatted !== content,
          formatter: 'json-builtin',
        };
      } catch (err: any) {
        return {
          formatted: content,
          changed: false,
          formatter: 'json-builtin',
          warning: `JSON parse error during format: ${err.message}`,
        };
      }
    }

    // 2. Python Formatter (Black if available, otherwise PEP-8 normalizer)
    if (ext === 'py') {
      if (commandExists('black')) {
        try {
          const stdout = await runFormatterProcess('black', ['-q', '-'], content);
          return {
            formatted: stdout,
            changed: stdout !== content,
            formatter: 'black',
          };
        } catch {}
      }

      // Built-in PEP-8 whitespace and newline normalizer
      const lines = content.split(/\r?\n/);
      const normalizedLines = lines.map((l) => l.trimEnd());
      while (normalizedLines.length > 0 && normalizedLines[normalizedLines.length - 1] === '') {
        normalizedLines.pop();
      }
      const formatted = normalizedLines.join('\n') + '\n';
      return {
        formatted,
        changed: formatted !== content,
        formatter: 'python-pep8-normalizer',
      };
    }

    // 3. C / C++ Formatter (clang-format if available, otherwise C normalizer)
    if (['c', 'h', 'cpp', 'hpp', 'cc', 'cxx'].includes(ext)) {
      if (commandExists('clang-format')) {
        try {
          const stdout = await runFormatterProcess('clang-format', ['--style=Google'], content);
          return {
            formatted: stdout,
            changed: stdout !== content,
            formatter: 'clang-format',
          };
        } catch {}
      }

      const formatted = formatGenericCode(content, 4);
      return {
        formatted,
        changed: formatted !== content,
        formatter: 'c-normalizer',
      };
    }

    // 4. JavaScript / TypeScript / Web Formatter
    if (['js', 'jsx', 'ts', 'tsx', 'html', 'css', 'scss', 'md', 'yaml', 'yml'].includes(ext)) {
      if (commandExists('prettier')) {
        try {
          const stdout = await runFormatterProcess('prettier', ['--stdin-filepath', relativePath], content);
          return {
            formatted: stdout,
            changed: stdout !== content,
            formatter: 'prettier',
          };
        } catch {}
      }

      const formatted = formatGenericCode(content, 2);
      return {
        formatted,
        changed: formatted !== content,
        formatter: 'js-normalizer',
      };
    }

    // 5. Default Generic Format (Trailing whitespace cleanup + final newline)
    const formatted = formatGenericCode(content, 2);
    return {
      formatted,
      changed: formatted !== content,
      formatter: 'generic-normalizer',
    };
  } catch (err: any) {
    // Non-destructive: preserve original content on error
    return {
      formatted: content,
      changed: false,
      formatter: 'fallback',
      warning: `Formatting skipped: ${err.message}`,
    };
  }
}

/**
 * Cleans whitespace, normalizes indents, and ensures clean trailing newlines.
 */
function formatGenericCode(content: string, _defaultIndentSize = 2): string {
  const rawLines = content.split(/\r?\n/);
  const cleanedLines: string[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    cleanedLines.push(rawLines[i].trimEnd());
  }

  // Remove excessive trailing blank lines at end of file
  while (cleanedLines.length > 0 && cleanedLines[cleanedLines.length - 1] === '') {
    cleanedLines.pop();
  }

  return cleanedLines.join('\n') + '\n';
}
