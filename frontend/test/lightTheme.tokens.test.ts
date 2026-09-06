import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const tokens = readFileSync(
  join(here, "../src/styles/tokens.css"),
  "utf-8",
);
const indexCss = readFileSync(
  join(here, "../src/styles/index.css"),
  "utf-8",
);

/**
 * M69 — the light theme redefines the *colour / elevation* tokens under
 * `[data-theme="light"]` so every component that reads a token flips
 * automatically. This guards that no colour token is left at its dark value
 * by accident, and that the theme is applied through the resolved-appearance
 * root attribute, not a scattered media query.
 */

function blockBody(css: string, selector: string): string {
  const start = css.indexOf(selector + " {");
  if (start === -1) return "";
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return "";
}

// Custom-property names declared in the base :root block.
function declaredVars(body: string): string[] {
  return [...body.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]);
}

// Tokens that are intentionally theme-invariant (geometry, timing, type).
const THEME_INVARIANT = /^--(blur|glass-filter|radius|space|font|text|spring|duration)/;

describe("M69 — light theme token coverage", () => {
  const rootVars = declaredVars(blockBody(tokens, ":root"));
  const lightVars = new Set(
    declaredVars(blockBody(tokens, ':root[data-theme="light"]')),
  );

  it("defines a light block keyed off the resolved-appearance root attribute", () => {
    expect(tokens).toContain(':root[data-theme="light"] {');
    // no per-component `@media (prefers-color-scheme)` palette — the JS
    // resolver owns system mode; only a color-scheme hint is allowed.
    const media = tokens.match(/@media \(prefers-color-scheme/g) ?? [];
    expect(media).toHaveLength(1);
  });

  it("redefines every theme-variant :root colour token for light", () => {
    const missing = rootVars.filter(
      (v) => !THEME_INVARIANT.test(v) && !lightVars.has(v),
    );
    expect(missing).toEqual([]);
  });

  it("tokenises the scrollbar (was a hardcoded white) and overrides it for light", () => {
    expect(tokens).toContain("--scrollbar-thumb:");
    expect(lightVars.has("--scrollbar-thumb")).toBe(true);
    expect(lightVars.has("--scrollbar-thumb-hover")).toBe(true);
    expect(indexCss).toContain("background: var(--scrollbar-thumb)");
    expect(indexCss).not.toContain(
      "::-webkit-scrollbar-thumb {\n  background: rgba(255, 255, 255",
    );
  });

  it("switches color-scheme between the two themes", () => {
    expect(blockBody(tokens, ":root")).toContain("color-scheme: dark");
    expect(blockBody(tokens, ':root[data-theme="light"]')).toContain(
      "color-scheme: light",
    );
  });

  it("keeps the reduced-transparency fallback coherent in light mode", () => {
    const reduced = tokens.slice(tokens.indexOf("prefers-reduced-transparency"));
    expect(reduced).toContain(':root[data-theme="light"]');
  });

  it("tokenises the form + recessed-panel surfaces that were hardcoded dark", () => {
    for (const v of [
      "--input-bg",
      "--input-bg-hover",
      "--input-bg-focus",
      "--surface-recessed",
      "--modal-backdrop",
    ]) {
      expect(blockBody(tokens, ":root")).toContain(`${v}:`);
      expect(lightVars.has(v)).toBe(true);
    }
  });

  it("no core surface still uses a raw dark rgba() background", () => {
    const files = [
      "glass.css",
      "output.css",
      "toolbar.css",
      "admin.css",
    ].map((f) => readFileSync(join(here, "../src/styles/" + f), "utf-8"));
    for (const css of files) {
      expect(css).not.toMatch(/background[^:]*:\s*rgba\(1[05], ?1[128], ?2?6/);
      expect(css).not.toMatch(/background[^:]*:\s*rgba\(9, ?11, ?16/);
    }
  });
});
