import { ApiError } from "../errors.js";

/**
 * M72 — magic-byte avatar image validation. No image decoder, no re-encode,
 * no third-party library. The caller's declared Content-Type is IGNORED;
 * only the bytes decide the format and the reported dimensions.
 *
 *   PNG   89 50 4E 47 0D 0A 1A 0A
 *   JPEG  FF D8 FF
 *   WebP  "RIFF" .... "WEBP"
 *
 * SVG, XML, HTML and every other type are a hard 400. Dimensions come from
 * the format header; a header that will not parse is rejected, and so is a
 * file carrying more than a few bytes of trailing data past its logical end
 * (a polyglot defence).
 */

export const AVATAR_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AvatarMime = (typeof AVATAR_MIMES)[number];

export interface ImageLimits {
  maxBytes: number;
  maxWidth: number;
  maxHeight: number;
  minDim: number;
}

export interface ValidatedImage {
  mime: AvatarMime;
  width: number;
  height: number;
  bytes: number;
}

/** Bytes tolerated after the logical end of the image (IEND / EOI / RIFF). */
const TRAILING_TOLERANCE = 16;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function reject(message: string, code = "invalid_image"): never {
  throw new ApiError(400, message, code);
}

function looksLikeHtmlOrSvg(buf: Buffer): boolean {
  const start = buf
    .subarray(0, 256)
    .toString("latin1")
    .trimStart()
    .toLowerCase();
  return (
    start.startsWith("<svg") ||
    start.startsWith("<?xml") ||
    start.startsWith("<!doctype") ||
    start.startsWith("<html") ||
    start.startsWith("<img") ||
    start.startsWith("<script")
  );
}

function readPng(buf: Buffer): { width: number; height: number; end: number } {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    reject("not a PNG image");
  }
  const chunkLen = buf.readUInt32BE(8);
  if (chunkLen !== 13) reject("invalid PNG IHDR");
  if (buf.subarray(12, 16).toString("ascii") !== "IHDR") {
    reject("invalid PNG IHDR");
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const iend = buf.lastIndexOf(PNG_IEND);
  if (iend === -1) reject("truncated PNG");
  return { width, height, end: iend + PNG_IEND.length };
}

function readJpeg(buf: Buffer): { width: number; height: number; end: number } {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
    reject("not a JPEG image");
  }
  let pos = 2;
  let width = 0;
  let height = 0;
  let sawSof = false;
  while (pos < buf.length - 1) {
    if (buf[pos] !== 0xff) break;
    while (pos < buf.length && buf[pos] === 0xff) pos++;
    if (pos >= buf.length) break;
    const marker = buf[pos]!;
    pos++;
    if (marker === 0xd9) break; // EOI before SOF — invalid
    if (marker === 0xd8) continue; // stray SOI
    if (marker === 0xda) break; // SOS — entropy-coded remainder follows
    if (pos + 2 > buf.length) reject("truncated JPEG");
    const seglen = buf.readUInt16BE(pos);
    if (seglen < 2 || pos + seglen > buf.length) reject("truncated JPEG");
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      if (seglen < 7) reject("invalid JPEG SOF");
      height = buf.readUInt16BE(pos + 3);
      width = buf.readUInt16BE(pos + 5);
      sawSof = true;
    }
    pos += seglen;
  }
  if (!sawSof || width === 0 || height === 0) {
    reject("unparseable JPEG dimensions");
  }
  const eoi = buf.lastIndexOf(Buffer.from([0xff, 0xd9]));
  if (eoi === -1) reject("truncated JPEG");
  return { width, height, end: eoi + 2 };
}

function readWebp(buf: Buffer): { width: number; height: number; end: number } {
  if (
    buf.length < 20 ||
    buf.subarray(0, 4).toString("ascii") !== "RIFF" ||
    buf.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    reject("not a WebP image");
  }
  const riffSize = buf.readUInt32LE(4);
  const end = 8 + riffSize;
  if (end > buf.length + TRAILING_TOLERANCE) reject("truncated WebP");
  const fourcc = buf.subarray(12, 16).toString("ascii");
  let width = 0;
  let height = 0;
  if (fourcc === "VP8 ") {
    if (buf.length < 30) reject("truncated WebP");
    const startCode = buf.subarray(23, 26);
    if (
      startCode[0] !== 0x9d ||
      startCode[1] !== 0x01 ||
      startCode[2] !== 0x2a
    ) {
      reject("invalid WebP VP8");
    }
    width = buf.readUInt16LE(26) & 0x3fff;
    height = buf.readUInt16LE(28) & 0x3fff;
  } else if (fourcc === "VP8L") {
    if (buf.length < 25) reject("truncated WebP");
    if (buf[20] !== 0x2f) reject("invalid WebP VP8L");
    const bits = buf.readUInt32LE(21);
    width = (bits & 0x3fff) + 1;
    height = ((bits >> 14) & 0x3fff) + 1;
  } else if (fourcc === "VP8X") {
    if (buf.length < 30) reject("truncated WebP");
    width = (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)) + 1;
    height = (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)) + 1;
  } else {
    reject("unsupported WebP");
  }
  return { width, height, end: Math.min(end, buf.length) };
}

function detect(buf: Buffer): {
  mime: AvatarMime;
  width: number;
  height: number;
  end: number;
} {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) {
    return { mime: "image/png", ...readPng(buf) };
  }
  if (
    buf.length >= 3 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff
  ) {
    return { mime: "image/jpeg", ...readJpeg(buf) };
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mime: "image/webp", ...readWebp(buf) };
  }
  reject("unsupported image type (PNG, JPEG, or WebP required)");
}

/**
 * Validate an uploaded avatar buffer. Throws `ApiError` 400 on any failure.
 * `_declaredMime` is accepted for caller convenience and deliberately unused.
 */
export function validateImage(
  buf: Buffer,
  limits: ImageLimits,
  _declaredMime?: string,
): ValidatedImage {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    reject("image is empty", "empty_image");
  }
  if (buf.length > limits.maxBytes) {
    throw new ApiError(
      400,
      `image exceeds ${limits.maxBytes} bytes`,
      "image_too_large",
    );
  }
  if (looksLikeHtmlOrSvg(buf)) {
    reject("SVG and HTML images are not allowed");
  }
  const { mime, width, height, end } = detect(buf);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < limits.minDim ||
    height < limits.minDim
  ) {
    reject(
      `image must be at least ${limits.minDim}x${limits.minDim}`,
      "invalid_image_dimensions",
    );
  }
  if (width > limits.maxWidth || height > limits.maxHeight) {
    reject(
      `image must be at most ${limits.maxWidth}x${limits.maxHeight}`,
      "invalid_image_dimensions",
    );
  }
  if (buf.length - end > TRAILING_TOLERANCE) {
    reject("image has trailing garbage");
  }
  return { mime, width, height, bytes: buf.length };
}

export function extForMime(mime: AvatarMime): "png" | "jpg" | "webp" {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}
