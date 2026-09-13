import { normalizeRelPath } from "../lsp/uri.js";
import { fromWorkspaceLocation, isForbiddenRelPath } from "../debug/paths.js";

export type TestStatus = "passed" | "failed" | "skipped" | "error";

export interface TestCaseResult {
  name: string;
  suite?: string;
  file?: string;
  line?: number;
  status: TestStatus;
  durationMs?: number;
  message?: string;
}

const MAX_CASES = 200;
const MAX_NAME = 200;
const MAX_MESSAGE = 800;
const MAX_INPUT = 256 * 1024;

export function parseTestOutput(raw: string): TestCaseResult[] {
  const text = (raw ?? "").slice(0, MAX_INPUT);
  const out: TestCaseResult[] = [];
  out.push(...parsePytest(text));
  if (out.length === 0) out.push(...parseVitestJest(text));
  if (out.length === 0) out.push(...parseTap(text));
  return clipCases(out);
}

function clipCases(cases: TestCaseResult[]): TestCaseResult[] {
  return cases.slice(0, MAX_CASES).map((c) => ({
    ...c,
    name: clip(c.name, MAX_NAME),
    suite: c.suite ? clip(c.suite, MAX_NAME) : undefined,
    message: c.message ? clip(c.message, MAX_MESSAGE) : undefined,
    file: c.file ? mapFile(c.file) ?? undefined : undefined,
  }));
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function mapFile(value: string): string | null {
  const mapped = fromWorkspaceLocation(value) ?? normalizeRelPath(value.replace(/\\/g, "/"));
  if (!mapped || isForbiddenRelPath(mapped)) return null;
  return mapped;
}

function parsePytest(text: string): TestCaseResult[] {
  const out: TestCaseResult[] = [];
  const re =
    /^((?:[\w./\\-]+)\.py)(?::(\d+))?(?:::([\w[\].-]+))?\s+(PASSED|FAILED|SKIPPED|ERROR)\b/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({
      name: m[3] ?? m[1],
      file: m[1],
      line: m[2] ? Number(m[2]) : undefined,
      status: statusOf(m[4]),
    });
  }
  return out;
}

function parseVitestJest(text: string): TestCaseResult[] {
  const out: TestCaseResult[] = [];
  const lineRe =
    /^\s*(✓|✔|√|×|✕|✖|○|PASS|FAIL|SKIP)\s+(.+?)(?:\s+\((\d+(?:\.\d+)?)\s*m?s\))?\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(text))) {
    const mark = m[1];
    const name = m[2].trim();
    if (!name || name.startsWith("Tests ") || name.startsWith("Test Files")) continue;
    out.push({
      name,
      status:
        mark === "✓" || mark === "✔" || mark === "√" || mark === "PASS"
          ? "passed"
          : mark === "○" || mark === "SKIP"
            ? "skipped"
            : "failed",
      durationMs: m[3] ? Math.round(Number(m[3])) : undefined,
    });
  }
  const locRe =
    /(?:at |❯ |> )(?:[^\n(]*\()?(?:file:\/\/)?(?:\/workspace\/)?([\w./\\-]+\.[jt]sx?):(\d+)/g;
  let loc: RegExpExecArray | null;
  const files: { file: string; line: number }[] = [];
  while ((loc = locRe.exec(text))) {
    files.push({ file: loc[1], line: Number(loc[2]) });
  }
  if (files.length && out.length) {
    let i = 0;
    for (const c of out) {
      if (c.status === "failed" && files[i]) {
        c.file = files[i].file;
        c.line = files[i].line;
        i += 1;
      }
    }
  }
  return out;
}

function parseTap(text: string): TestCaseResult[] {
  const out: TestCaseResult[] = [];
  const re = /^(ok|not ok)\s+\d+\s+-?\s*(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = m[2].trim() || m[1];
    out.push({
      name,
      status: m[1] === "ok" ? "passed" : "failed",
    });
  }
  return out;
}

function statusOf(raw: string): TestStatus {
  switch (raw) {
    case "PASSED":
      return "passed";
    case "SKIPPED":
      return "skipped";
    case "ERROR":
      return "error";
    default:
      return "failed";
  }
}
