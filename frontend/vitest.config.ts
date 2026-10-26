import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    // The M71 perf baselines render large trees repeatedly and exceed 5s on CI-class hardware.
    testTimeout: 60000,
    // Pin the classic fake-timer surface; newer Vitest also fakes rAF/idle/performance, which
    // changes vi.getTimerCount() in the terminal reconnect assertions.
    fakeTimers: {
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "setImmediate",
        "clearImmediate",
        "Date",
      ],
    },
  },
});
