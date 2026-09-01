import { describe, it, expect } from "vitest";
import {
  sanitizeCommentBody,
  parseMentionIds,
  isEmoji,
  isAnchorPayload,
  EMOJI_SET,
} from "../src/comments/validate.js";

describe("M61-A comment validation", () => {
  it("body: strips control chars, keeps newlines, rejects empty/oversize", () => {
    expect(sanitizeCommentBody("a\x00b")).toBe("ab");
    expect(sanitizeCommentBody("l1\nl2")).toBe("l1\nl2");
    expect(sanitizeCommentBody("   ")).toBeNull();
    expect(sanitizeCommentBody("x".repeat(4001))).toBeNull();
    expect(sanitizeCommentBody("a\n\n\n\n\nb")).toBe("a\n\nb");
    expect(sanitizeCommentBody(42)).toBeNull();
  });

  it("mentions: dedupe + cap 20; non-ints dropped", () => {
    expect(parseMentionIds([1, 1, 2, "3", 3.5, null])).toEqual([1, 2]);
    expect(
      parseMentionIds(Array.from({ length: 50 }, (_, i) => i + 1)).length,
    ).toBe(20);
    expect(parseMentionIds("nope")).toEqual([]);
  });

  it("emoji: exactly the fixed six", () => {
    expect(EMOJI_SET.size).toBe(6);
    expect(isEmoji("\u{1F44D}")).toBe(true);
    expect(isEmoji("\u{1F4A9}")).toBe(false);
    expect(isEmoji(5)).toBe(false);
  });

  it("anchor payload shape guard", () => {
    const ok = {
      relStart: "AA",
      relEnd: "BB",
      slice: "x",
      startLine: 1,
      endLine: 1,
      prefixHash: "0123456789abcdef",
    };
    expect(isAnchorPayload(ok)).toBe(true);
    expect(isAnchorPayload({ ...ok, prefixHash: "nope" })).toBe(false);
    expect(isAnchorPayload({ ...ok, relStart: "A".repeat(5000) })).toBe(false);
    expect(isAnchorPayload({ ...ok, slice: "x".repeat(300) })).toBe(false);
    expect(isAnchorPayload({ ...ok, startLine: -1 })).toBe(false);
    expect(isAnchorPayload(null)).toBe(false);
  });
});
