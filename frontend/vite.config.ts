import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Ensure Vite can resolve monaco-editor from the hoisted root node_modules
      "monaco-editor": path.resolve(__dirname, "../node_modules/monaco-editor"),
    },
  },
  optimizeDeps: {
    // monaco-editor is aliased to an absolute path outside frontend/node_modules
    // (npm workspace hoisting), and monacoSetup.ts imports its worker entry
    // points with Vite's `?worker` suffix. Vite's esbuild dependency scanner
    // still tries to pre-bundle those `?worker` imports as regular deps before
    // its own worker plugin can claim them, producing broken optimizer chunk
    // names (literally containing "?worker" before the .js extension) that
    // 404/503 at runtime - "optimized info should be defined" and "the file
    // does not exist at .../deps/...worker.js". Excluding the package here
    // stops the scanner from touching it at all; monaco-editor ships native
    // ESM already, so the browser can import it directly without pre-bundling,
    // and the `?worker` plugin still builds each worker as its own entry.
    exclude: ["monaco-editor"],
  },
  server: {
    port: 5173,
    // Fail loudly if 5173 is already taken instead of silently serving on the
    // next free port. A stale dev server holding 5173 with no /api proxy
    // otherwise looks healthy while the browser keeps hitting the zombie.
    // Run a second instance with `npm run dev -- --port <n>`.
    strictPort: true,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "/ws": { target: "ws://localhost:3000", ws: true, changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "/ws": { target: "ws://localhost:3000", ws: true, changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const p = id.replace(/\\/g, "/");
          if (p.includes("?worker")) return;
          if (!p.includes("/node_modules/")) return;
          if (p.includes("/node_modules/monaco-editor/")) return "monaco";
          if (/\/node_modules\/(yjs|y-monaco|y-protocols|lib0)\//.test(p))
            return "collab";
          if (/\/node_modules\/@xterm\//.test(p)) return "xterm";
          return "vendor";
        },
      },
    },
  },
});
