import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "../src/App.tsx"), "utf-8");
const hook = readFileSync(
  join(here, "../src/hooks/useTerminalSession.tsx"),
  "utf-8",
);

describe("M86 — terminal resume wiring", () => {
  it("logout clears every same-tab terminal resume hint", () => {
    expect(app).toContain(
      'import { clearAllTerminalResumes } from \'./utils/terminalResume\'',
    );
    expect(app).toContain("clearAllTerminalResumes()");
  });

  it("a remount sends resume=1 only when the id was restored", () => {
    expect(hook).toContain("if (resumeRef.current) extra.resume = 1");
    expect(hook).toContain("readTerminalResume(userId, projectId)");
  });
});
