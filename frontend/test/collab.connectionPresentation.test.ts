import { describe, it, expect } from "vitest";
import {
  collaborationIsLive,
  rosterStalenessNote,
} from "../src/collab/connectionPresentation";
import type { CollabConnectionStatus } from "../src/collab/client";

const ALL: CollabConnectionStatus[] = [
  "connecting",
  "connected",
  "reconnecting",
  "resynchronizing",
  "disconnected",
  "forbidden",
];

describe("M73 — connection presentation helpers", () => {
  it("only 'connected' is a live roster", () => {
    for (const s of ALL) {
      expect(collaborationIsLive(s)).toBe(s === "connected");
    }
  });

  it("rosterStalenessNote is null only when connected, a string otherwise", () => {
    for (const s of ALL) {
      const note = rosterStalenessNote(s);
      if (s === "connected") expect(note).toBeNull();
      else expect(typeof note).toBe("string");
    }
  });

  it("the notes never claim data loss and mention the list may be out of date", () => {
    for (const s of ALL) {
      const note = rosterStalenessNote(s);
      if (!note) continue;
      expect(note).not.toMatch(/lost|gone|failed to save/i);
      expect(note).toMatch(/out of date|behind|no longer updating/i);
    }
  });
});
