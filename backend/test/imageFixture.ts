import { deflateSync } from "node:zlib";

/**
 * M72 — zero-dependency synthetic image builders for avatar tests. Each
 * produces the smallest byte sequence that the magic-byte reader in
 * `backend/src/profile/image.ts` accepts as a well-formed image of the
 * given format and dimensions. They are NOT guaranteed to be renderable by
 * an image viewer — the backend never decodes pixels, only parses headers.
 */

/** CRC-32 (ISO 3309) over a PNG chunk's type+data. */
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A structurally valid truecolor PNG filled with one solid colour. */
export function makePng(
  width: number,
  height: number,
  rgb: [number, number, number] = [0x89, 0xb4, 0xfa],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolor
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3); // filter byte + RGB triples
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = rgb[0];
      row[2 + x * 3] = rgb[1];
      row[3 + x * 3] = rgb[2];
    }
    rows.push(row);
  }
  return Buffer.concat([
    PNG_SIG,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A structurally valid PNG whose pixels are pseudo-random, so the deflate
 * stream does NOT compress away — used to exercise byte-size limits.
 */
export function makeNoisyPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  let seed = 0x9e3779b9;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let i = 1; i < row.length; i++) {
      // xorshift32 — full-period, high-entropy low byte (an LCG's low bits
      // have a short period and would deflate away).
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      row[i] = seed & 0xff;
    }
    rows.push(row);
  }
  return Buffer.concat([
    PNG_SIG,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** SOI + SOF0 + EOI — enough for the header reader to extract dimensions. */
export function makeJpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0; // SOF0
  sof.writeUInt16BE(17, 2); // segment length
  sof[4] = 8; // sample precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3; // component count
  sof[10] = 1;
  sof[11] = 0x11;
  sof[13] = 2;
  sof[14] = 0x11;
  sof[16] = 3;
  sof[17] = 0x11;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** A minimal RIFF/WEBP container with a lossy VP8 dimension header. */
export function makeWebp(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10);
  payload[3] = 0x9d;
  payload[4] = 0x01;
  payload[5] = 0x2a; // VP8 keyframe start code
  payload.writeUInt16LE(width & 0x3fff, 6);
  payload.writeUInt16LE(height & 0x3fff, 8);
  const buf = Buffer.alloc(20 + payload.length);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(4 + 8 + payload.length, 4);
  buf.write("WEBP", 8);
  buf.write("VP8 ", 12);
  buf.writeUInt32LE(payload.length, 16);
  payload.copy(buf, 20);
  return buf;
}

/** A `<svg>` document — must always be rejected as an avatar. */
export function makeSvg(): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">` +
      `<script>alert(1)</script><rect width="64" height="64"/></svg>`,
    "utf8",
  );
}

/**
 * Build a `multipart/form-data` body carrying exactly one file part.
 * `declaredType` is the part's `Content-Type` header — deliberately allowed
 * to disagree with the real bytes so tests can prove it is ignored.
 */
export function multipart(
  filename: string,
  file: Buffer,
  declaredType = "image/png",
  field = "file",
): { body: Buffer; contentType: string } {
  const boundary = "----CloudideAvatarTestBoundary";
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: ${declaredType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, file, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
