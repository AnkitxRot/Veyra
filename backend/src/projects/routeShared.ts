import { raw } from "express";
import type { Request } from "express";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";

/** Zip-upload body parser + extractor shared by the project import routes. */
export function makeZipHelpers(cfg: AppConfig) {
  const rawZipParser = raw({
    type: [
      "application/zip",
      "application/x-zip-compressed",
      "application/octet-stream",
      "application/x-zip",
      "application/binary",
    ],
    limit: cfg.maxArchiveUploadBytes ?? 25 * 1024 * 1024,
  });

  function getZipBuffer(req: Request): Buffer {
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      return req.body;
    }
    if (
      req.body &&
      typeof req.body.archiveBase64 === "string" &&
      req.body.archiveBase64.length > 0
    ) {
      return Buffer.from(req.body.archiveBase64, "base64");
    }
    throw new ApiError(
      400,
      "ZIP archive is required (send binary zip body or JSON archiveBase64)",
      "invalid_archive_payload",
    );
  }
  return { rawZipParser, getZipBuffer };
}
