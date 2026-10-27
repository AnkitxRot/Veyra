import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestConfig, makeWorkspace } from "./helpers.js";
import { discoverWorkflow, parseCustomTasks } from "../src/workflow/discover.js";
import { resolveWorkflowTask } from "../src/workflow/resolve.js";

const put = (ws: string, v: unknown) => {
  mkdirSync(join(ws, ".veyra"), { recursive: true });
  writeFileSync(join(ws, ".veyra/tasks.json"), typeof v === "string" ? v : JSON.stringify(v));
};

describe(".veyra/tasks.json (M110)", () => {
  it("accepts allowlisted executables with strict args and no shell", () => {
    const t = parseCustomTasks({
      tasks: [
        { name: "lint", kind: "build", run: "npm", args: ["run", "lint"] },
        { name: "unit", kind: "test", run: "python3", args: ["-m", "pytest", "-q"] },
      ],
    });
    expect(t.map((x) => x.id)).toEqual(["custom:lint", "custom:unit"]);
    expect(t[0]).toMatchObject({ origin: "tasks.json", kind: "build", run: "npm" });
  });

  it("drops entries with disallowed executables, shell metacharacters, bad names or kinds", () => {
    const t = parseCustomTasks({
      tasks: [
        { name: "sh", kind: "build", run: "sh", args: ["-c", "id"] },
        { name: "inj", kind: "build", run: "npm", args: ["run", "x; id"] },
        { name: "sub", kind: "build", run: "npm", args: ["$(id)"] },
        { name: "bad name!", kind: "build", run: "npm", args: [] },
        { name: "kind", kind: "deploy", run: "npm", args: [] },
        { name: "dash", kind: "build", run: "npm", args: ["--prefix", "../x"] },
        { name: "ok", kind: "build", run: "make", args: ["all"] },
        { name: "ok", kind: "test", run: "make", args: ["check"] },
      ],
    });
    expect(t.map((x) => x.id)).toEqual(["custom:ok"]);
    expect(t[0]!.args).toEqual(["all"]);
  });

  it("caps count and tolerates junk", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `t${i}`, kind: "build", run: "make", args: [] }));
    expect(parseCustomTasks({ tasks: many }).length).toBe(20);
    expect(parseCustomTasks(null)).toEqual([]);
    expect(parseCustomTasks({ tasks: "x" })).toEqual([]);
  });

  it("is discovered from the workspace and resolves to the declared argv", async () => {
    const ws = makeWorkspace(makeTestConfig());
    put(ws, { tasks: [{ name: "lint", kind: "build", run: "npm", args: ["run", "lint"] }] });
    const m = await discoverWorkflow(ws);
    expect(m.tasks.some((x) => x.id === "custom:lint")).toBe(true);
    const r = await resolveWorkflowTask(ws, "custom:lint");
    expect(r.ok && r.value).toMatchObject({ command: "npm", args: ["run", "lint"], kind: "build" });
    expect((await resolveWorkflowTask(ws, "custom:nope")).ok).toBe(false);
  });

  it("ignores malformed or oversized tasks.json", async () => {
    const ws = makeWorkspace(makeTestConfig());
    put(ws, "{not json");
    expect((await discoverWorkflow(ws)).tasks.filter((x) => x.origin === "tasks.json")).toEqual([]);
    put(ws, " ".repeat(70_000) + "{}");
    expect((await discoverWorkflow(ws)).tasks.filter((x) => x.origin === "tasks.json")).toEqual([]);
  });
});
