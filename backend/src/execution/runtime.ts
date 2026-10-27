import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readConfinedBytes } from "../files/confined.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_RUNNER_IMAGE = "cloudeeeide-runner:latest";
export const RUNTIME_FILE = ".veyra/runtime.json";
const MAX_RUNTIME_BYTES = 4096;
// Lowercase registry-style reference. Must not start with "-" (docker flag
// injection) and contains no whitespace or shell metacharacters.
const IMAGE_RE = /^[a-z0-9][a-z0-9._/:@-]{0,127}$/;

export function isValidImageRef(v: unknown): v is string {
  return typeof v === "string" && IMAGE_RE.test(v);
}

/** Operator allowlist from RUNNER_IMAGES (comma separated); the default image is always allowed. */
export function parseRunnerImages(raw: string | undefined): string[] {
  const out = [DEFAULT_RUNNER_IMAGE];
  for (const part of (raw ?? "").split(",")) {
    const v = part.trim();
    if (isValidImageRef(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

export async function dockerImageExists(image: string): Promise<boolean> {
  try {
    // Images that declare VOLUMEs get writable, uncapped anonymous volumes
    // despite --read-only, so they are refused.
    const { stdout } = await execFileAsync("docker", ["image", "inspect", "--format", "{{json .Config.Volumes}}", image]);
    const v = stdout.trim();
    return v === "null" || v === "{}" || v === "";
  } catch {
    return false;
  }
}

export interface RuntimeChoice {
  image: string;
  /** Why the project's request was not honoured (undefined when it was, or none was made). */
  fallbackReason?: string;
}

/**
 * M108: choose the sandbox image for a project. `.veyra/runtime.json`
 * ({ "image": "<tag>" }) may only select an image the OPERATOR allowlisted via
 * RUNNER_IMAGES; anything else falls back to the default runner. The file is
 * project-controlled (the sandbox user can write it), so it is size-capped,
 * read through the confined reader, and every field is validated.
 */
export async function resolveRuntimeImage(
  workspaceDir: string,
  allowed: readonly string[],
  imageExists: (image: string) => Promise<boolean> = dockerImageExists,
): Promise<RuntimeChoice> {
  const fallback = (fallbackReason: string): RuntimeChoice => ({ image: DEFAULT_RUNNER_IMAGE, fallbackReason });
  let bytes: Buffer;
  try {
    bytes = await readConfinedBytes(workspaceDir, join(workspaceDir, RUNTIME_FILE), {
      maxBytes: MAX_RUNTIME_BYTES,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { image: DEFAULT_RUNNER_IMAGE };
    return fallback("runtime.json unreadable");
  }
  let image: unknown;
  try {
    image = (JSON.parse(bytes.toString("utf8")) as { image?: unknown } | null)?.image;
  } catch {
    return fallback("runtime.json is not valid JSON");
  }
  if (image === undefined) return { image: DEFAULT_RUNNER_IMAGE };
  if (!isValidImageRef(image)) return fallback("invalid image reference");
  if (!allowed.includes(image)) return fallback(`image "${image}" is not in RUNNER_IMAGES`);
  if (image !== DEFAULT_RUNNER_IMAGE && !(await imageExists(image)))
    return fallback(`image "${image}" is not available on this host`);
  return { image };
}
