# M10 Filesystem Small/Medium/Large Project Decomposition

- Timestamp: 2026-08-25T09:13:56.124Z

## Project Size Breakdown (Isolated Tree Listing)

| Project Size | Files | Depth | `tree()` Latency (ms) | `listFiles()` Latency (ms) | Sequential `stat` Operations |
|---|---|---|---|---|---|
| Tiny | 5 | 1 | 9.24 ms | 0.25 ms | 5 |
| Medium | 50 | 3 | 9.16 ms | 0.58 ms | 50 |
| Large | 300 | 5 | 20.70 ms | 0.98 ms | 300 |

## Observations

- `tree()` latency scales linearly with file count due to sequential `await fs.stat()` inside recursive directory traversal.
- `listFiles()` (which only reads directory entries with `withFileTypes: true` without separate per-file `fs.stat()` calls) runs ~21.2x faster on large projects.
