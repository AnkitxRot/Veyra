/**
 * M80 — strip credential material from Git stderr/stdout before it is
 * logged, stored, or returned to a client.
 */

const USERINFO_RE = /https:\/\/[^/\s]+@/gi;
const BASIC_AUTH_RE = /Authorization:\s*Basic\s+\S+/gi;
const BEARER_RE = /Authorization:\s*Bearer\s+\S+/gi;

export function redactGitOutput(text: string, secrets: string[] = []): string {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    if (out.includes(secret)) {
      out = out.split(secret).join("***");
    }
  }
  out = out.replace(USERINFO_RE, "https://***@");
  out = out.replace(BASIC_AUTH_RE, "Authorization: Basic ***");
  out = out.replace(BEARER_RE, "Authorization: Bearer ***");
  return out;
}

export function firstRedactedLine(text: string, secrets: string[] = []): string {
  const redacted = redactGitOutput(text, secrets);
  return (
    redacted
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "git command failed"
  );
}
