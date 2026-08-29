import { writeProjectFile } from '../files/service.js';
import { getLang } from '../execution/languages.js';
import { resolveMainFile } from '../execution/detect.js';

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  language: string;
  /**
   * The file the IDE opens automatically after creating a project from this
   * template. It is always a directly-runnable entry point (for web starters,
   * the tiny server that serves the page) so the user's first action can be
   * Run. Must be one of `files[].path`.
   */
  entryFile: string;
  files: { path: string; content: string }[];
}

export const STARTER_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'python',
    name: 'Python',
    description: 'A minimal Python script with a function and deterministic output',
    language: 'python',
    entryFile: 'main.py',
    files: [
      {
        path: 'main.py',
        content: `def greet(name: str) -> str:
    return f"Hello, {name}!"


def main() -> None:
    print(greet("CloudIDE"))
    total = sum(range(1, 11))
    print(f"Sum of 1..10 = {total}")


if __name__ == "__main__":
    main()
`,
      },
    ],
  },
  {
    id: 'node',
    name: 'Node.js',
    description: 'A minimal Node.js script using only built-in JavaScript',
    language: 'node',
    entryFile: 'main.js',
    files: [
      {
        path: 'main.js',
        content: `function greet(name) {
  return \`Hello, \${name}!\`;
}

console.log(greet("CloudIDE"));

const total = [1, 2, 3, 4, 5].reduce((a, b) => a + b, 0);
console.log(\`Sum of 1..5 = \${total}\`);
`,
      },
    ],
  },
  {
    id: 'typescript',
    name: 'TypeScript',
    description: 'A minimal TypeScript program run directly with tsx — no build step',
    language: 'typescript',
    entryFile: 'main.ts',
    files: [
      {
        path: 'main.ts',
        content: `function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

const numbers: number[] = [2, 4, 6, 8];
const total = numbers.reduce((sum, n) => sum + n, 0);

console.log(greet("CloudIDE"));
console.log(\`Sum of \${numbers.join(" + ")} = \${total}\`);
`,
      },
    ],
  },
  {
    id: 'c',
    name: 'C',
    description: 'A minimal C program compiled with gcc (-O2 -Wall -Wextra)',
    language: 'c',
    entryFile: 'main.c',
    files: [
      {
        path: 'main.c',
        content: `#include <stdio.h>

static int add(int a, int b) {
    return a + b;
}

int main(void) {
    printf("Hello, CloudIDE!\\n");
    printf("2 + 3 = %d\\n", add(2, 3));
    return 0;
}
`,
      },
    ],
  },
  {
    id: 'cpp-systems',
    name: 'C++ Systems & Algorithms',
    description: 'High-performance modular C++17 project with GCC compiler',
    language: 'cpp',
    entryFile: 'main.cpp',
    files: [
      {
        path: 'main.cpp',
        content: `// C++17 High-Performance Modular Computation
#include <iostream>
#include <vector>
#include <numeric>
#include <algorithm>

int main() {
    std::cout << "====================================================\\n";
    std::cout << "⚡ C++17 MODULAR ALGORITHMS STARTER (GCC 12)\\n";
    std::cout << "====================================================\\n";

    std::vector<int> numbers = {42, 17, 99, 8, 23, 64, 5, 88};
    std::cout << "Original Vector: ";
    for (int n : numbers) std::cout << n << " ";
    std::cout << "\\n";

    std::sort(numbers.begin(), numbers.end());
    std::cout << "Sorted Vector:   ";
    for (int n : numbers) std::cout << n << " ";
    std::cout << "\\n";

    int sum = std::accumulate(numbers.begin(), numbers.end(), 0);
    std::cout << "Sum: " << sum << " | Average: " << (static_cast<double>(sum) / numbers.size()) << "\\n";
    std::cout << "====================================================\\n";
    return 0;
}
`,
      },
      {
        path: 'README.md',
        content: `# C++ Systems Starter

Demonstrates compiled C++17 code execution inside the Docker sandbox.
`,
      },
    ],
  },
  {
    id: 'java',
    name: 'Java',
    description: 'A minimal Java program — class Main, compiled with javac and run on the JDK',
    language: 'java',
    entryFile: 'Main.java',
    files: [
      {
        path: 'Main.java',
        content: `public class Main {
    static int square(int n) {
        return n * n;
    }

    public static void main(String[] args) {
        System.out.println("Hello, CloudIDE!");
        System.out.println("square(9) = " + square(9));
    }
}
`,
      },
    ],
  },
  {
    id: 'static-web',
    name: 'Static Web',
    description: 'An HTML/CSS page served on the Preview tab by a tiny zero-dependency server',
    language: 'node',
    entryFile: 'main.js',
    files: [
      {
        path: 'index.html',
        content: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CloudIDE Static Site</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <main>
      <h1>It works! 🎈</h1>
      <p>Edit <code>index.html</code> and <code>style.css</code>, then refresh the Preview tab.</p>
      <p id="clock"></p>
    </main>
    <script>
      const clock = document.getElementById("clock");
      setInterval(() => {
        clock.textContent = "Local time: " + new Date().toLocaleTimeString();
      }, 1000);
    </script>
  </body>
</html>
`,
      },
      {
        path: 'style.css',
        content: `:root { color-scheme: light dark; }

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  background: #0d1117;
  color: #e6edf3;
}

main { text-align: center; padding: 2rem; }
h1 { font-size: 2.5rem; margin: 0 0 0.5rem; }

code {
  background: rgba(255, 255, 255, 0.1);
  padding: 0.1em 0.35em;
  border-radius: 4px;
}
`,
      },
      {
        path: 'main.js',
        content: `// Minimal static file server for the CloudIDE Preview tab.
// You usually don't need to edit this — press Run, then open the Preview tab.
// Edit index.html / style.css to change the page.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8080;
const ROOT = __dirname;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\\/+/, "");
    const filePath = path.join(ROOT, rel);
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        return;
      }
      res.writeHead(200, {
        "content-type":
          TYPES[path.extname(filePath)] || "application/octet-stream",
      });
      res.end(data);
    });
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(\`Static site on http://0.0.0.0:\${PORT} — open the Preview tab\`);
  });
`,
      },
    ],
  },
  {
    id: 'python-data',
    name: 'Python Data Science',
    description: 'Data analysis and computational routines in pure Python',
    language: 'python',
    entryFile: 'main.py',
    files: [
      {
        path: 'main.py',
        content: `# Python Data Science & Statistical Analysis Starter
import csv
import math

def calculate_stats(numbers):
    if not numbers:
        return {}
    mean = sum(numbers) / len(numbers)
    variance = sum((x - mean) ** 2 for x in numbers) / len(numbers)
    std_dev = math.sqrt(variance)
    return {
        "count": len(numbers),
        "mean": round(mean, 2),
        "min": min(numbers),
        "max": max(numbers),
        "std_dev": round(std_dev, 2)
    }

print("=" * 55)
print("📊 CLOUDEEEIDE PYTHON DATA STARTER")
print("=" * 55)

# Process sample dataset
data = [12.5, 18.2, 24.8, 29.1, 15.6, 21.3, 33.7, 19.4, 27.5]
stats = calculate_stats(data)

print(f"Sample Observations: {data}")
print("Statistical Summary:")
for k, v in stats.items():
    print(f"  • {k.replace('_', ' ').capitalize()}: {v}")

print("=" * 55)
print("✅ Ready for scientific computation and virtual environments!")
`
      },
      {
        path: 'README.md',
        content: `# Python Data Science Starter

A pre-configured environment for data analysis in CloudeeeIDE.

## How to Run
1. Select \`main.py\` in the file tree.
2. Click **Run** or press **Ctrl+Enter**.
3. Results stream in real time.
`
      }
    ]
  },
  {
    id: 'node-web',
    name: 'Node.js Web Preview',
    description: 'HTTP server with responsive frontend for live web previewing',
    language: 'node',
    entryFile: 'server.js',
    files: [
      {
        path: 'server.js',
        content: `// Node.js Web Server for Sandboxed Preview
const http = require('http');
const PORT = 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(\`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <title>Cloud Preview App</title>
        <style>
          :root { --bg: #0d1117; --fg: #e6edf3; --accent: #58a6ff; }
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--fg); margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
          .card { background: rgba(22, 27, 34, 0.9); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 32px; max-width: 440px; text-align: center; box-shadow: 0 16px 40px rgba(0,0,0,0.5); }
          h1 { color: var(--accent); margin: 0 0 12px; font-size: 24px; }
          p { color: #8b949e; line-height: 1.6; font-size: 14px; margin: 0 0 20px; }
          .badge { background: rgba(88, 166, 255, 0.15); color: var(--accent); padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; display: inline-block; margin-bottom: 16px; }
          button { background: var(--accent); color: #0d1117; border: none; padding: 10px 20px; border-radius: 8px; font-weight: 600; cursor: pointer; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="badge">● LIVE SANDBOX BRIDGE</div>
          <h1>CloudeeeIDE Web Preview</h1>
          <p>This web application is running inside an isolated Docker container on port 3000 and reverse-proxied live into the IDE.</p>
          <button onclick="alert('Interactive JavaScript works inside iframe sandbox!')">Test Interaction</button>
        </div>
      </body>
    </html>
  \`);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(\`[Web Server] Listening on http://0.0.0.0:\${PORT} (Ready for Web Preview!)\`);
});
`
      },
      {
        path: 'README.md',
        content: `# Node.js Web Preview Starter

Run \`node server.js\` or start the server and click the **Web Preview** tab to view the live site.
`
      }
    ]
  }
];

