import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * M61-A regression: the comment thread popover rendered ~360px off the right
 * edge of the viewport (only ~20px visible) because `.comment-thread` was
 * `position: fixed` with no offsets while nested inside `.comment-thread-overlay`
 * (itself `position: fixed; right: 20px`). The overlay collapsed to a
 * zero-width box and could not place the detached child.
 *
 * Placement must live on `.comment-thread-overlay`; every `.comment-thread`
 * rule must stay in the overlay's flow (not `position: fixed`).
 */
const css = readFileSync(resolve("src/styles/collab.css"), "utf8");

/** Bodies of every `<selector> { ... }` block (exact selector match). */
function ruleBodies(selector: string): string[] {
  const bodies: string[] = [];
  const needle = selector + " {";
  let from = 0;
  for (;;) {
    const at = css.indexOf(needle, from);
    if (at === -1) break;
    const open = css.indexOf("{", at);
    const close = css.indexOf("}", open);
    bodies.push(css.slice(open + 1, close));
    from = close + 1;
  }
  if (bodies.length === 0) throw new Error(`no CSS rule found for "${selector}"`);
  return bodies;
}

describe("M61-A comment thread overlay placement", () => {
  it("no .comment-thread rule is position:fixed (would detach from the overlay)", () => {
    const bodies = ruleBodies(".comment-thread");
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body).not.toMatch(/position:\s*fixed/);
  });

  it(".comment-thread-overlay owns the fixed top-right placement", () => {
    const [body] = ruleBodies(".comment-thread-overlay");
    expect(body).toMatch(/position:\s*fixed/);
    expect(body).toMatch(/right:\s*20px/);
    expect(body).toMatch(/top:\s*80px/);
  });
});
