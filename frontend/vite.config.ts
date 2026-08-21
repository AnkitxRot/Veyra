import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Ensure Vite can resolve monaco-editor from the hoisted root node_modules
      'monaco-editor': path.resolve(__dirname, '../node_modules/monaco-editor'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3000', ws: true, changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3000', ws: true, changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const p = id.replace(/\\/g, '/');
          if (p.includes('?worker')) return;
          if (!p.includes('/node_modules/')) return;
          if (p.includes('/node_modules/monaco-editor/')) return 'monaco';
          if (/\/node_modules\/(yjs|y-monaco|y-protocols|lib0)\//.test(p))
            return 'collab';
          if (/\/node_modules\/@xterm\//.test(p)) return 'xterm';
          return 'vendor';
        },
      },
    },
  },
});
