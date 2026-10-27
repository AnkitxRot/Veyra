import { describe, it, expect } from "vitest";
import {
  decodeText, detectEncoding, detectEol, encodeText, inlineViewType, isBinary, TEXT_ENCODINGS,
} from "../src/files/encoding.js";

describe("encoding", () => {
  it("round-trips every encoding", () => {
    for (const enc of TEXT_ENCODINGS) {
      const text = enc === "latin1" ? "café\nx" : "héllo 世界\nx";
      const buf = encodeText(text, enc);
      expect(decodeText(buf, enc)).toBe(text);
    }
  });
  it("detects encodings", () => {
    expect(detectEncoding(Buffer.from("plain"))).toBe("utf-8");
    expect(detectEncoding(encodeText("a", "utf-8-bom"))).toBe("utf-8-bom");
    expect(detectEncoding(encodeText("a", "utf-16le"))).toBe("utf-16le");
    expect(detectEncoding(encodeText("a", "utf-16be"))).toBe("utf-16be");
    expect(detectEncoding(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe("latin1");
  });
  it("detects binary but not UTF-16 text", () => {
    expect(isBinary(Buffer.from([0x89, 0x50, 0x00, 0x01]))).toBe(true);
    expect(isBinary(encodeText("hi", "utf-16le"))).toBe(false);
    expect(isBinary(Buffer.from("text"))).toBe(false);
  });
  it("detects EOL", () => {
    expect(detectEol("a")).toBe("none");
    expect(detectEol("a\nb")).toBe("LF");
    expect(detectEol("a\r\nb\r\n")).toBe("CRLF");
    expect(detectEol("a\r\nb\n")).toBe("mixed");
  });
  it("maps inline view types", () => {
    expect(inlineViewType("a/b.PNG")).toBe("image/png");
    expect(inlineViewType("x.exe")).toBeNull();
  });
});
