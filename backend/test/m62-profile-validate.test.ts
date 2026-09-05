import { describe, it, expect } from "vitest";
import { validateProfilePatch } from "../src/profile/validate.js";
import { ApiError } from "../src/errors.js";

const c = (n: number) => String.fromCharCode(n);

function code(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof ApiError ? e.code : "NOT_API_ERROR";
  }
}

describe("M62-2 validateProfilePatch — allowlist", () => {
  it("rejects any unknown key with invalid_profile_key", () => {
    for (const body of [
      { nickname: "x" },
      { displayName: "ok", role: "admin" },
      { userId: 9 },
      { username: "root" },
      { version: 5 },
      { avatarMediaId: "m1" },
      { location: "NYC" },
      { profile_visibility: "public" },
      { bio: "ok", banner_kind: "image" },
    ]) {
      expect(code(() => validateProfilePatch(body)), JSON.stringify(body)).toBe(
        "invalid_profile_key",
      );
    }
  });

  it("rejects a non-object body", () => {
    expect(code(() => validateProfilePatch(null))).toBe("invalid_profile_body");
    expect(code(() => validateProfilePatch([]))).toBe("invalid_profile_body");
    expect(code(() => validateProfilePatch("x"))).toBe("invalid_profile_body");
  });

  it("accepts an empty patch and partial patches", () => {
    expect(validateProfilePatch({})).toEqual({});
    expect(validateProfilePatch({ displayName: "A" })).toEqual({
      displayName: "A",
    });
    expect(validateProfilePatch({ pronouns: "she/her", bio: "hi" })).toEqual({
      pronouns: "she/her",
      bio: "hi",
    });
  });
});

describe("M62-2 validateProfilePatch — displayName", () => {
  it("strips ALL C0 + DEL then collapses whitespace then trims", () => {
    expect(validateProfilePatch({ displayName: `a${c(0)}b` }).displayName).toBe(
      "ab",
    );
    expect(validateProfilePatch({ displayName: `a${c(10)}b` }).displayName).toBe(
      "ab",
    );
    expect(validateProfilePatch({ displayName: `a${c(9)}b` }).displayName).toBe(
      "ab",
    );
    expect(validateProfilePatch({ displayName: `a${c(11)}b` }).displayName).toBe(
      "ab",
    );
    expect(
      validateProfilePatch({ displayName: "  Ada   L.  " }).displayName,
    ).toBe("Ada L.");
  });

  it("null clears; whitespace/control-only is invalid", () => {
    expect(validateProfilePatch({ displayName: null }).displayName).toBeNull();
    expect(code(() => validateProfilePatch({ displayName: "   " }))).toBe(
      "invalid_display_name",
    );
    expect(
      code(() => validateProfilePatch({ displayName: `${c(0)}${c(9)}` })),
    ).toBe("invalid_display_name");
    expect(code(() => validateProfilePatch({ displayName: 5 }))).toBe(
      "invalid_display_name",
    );
  });

  it("48-char boundary: 48 ok, 49 rejected", () => {
    expect(
      validateProfilePatch({ displayName: "x".repeat(48) }).displayName!.length,
    ).toBe(48);
    expect(code(() => validateProfilePatch({ displayName: "x".repeat(49) }))).toBe(
      "invalid_display_name",
    );
  });
});

describe("M62-2 validateProfilePatch — pronouns", () => {
  it("single-line normalized; empty/blank -> null (one cleared state)", () => {
    expect(validateProfilePatch({ pronouns: null }).pronouns).toBeNull();
    expect(validateProfilePatch({ pronouns: "   " }).pronouns).toBeNull();
    expect(validateProfilePatch({ pronouns: "" }).pronouns).toBeNull();
    expect(
      validateProfilePatch({ pronouns: `she${c(10)}/${c(9)}her` }).pronouns,
    ).toBe("she/her");
  });

  it("24-char boundary: 24 ok, 25 rejected", () => {
    expect(
      validateProfilePatch({ pronouns: "p".repeat(24) }).pronouns!.length,
    ).toBe(24);
    expect(code(() => validateProfilePatch({ pronouns: "p".repeat(25) }))).toBe(
      "invalid_pronouns",
    );
  });
});

describe("M62-2 validateProfilePatch — bio (separate multi-line rule)", () => {
  it("keeps newline and tab, strips other C0/DEL", () => {
    const out = validateProfilePatch({
      bio: `line one\n\tindented${c(0)}${c(7)}\nline two`,
    }).bio;
    expect(out).toBe("line one\n\tindented\nline two");
  });

  it("preserves a single blank line, collapses 3+ newlines to 2", () => {
    expect(validateProfilePatch({ bio: "a\n\nb" }).bio).toBe("a\n\nb");
    expect(validateProfilePatch({ bio: "a\n\n\n\n\nb" }).bio).toBe("a\n\nb");
  });

  it("trims; blank/null -> null", () => {
    expect(validateProfilePatch({ bio: "  \n  " }).bio).toBeNull();
    expect(validateProfilePatch({ bio: null }).bio).toBeNull();
    expect(validateProfilePatch({ bio: "  hi  " }).bio).toBe("hi");
  });

  it("280-char boundary: 280 ok, 281 rejected", () => {
    expect(validateProfilePatch({ bio: "b".repeat(280) }).bio!.length).toBe(280);
    expect(code(() => validateProfilePatch({ bio: "b".repeat(281) }))).toBe(
      "invalid_bio",
    );
  });
});