// --- Deterministic catalog validation -------------------------------------
//
// Templates are trusted, application-defined content, but a malformed entry
// (a typo'd entry file, a language the run pipeline can't resolve, a path
// that escapes the workspace) would only surface as a broken new project.
// `validateTemplates` is a pure function the tests assert on, and
// `assertTemplatesValid()` runs once at module load so the server fails fast
// rather than shipping a broken starter.

export interface TemplateValidationIssue {
  templateId: string;
  problem: string;
}

const MAX_FILE_BYTES = 64 * 1024;
const MAX_TEMPLATE_BYTES = 128 * 1024;

function isUnsafePath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return true;
  if (p !== p.trim()) return true;
  if (p.startsWith('/') || p.startsWith('\\')) return true;
  if (/^[a-zA-Z]:/.test(p) || p.startsWith('\\\\')) return true;
  const segments = p.replace(/\\/g, '/').split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return true;
  if (segments[0] === '.git') return true;
  return false;
}

export function validateTemplates(
  templates: ProjectTemplate[] = STARTER_TEMPLATES,
): TemplateValidationIssue[] {
  const issues: TemplateValidationIssue[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();

  for (const t of templates) {
    const id = t.id || '(missing id)';
    const fail = (problem: string) => issues.push({ templateId: id, problem });

    if (!t.id || !/^[a-z0-9][a-z0-9-]*$/.test(t.id)) {
      fail('id must be lower-kebab-case');
    }
    if (seenIds.has(t.id)) fail('duplicate template id');
    seenIds.add(t.id);

    const nameKey = (t.name || '').trim().toLowerCase();
    if (!nameKey) fail('missing display name');
    if (seenNames.has(nameKey)) fail('duplicate display name');
    seenNames.add(nameKey);

    if (!t.description || !t.description.trim()) fail('missing description');

    const lang = getLang(t.language);
    if (!lang) fail(`unknown language: ${t.language}`);

    if (!Array.isArray(t.files) || t.files.length === 0) {
      fail('template has no files');
      continue;
    }

    const paths = new Set<string>();
    let totalBytes = 0;
    for (const f of t.files) {
      if (isUnsafePath(f.path)) {
        fail(`unsafe or malformed file path: ${JSON.stringify(f.path)}`);
        continue;
      }
      if (paths.has(f.path)) fail(`duplicate file path: ${f.path}`);
      paths.add(f.path);
      if (typeof f.content !== 'string') {
        fail(`file content must be a string: ${f.path}`);
        continue;
      }
      const bytes = Buffer.byteLength(f.content, 'utf8');
      totalBytes += bytes;
      if (bytes > MAX_FILE_BYTES) fail(`file exceeds ${MAX_FILE_BYTES} bytes: ${f.path}`);
    }
    if (totalBytes > MAX_TEMPLATE_BYTES) {
      fail(`template payload exceeds ${MAX_TEMPLATE_BYTES} bytes`);
    }

    if (!t.entryFile || !paths.has(t.entryFile)) {
      fail(`entryFile is not one of the template files: ${JSON.stringify(t.entryFile)}`);
    }

    // The real run pipeline must be able to resolve a main file for every
    // runnable starter, using the exact detector `runProject()` uses.
    if (lang && lang.run) {
      const resolved = resolveMainFile(lang, [...paths], null);
      if (!resolved) {
        fail(`run pipeline cannot resolve a ${t.language} entry file from ${[...paths].join(', ')}`);
      }
    }
  }

  return issues;
}

export function assertTemplatesValid(): void {
  const issues = validateTemplates();
  if (issues.length > 0) {
    throw new Error(
      'Invalid STARTER_TEMPLATES:\n' +
        issues.map((i) => `  - [${i.templateId}] ${i.problem}`).join('\n'),
    );
  }
}

assertTemplatesValid();

export async function applyTemplate(targetDir: string, templateId: string): Promise<void> {
  const tpl = STARTER_TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) throw new Error(`Template not found: ${templateId}`);

  for (const f of tpl.files) {
    // Reuse the workspace path-containment + tree-cache machinery rather than
    // a second raw-fs write path.
    await writeProjectFile(targetDir, f.path, f.content);
  }
}
