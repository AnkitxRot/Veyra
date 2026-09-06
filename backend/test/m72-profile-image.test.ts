import { describe, it, expect } from "vitest";
import {
  validateImage,
  extForMime,
  type ImageLimits,
} from "../src/profile/image.js";
import { ApiError } from "../src/errors.js";
import { makePng, makeJpeg, makeWebp, makeSvg } from "./imageFixture.js";

const LIMITS: ImageLimits = {
  maxBytes: 512 * 1024,
  maxWidth: 1024,
  maxHeight: 1024,
  minDim: 32,
};

/** Assert the call throws an ApiError whose `code` matches. */
function expectReject(fn: () => unknown, code?: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    if (code) expect((err as ApiError).code).toBe(code);
    return;
  }
  throw new Error("expected validateImage to throw, it returned");
}

describe("M72 avatar image validation", () => {
  it("1. accepts a well-formed PNG and reports its real dimensions", () => {
    const out = validateImage(makePng(64, 48), LIMITS);
    expect(out).toMatchObject({ mime: "image/png", width: 64, height: 48 });
    expect(out.bytes).toBeGreaterThan(0);
  });

  it("2. accepts a well-formed JPEG", () => {
    const out = validateImage(makeJpeg(100, 100), LIMITS);
    expect(out).toMatchObject({ mime: "image/jpeg", width: 100, height: 100 });
  });

  it("3. accepts a well-formed WebP", () => {
    const out = validateImage(makeWebp(200, 120), LIMITS);
    expect(out).toMatchObject({ mime: "image/webp", width: 200, height: 120 });
  });

  it("4. ignores the declared MIME — PNG bytes sent as image/jpeg are PNG", () => {
    const out = validateImage(makePng(64, 64), LIMITS, "image/jpeg");
    expect(out.mime).toBe("image/png");
  });

  it("5. rejects an SVG document", () => {
    expectReject(() => validateImage(makeSvg(), LIMITS));
  });

  it("6. rejects an HTML document that starts with a tag", () => {
    const html = Buffer.from("<!DOCTYPE html><html><body>x</body></html>");
    expectReject(() => validateImage(html, LIMITS));
  });

  it("7. rejects leading-whitespace SVG (polyglot attempt)", () => {
    const buf = Buffer.concat([
      Buffer.from("   \n\t "),
      makeSvg(),
    ]);
    expectReject(() => validateImage(buf, LIMITS));
  });

  it("8. rejects an unknown/again-not-image byte stream", () => {
    expectReject(() => validateImage(Buffer.from("plain text, not an image"), LIMITS));
  });

  it("9. rejects an empty buffer", () => {
    expectReject(() => validateImage(Buffer.alloc(0), LIMITS), "empty_image");
  });

  it("10. rejects a truncated PNG (no IEND)", () => {
    const png = makePng(64, 64);
    expectReject(() => validateImage(png.subarray(0, 40), LIMITS));
  });

  it("11. rejects a truncated JPEG (no EOI)", () => {
    const jpg = makeJpeg(64, 64);
    expectReject(() => validateImage(jpg.subarray(0, jpg.length - 2), LIMITS));
  });

  it("12. rejects trailing garbage appended past the image end", () => {
    const png = makePng(64, 64);
    const withTrailer = Buffer.concat([png, Buffer.alloc(4096, 0x41)]);
    expectReject(() => validateImage(withTrailer, LIMITS), "invalid_image");
  });

  it("13. tolerates a few trailing bytes (encoder padding)", () => {
    const png = makePng(64, 64);
    const padded = Buffer.concat([png, Buffer.alloc(8)]);
    expect(validateImage(padded, LIMITS).mime).toBe("image/png");
  });

  it("14. rejects an image over the byte budget", () => {
    const big = makePng(700, 700);
    expectReject(
      () => validateImage(big, { ...LIMITS, maxBytes: 1024 }),
      "image_too_large",
    );
  });

  it("15. rejects an image below the minimum dimension", () => {
    expectReject(
      () => validateImage(makePng(16, 16), LIMITS),
      "invalid_image_dimensions",
    );
  });

  it("16. rejects an image above the maximum dimension", () => {
    expectReject(
      () => validateImage(makePng(64, 2048), LIMITS),
      "invalid_image_dimensions",
    );
  });

  it("17. rejects a non-buffer argument", () => {
    expectReject(() => validateImage("nope" as unknown as Buffer, LIMITS), "empty_image");
  });

  it("18. extForMime maps each accepted mime to a file extension", () => {
    expect(extForMime("image/png")).toBe("png");
    expect(extForMime("image/jpeg")).toBe("jpg");
    expect(extForMime("image/webp")).toBe("webp");
  });
});
