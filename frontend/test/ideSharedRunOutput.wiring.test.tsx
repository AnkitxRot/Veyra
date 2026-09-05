import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ide = readFileSync(
  join(here, "../src/components/IDE/IDE.tsx"),
  "utf-8",
);
const output = readFileSync(
  join(here, "../src/components/Output/Output.tsx"),
  "utf-8",
);
const client = readFileSync(join(here, "../src/collab/client.ts"), "utf-8");

/**
 * M65 — wiring guards. Rendering the ~3600-line IDE.tsx in unit tests is not
 * the house style; the moving parts are tested directly (collab.runOutput
 * .client.test.ts, SharedRunOutputPanel.test.tsx, the backend suites).
 */
describe("M65 — shared run output wiring", () => {
  it("IDE subscribes run_output_change and unsubscribes it", () => {
    expect(ide).toMatch(/client\.on\(\s*"run_output_change"/);
    expect(ide).toContain("unsubRunOutput = client.on(");
    expect(ide).toContain("unsubRunOutput?.();");
  });

  it("IDE clears shared output on both collab-teardown sites", () => {
    expect(ide.match(/setSharedRunOutputs\(\[\]\)/g) ?? []).toHaveLength(2);
    // in lockstep with the M54 run-status clear
    expect(ide.match(/setRunStatuses\(\[\]\)/g) ?? []).toHaveLength(2);
  });

  it("IDE feeds Output the shared output, run statuses, current user and link state", () => {
    const at = ide.indexOf("<Output");
    const jsx = ide.slice(at, at + 320);
    expect(jsx).toContain("sharedRunOutputs={sharedRunOutputs}");
    expect(jsx).toContain("runStatuses={runStatuses}");
    expect(jsx).toContain("currentUserId={user.id}");
    expect(jsx).toContain('collabConnected={collabStatus === "connected"}');
  });

  it("Output renders SharedRunOutputPanel only for OTHER users' runs", () => {
    expect(output).toContain(
      'import SharedRunOutputPanel from "./SharedRunOutputPanel"',
    );
    expect(output).toContain("status.userId !== currentUserId");
    expect(output).toContain("<SharedRunOutputPanel");
  });

  it("the client never sends a run_output frame (receive-only)", () => {
    // no encoder writes a run_output type; the only run_output references are
    // in the inbound MESSAGE_CUSTOM handler + teardown.
    expect(client).not.toMatch(/writeVarString\([^)]*"run_output"/);
    expect(client).not.toMatch(/type:\s*"run_output"/);
    expect(client).toContain('parsed.type === "run_output"');
  });
});
