import { describe, it, expect } from "vitest";
import {
  effectiveDisplayName,
  sanitizeStoredDisplayName,
  sanitizeStoredPronouns,
  normalizeSingleLineIdentity,
} from "../src/profile/identity.js";

const c = (n: number) => String.fromCharCode(n);

describe("M62-3 normalizeSingleLineIdentity", () => {
  it("strips every C0 control char and DEL (newline and tab included)", () => {
    expect(normalizeSingleLineIdentity(`a${c(0)}b`)).toBe("ab");
    expect(normalizeSingleLineIdentity(`a${c(7)}b`)).toBe("ab");
    expect(normalizeSingleLineIdentity(`a${c(11)}b`)).toBe("ab"); // vertical tab
    expect(normalizeSingleLineIdentity(`a${c(10)}b`)).toBe("ab"); // \n
    expect(normalizeSingleLineIdentity(`a${c(9)}b`)).toBe("ab"); // \t
    expect(normalizeSingleLineIdentity(`a${c(13)}b`)).toBe("ab"); // \r
    expect(normalizeSingleLineIdentity(`a${c(127)}b`)).toBe("ab"); // DEL
  });

  it("collapses internal whitespace runs and trims", () => {
    expect(normalizeSingleLineIdentity("  Ada   L.  ")).toBe("Ada L.");
    expect(normalizeSingleLineIdentity("one\t\t two")).toBe("one two");
  });

  it("returns empty string when nothing survives", () => {
    expect(normalizeSingleLineIdentity("   ")).toBe("");
    expect(normalizeSingleLineIdentity(`${c(0)}${c(9)}${c(10)}`)).toBe("");
  });
});

describe("M62-3 sanitizeStoredDisplayName", () => {
  it("null for non-string / empty / whitespace-only / all-control", () => {
    expect(sanitizeStoredDisplayName(null)).toBeNull();
    expect(sanitizeStoredDisplayName(undefined)).toBeNull();
    expect(sanitizeStoredDisplayName("")).toBeNull();
    expect(sanitizeStoredDisplayName("   ")).toBeNull();
    expect(sanitizeStoredDisplayName(`${c(1)}${c(2)}`)).toBeNull();
    expect(sanitizeStoredDisplayName(123 as unknown as string)).toBeNull();
  });

  it("sanitizes a loose stored value", () => {
    expect(sanitizeStoredDisplayName(`  Ada${c(0)} Lovelace  `)).toBe(
      "Ada Lovelace",
    );
  });

  it("hard-caps length at 48", () => {
    const long = "x".repeat(80);
    expect(sanitizeStoredDisplayName(long)!.length).toBe(48);
  });
});

describe("M73 sanitizeStoredPronouns", () => {
  it("null for non-string / empty / whitespace-only / all-control", () => {
    expect(sanitizeStoredPronouns(null)).toBeNull();
    expect(sanitizeStoredPronouns(undefined)).toBeNull();
    expect(sanitizeStoredPronouns("")).toBeNull();
    expect(sanitizeStoredPronouns("   ")).toBeNull();
    expect(sanitizeStoredPronouns(`${c(1)}${c(9)}`)).toBeNull();
    expect(sanitizeStoredPronouns(42 as unknown as string)).toBeNull();
  });

  it("strips control chars, collapses whitespace, trims", () => {
    expect(sanitizeStoredPronouns("  she/her ")).toBe("she/her");
    expect(sanitizeStoredPronouns(`they${c(10)}/them`)).toBe("they/them");
  });

  it("hard-caps at 24 characters", () => {
    expect(sanitizeStoredPronouns("x".repeat(50))).toHaveLength(24);
  });
});

describe("M62-3 effectiveDisplayName resolver matrix", () => {
  it("null displayName -> username", () => {
    expect(effectiveDisplayName(null, "rahul")).toBe("rahul");
  });
  it("undefined displayName -> username", () => {
    expect(effectiveDisplayName(undefined, "rahul")).toBe("rahul");
  });
  it("empty displayName -> username", () => {
    expect(effectiveDisplayName("", "rahul")).toBe("rahul");
  });
  it("whitespace-only displayName -> username", () => {
    expect(effectiveDisplayName("    ", "rahul")).toBe("rahul");
  });
  it("all-control displayName -> username", () => {
    expect(effectiveDisplayName(`${c(0)}${c(7)}${c(127)}`, "rahul")).toBe(
      "rahul",
    );
  });
  it("valid displayName -> that displayName", () => {
    expect(effectiveDisplayName("Ada Lovelace", "rahul")).toBe("Ada Lovelace");
  });
  it("loose-but-nonempty displayName -> sanitized displayName", () => {
    expect(effectiveDisplayName(`  Ada${c(9)}L.  `, "rahul")).toBe("AdaL.");
  });
  it("never returns an unsanitized value", () => {
    const out = effectiveDisplayName(`Ad${c(0)}a`, "rahul");
    expect(out).not.toContain(c(0));
    expect(out).toBe("Ada");
  });
});
