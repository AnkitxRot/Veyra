import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  language: string;
  files: { path: string; content: string }[];
}

export const STARTER_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'python-data',
    name: 'Python Data Science',
    description: 'Data analysis and computational routines in pure Python',
    language: 'python',
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
    id: 'cpp-systems',
    name: 'C++ Systems & Algorithms',
    description: 'High-performance modular C++17 project with GCC compiler',
    language: 'cpp',
    files: [
      {
        path: 'main.cpp',
        content: `// C++17 High-Performance Modular Computation
#include <iostream>
#include <vector>
#include <numeric>
#include <algorithm>

int main() {
    std::cout << "====================================================\n";
    std::cout << "⚡ C++17 MODULAR ALGORITHMS STARTER (GCC 12)\n";
    std::cout << "====================================================\n";

    std::vector<int> numbers = {42, 17, 99, 8, 23, 64, 5, 88};
    std::cout << "Original Vector: ";
    for (int n : numbers) std::cout << n << " ";
    std::cout << "\n";

    std::sort(numbers.begin(), numbers.end());
    std::cout << "Sorted Vector:   ";
    for (int n : numbers) std::cout << n << " ";
    std::cout << "\n";

    int sum = std::accumulate(numbers.begin(), numbers.end(), 0);
    std::cout << "Sum: " << sum << " | Average: " << (static_cast<double>(sum) / numbers.size()) << "\n";
    std::cout << "====================================================\n";
    return 0;
}
`
      },
      {
        path: 'README.md',
        content: `# C++ Systems Starter

Demonstrates compiled C++17 code execution inside the Docker sandbox.
`
      }
    ]
  },
  {
    id: 'node-web',
    name: 'Node.js Web Preview',
    description: 'HTTP server with responsive frontend for live web previewing',
    language: 'node',
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

export async function applyTemplate(targetDir: string, templateId: string): Promise<void> {
  const tpl = STARTER_TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) throw new Error(`Template not found: ${templateId}`);

  for (const f of tpl.files) {
    const fullPath = join(targetDir, f.path);
    await fs.mkdir(join(targetDir), { recursive: true });
    await fs.writeFile(fullPath, f.content, 'utf8');
  }
}
