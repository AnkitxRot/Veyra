import React from "react";

/**
 * M61-A: render a comment body as plain text with `@username` tokens styled
 * only when the name is a known project member. Everything else is a plain
 * string child — React auto-escapes it, so `<img onerror>` / `[x](javascript:)`
 * render literally. Never `innerHTML`, never Markdown→HTML.
 */
export function mentionText(
  body: string,
  knownUsernames: Set<string>,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /@(\w+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) out.push(body.slice(last, m.index));
    const name = m[1];
    if (knownUsernames.has(name)) {
      out.push(
        <span className="mention" key={`m${key++}`}>
          @{name}
        </span>,
      );
    } else {
      out.push(m[0]);
    }
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push(body.slice(last));
  return out;
}
