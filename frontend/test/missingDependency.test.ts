import { describe, it, expect } from "vitest";
import { detectMissingDependency } from "../src/utils/missingDependency";

describe("detectMissingDependency — Milestone 44 pure detector", () => {
  it("matches a Python ModuleNotFoundError and extracts the module name", () => {
    const output = [
      "Traceback (most recent call last):",
      '  File "main.py", line 1, in <module>',
      "    import requests",
      "ModuleNotFoundError: No module named 'requests'",
    ].join("\n");
    expect(detectMissingDependency(output)).toEqual({
      kind: "python",
      moduleName: "requests",
    });
  });

  it("matches a Node 'Cannot find module' error and extracts the module name", () => {
    const output = [
      "internal/modules/cjs/loader.js:888",
      "  throw err;",
      "  ^",
      "",
      "Error: Cannot find module 'express'",
      "    at Function.Module._resolveFilename (internal/modules/cjs/loader.js:885:15)",
    ].join("\n");
    expect(detectMissingDependency(output)).toEqual({
      kind: "node",
      moduleName: "express",
    });
  });

  it("does not match a generic Python runtime exception", () => {
    const output = [
      "Traceback (most recent call last):",
      '  File "main.py", line 1, in <module>',
      "    1 / 0",
      "ZeroDivisionError: division by zero",
    ].join("\n");
    expect(detectMissingDependency(output)).toBeNull();
  });

  it("does not match a generic ImportError that isn't ModuleNotFoundError", () => {
    const output =
      "ImportError: cannot import name 'missing_name' from 'existing_package'";
    expect(detectMissingDependency(output)).toBeNull();
  });

  it("does not match npm's own package-manager-level error output", () => {
    const output = [
      "npm ERR! code ENOENT",
      "npm ERR! syscall open",
      "npm ERR! path /workspace/package.json",
    ].join("\n");
    expect(detectMissingDependency(output)).toBeNull();
  });

  it("does not match a Node syntax error", () => {
    const output = "SyntaxError: Unexpected token '}'";
    expect(detectMissingDependency(output)).toBeNull();
  });

  it("returns null for empty output", () => {
    expect(detectMissingDependency("")).toBeNull();
  });

  it("returns a single match even if the module name appears twice", () => {
    const output = [
      "ModuleNotFoundError: No module named 'six'",
      "During handling of the above exception, another exception occurred:",
      "ModuleNotFoundError: No module named 'six'",
    ].join("\n");
    const result = detectMissingDependency(output);
    expect(result).toEqual({ kind: "python", moduleName: "six" });
  });

  it("prefers the Python pattern when (implausibly) both could match", () => {
    const output =
      "ModuleNotFoundError: No module named 'six'\nCannot find module 'lodash'";
    expect(detectMissingDependency(output)).toEqual({
      kind: "python",
      moduleName: "six",
    });
  });
});
