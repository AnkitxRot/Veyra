/** M103: text-encoding / EOL / binary detection for the file API. */
export type TextEncoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "latin1";
export type Eol = "LF" | "CRLF" | "mixed" | "none";

export const TEXT_ENCODINGS: readonly TextEncoding[] = [
  "utf-8",
  "utf-8-bom",
  "utf-16le",
  "utf-16be",
  "latin1",
];

export function isTextEncoding(v: unknown): v is TextEncoding {
  return typeof v === "string" && (TEXT_ENCODINGS as readonly string[]).includes(v);
}

/** NUL byte in the first 8 KiB => binary (UTF-16 text is exempted by its BOM). */
export function isBinary(buf: Buffer): boolean {
  if (hasUtf16Bom(buf)) return false;
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function hasUtf16Bom(buf: Buffer): boolean {
  return buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
}

function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

export function detectEncoding(buf: Buffer): TextEncoding {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return "utf-8-bom";
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return "utf-16le";
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return "utf-16be";
  return isValidUtf8(buf) ? "utf-8" : "latin1";
}

export function decodeText(buf: Buffer, enc: TextEncoding): string {
  switch (enc) {
    case "utf-8":
      return buf.toString("utf8");
    case "utf-8-bom":
      return buf.subarray(3).toString("utf8");
    case "utf-16le":
      return buf.subarray(hasUtf16Bom(buf) ? 2 : 0).toString("utf16le");
    case "utf-16be": {
      const body = Buffer.from(buf.subarray(hasUtf16Bom(buf) ? 2 : 0));
      body.swap16();
      return body.toString("utf16le");
    }
    case "latin1":
      return buf.toString("latin1");
  }
}

export function encodeText(content: string, enc: TextEncoding): Buffer {
  switch (enc) {
    case "utf-8":
      return Buffer.from(content, "utf8");
    case "utf-8-bom":
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, "utf8")]);
    case "utf-16le":
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]);
    case "utf-16be": {
      const body = Buffer.from(content, "utf16le");
      body.swap16();
      return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
    }
    case "latin1":
      return Buffer.from(content, "latin1");
  }
}

export function detectEol(text: string): Eol {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  if (crlf === 0 && lf === 0) return "none";
  if (crlf > 0 && lf > 0) return "mixed";
  return crlf > 0 ? "CRLF" : "LF";
}

const INLINE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

/** Content type for inline viewing, or null when only download is allowed. */
export function inlineViewType(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return INLINE_TYPES[ext] ?? null;
}
