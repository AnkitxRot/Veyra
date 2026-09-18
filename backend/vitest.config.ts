import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Test files share one Docker daemon (labeled containers + networks).
    // Parallel files would let one file's cleanup/reconciliation destroy
    // another file's sandboxes mid-test.
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
    server: {
      deps: {
        external: [/^node:/, "playwright"],
      },
    },
  },
});
