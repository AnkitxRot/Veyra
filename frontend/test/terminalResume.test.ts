import { describe, it, expect, beforeEach } from "vitest";
import {
  TERMINAL_RESUME_PREFIX,
  clearAllTerminalResumes,
  clearTerminalResume,
  isPersistableTerminalUser,
  readTerminalResume,
  terminalResumeKey,
  writeTerminalResume,
} from "../src/utils/terminalResume";

beforeEach(() => {
  sessionStorage.clear();
});

describe("M86 — terminal resume storage", () => {
  it("round-trips a well-formed terminalId keyed by user and project", () => {
    writeTerminalResume(7, "proj-a", "tid-abc_DEF-123");
    expect(readTerminalResume(7, "proj-a")).toBe("tid-abc_DEF-123");
    expect(readTerminalResume(7, "proj-b")).toBeNull();
    expect(readTerminalResume(8, "proj-a")).toBeNull();
  });

  it("rejects malformed ids and never writes them", () => {
    writeTerminalResume(7, "proj-a", "has.dot");
    writeTerminalResume(7, "proj-a", "has space");
    writeTerminalResume(7, "proj-a", "");
    writeTerminalResume(7, "proj-a", "x".repeat(129));
    expect(readTerminalResume(7, "proj-a")).toBeNull();
    expect(sessionStorage.getItem(terminalResumeKey(7, "proj-a"))).toBeNull();
  });

  it("ignores corrupt sessionStorage values on read", () => {
    sessionStorage.setItem(terminalResumeKey(7, "proj-a"), "not valid!");
    expect(readTerminalResume(7, "proj-a")).toBeNull();
  });

  it("does not persist for missing user or project", () => {
    expect(isPersistableTerminalUser(0)).toBe(false);
    expect(isPersistableTerminalUser(-1)).toBe(false);
    expect(isPersistableTerminalUser(1.5)).toBe(false);
    writeTerminalResume(0, "proj-a", "tid-ok");
    writeTerminalResume(7, "", "tid-ok");
    expect(sessionStorage.length).toBe(0);
  });

  it("clearTerminalResume is scoped to one user+project", () => {
    writeTerminalResume(7, "proj-a", "tid-a");
    writeTerminalResume(7, "proj-b", "tid-b");
    clearTerminalResume(7, "proj-a");
    expect(readTerminalResume(7, "proj-a")).toBeNull();
    expect(readTerminalResume(7, "proj-b")).toBe("tid-b");
  });

  it("clearAllTerminalResumes drops every cloudeee_terminal_ key", () => {
    writeTerminalResume(7, "proj-a", "tid-a");
    writeTerminalResume(9, "proj-z", "tid-z");
    sessionStorage.setItem("cloudeee_session_proj-a", '{"openTabs":[]}');
    clearAllTerminalResumes();
    expect(
      Object.keys(sessionStorage).filter((k) =>
        k.startsWith(TERMINAL_RESUME_PREFIX),
      ),
    ).toEqual([]);
    expect(sessionStorage.getItem("cloudeee_session_proj-a")).toBe(
      '{"openTabs":[]}',
    );
  });
});
