export const DEBUG_MAX_STACK_FRAMES = 32;
export const DEBUG_MAX_VARIABLES = 50;
export const DEBUG_MAX_VARIABLE_CHARS = 512;
export const DEBUG_MAX_OUTPUT_CHARS = 64 * 1024;
export const DEBUG_MAX_SCOPES = 8;
export const DEBUG_MAX_BREAKPOINTS_PER_FILE = 64;
export const DEBUG_MAX_BREAKPOINT_FILES = 32;
export const DEBUG_MAX_PROGRAM_ARGS = 32;
export const DEBUG_MAX_ARG_CHARS = 256;
export const DEBUG_MAX_PENDING = 16;

export function clipString(value: unknown, max = DEBUG_MAX_VARIABLE_CHARS): string {
  if (typeof value !== "string") {
    try {
      value = JSON.stringify(value);
    } catch {
      value = String(value);
    }
  }
  const s = value as string;
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

export function clipArray<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  return items.slice(0, max);
}
