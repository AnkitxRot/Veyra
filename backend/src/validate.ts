import { z } from "zod";
import { ApiError } from "./errors.js";

/**
 * Parse `data` with `schema` at an HTTP boundary. The first failing issue is
 * surfaced as a 400 `ApiError`; its message is the issue message and its code
 * is `issue.params.code` when the schema supplied one (via `.refine(..., { params })`)
 * or `fallbackCode` otherwise. This keeps the public error contract
 * ({ error, code }) stable while moving the checks out of handler bodies.
 */
export function parseInput<S extends z.ZodType>(
  schema: S,
  data: unknown,
  fallbackCode = "invalid_request",
): z.output<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const params = (issue as { params?: { code?: unknown } } | undefined)?.params;
  const code = typeof params?.code === "string" ? params.code : fallbackCode;
  throw new ApiError(400, issue?.message ?? "invalid request", code);
}

/**
 * A string field where a missing value, a non-string and a failed predicate all
 * map to one message + code (the contract the hand-written checks had).
 */
export const checkedString = (
  message: string,
  code: string,
  predicate: (value: string) => boolean = () => true,
) =>
  z.custom<string>((value) => typeof value === "string" && predicate(value), {
    error: message,
    params: { code },
  });
