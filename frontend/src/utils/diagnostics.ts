/**
 * Normalized Diagnostic and Problem model with language-specific compiler & runtime parsers.
 */

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  id: string;
  severity: DiagnosticSeverity;
  message: string;
  filePath: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  source: string;
  code?: string;
  raw?: string;
}

export interface FileDiagnosticsGroup {
  filePath: string;
  diagnostics: Diagnostic[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
}

/**
 * Parses raw compiler or runtime output into normalized structured diagnostics.
 */
export function parseDiagnostics(
  output: string,
  fallbackLanguage?: string,
  activeFilePath?: string
): Diagnostic[] {
  if (!output || !output.trim()) return [];

  const diagnostics: Diagnostic[] = [];
  const lines = output.split(/\r?\n/);
  let idCounter = 0;

  // 1. GCC / Clang (C / C++) Parser: file.c:line:col: error/warning: message
  const gccRegex = /^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.+)$/i;

  // 2. TypeScript (tsc) Parser: file.ts(line,col): error TSXXXX: message
  const tsRegex = /^(.+?)\((\d+),(\d+)\):\s*(error|warning|info)\s+(TS\d+):\s*(.+)$/i;

  // 3. Java (javac) Parser: File.java:line: error/warning: message
  const javacRegex = /^(.+?\.java):(\d+):\s*(error|warning):\s*(.+)$/i;

  // 4. Python Traceback & SyntaxError Parsers
  const pyFileRegex = /^\s*File\s+"(.+?)",\s+line\s+(\d+)(?:,\s+in\s+(.+))?/i;
  const pyErrorNameRegex = /^([a-zA-Z0-9_]+Error|[a-zA-Z0-9_]+Exception):\s*(.+)$/;

  // 5. Node.js Stack Trace Parser: at ... (file.js:line:col)
  const nodeStackRegex = /^\s*at\s+(?:(.+?)\s+\()?(?:file:\/\/\/?)?(.+?):(\d+):(\d+)\)?$/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Check GCC / Clang
    const gccMatch = line.match(gccRegex);
    if (gccMatch) {
      const filePath = cleanFilePath(gccMatch[1]);
      const lineNum = parseInt(gccMatch[2], 10);
      const colNum = gccMatch[3] ? parseInt(gccMatch[3], 10) : 1;
      const typeStr = gccMatch[4].toLowerCase();
      const severity: DiagnosticSeverity = typeStr.includes('error') ? 'error' : typeStr.includes('warning') ? 'warning' : 'info';
      const message = gccMatch[5].trim();

      diagnostics.push({
        id: `diag-gcc-${++idCounter}`,
        severity,
        message,
        filePath,
        line: lineNum,
        column: colNum,
        source: 'gcc',
        raw: line,
      });
      continue;
    }

    // Check TypeScript
    const tsMatch = line.match(tsRegex);
    if (tsMatch) {
      const filePath = cleanFilePath(tsMatch[1]);
      const lineNum = parseInt(tsMatch[2], 10);
      const colNum = parseInt(tsMatch[3], 10);
      const typeStr = tsMatch[4].toLowerCase();
      const severity: DiagnosticSeverity = typeStr === 'error' ? 'error' : typeStr === 'warning' ? 'warning' : 'info';
      const code = tsMatch[5];
      const message = tsMatch[6].trim();

      diagnostics.push({
        id: `diag-ts-${++idCounter}`,
        severity,
        message,
        filePath,
        line: lineNum,
        column: colNum,
        source: 'tsc',
        code,
        raw: line,
      });
      continue;
    }

    // Check Java
    const javacMatch = line.match(javacRegex);
    if (javacMatch) {
      const filePath = cleanFilePath(javacMatch[1]);
      const lineNum = parseInt(javacMatch[2], 10);
      const severity: DiagnosticSeverity = javacMatch[3].toLowerCase() === 'error' ? 'error' : 'warning';
      const message = javacMatch[4].trim();

      diagnostics.push({
        id: `diag-java-${++idCounter}`,
        severity,
        message,
        filePath,
        line: lineNum,
        column: 1,
        source: 'javac',
        raw: line,
      });
      continue;
    }

    // Check Python File line
    const pyFileMatch = line.match(pyFileRegex);
    if (pyFileMatch) {
      const pyFilePath = cleanFilePath(pyFileMatch[1]);
      const pyLine = parseInt(pyFileMatch[2], 10);

      // Look ahead for error message
      let pyMessage = 'Runtime Error';
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
        const nextLine = lines[j].trim();
        const errMatch = nextLine.match(pyErrorNameRegex);
        if (errMatch) {
          pyMessage = nextLine;
          break;
        }
      }

      diagnostics.push({
        id: `diag-py-${++idCounter}`,
        severity: 'error',
        message: pyMessage,
        filePath: pyFilePath,
        line: pyLine,
        column: 1,
        source: 'python',
        raw: line,
      });
      continue;
    }

    // Check Node.js stack trace
    const nodeMatch = line.match(nodeStackRegex);
    if (nodeMatch) {
      const filePath = cleanFilePath(nodeMatch[2]);
      const lineNum = parseInt(nodeMatch[3], 10);
      const colNum = parseInt(nodeMatch[4], 10);

      // Find leading error message if at start of stack trace
      let errorMsg = 'JavaScript Runtime Exception';
      for (let k = i - 1; k >= Math.max(0, i - 4); k--) {
        const prevLine = lines[k].trim();
        if (prevLine.includes('Error:') || prevLine.includes('Exception:')) {
          errorMsg = prevLine;
          break;
        }
      }

      diagnostics.push({
        id: `diag-node-${++idCounter}`,
        severity: 'error',
        message: errorMsg,
        filePath,
        line: lineNum,
        column: colNum,
        source: 'node',
        raw: line,
      });
      continue;
    }
  }

  // Deduplicate diagnostics on filePath + line + message
  const uniqueDiagnostics: Diagnostic[] = [];
  const seenKeys = new Set<string>();

  for (const d of diagnostics) {
    const key = `${d.filePath}:${d.line}:${d.message}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      uniqueDiagnostics.push(d);
    }
  }

  return uniqueDiagnostics;
}

/**
 * Cleans path prefixes (e.g. /workspace/, ./, leading slashes).
 */
function cleanFilePath(p: string): string {
  let cleaned = p.replace(/\\/g, '/').trim();
  cleaned = cleaned.replace(/^\/workspace\//, '');
  cleaned = cleaned.replace(/^\.\//, '');
  return cleaned;
}

/**
 * Groups diagnostics by file for structured tree rendering in the Problems panel.
 */
export function groupDiagnosticsByFile(diagnostics: Diagnostic[]): FileDiagnosticsGroup[] {
  const groupsMap = new Map<string, Diagnostic[]>();

  for (const d of diagnostics) {
    const list = groupsMap.get(d.filePath) || [];
    list.push(d);
    groupsMap.set(d.filePath, list);
  }

  return Array.from(groupsMap.entries()).map(([filePath, items]) => {
    let errorCount = 0;
    let warningCount = 0;
    let infoCount = 0;

    for (const item of items) {
      if (item.severity === 'error') errorCount++;
      else if (item.severity === 'warning') warningCount++;
      else infoCount++;
    }

    return {
      filePath,
      diagnostics: items,
      errorCount,
      warningCount,
      infoCount,
    };
  });
}
