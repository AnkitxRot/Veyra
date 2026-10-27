import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/markdown";

describe("renderMarkdown", () => {
  it("renders basics", () => {
    const h = renderMarkdown("# T\n\n**b** *i* `c`\n\n- a\n- b\n\n```\nx<y\n```");
    expect(h).toContain("<h1>T</h1>");
    expect(h).toContain("<strong>b</strong>");
    expect(h).toContain("<code>c</code>");
    expect(h).toContain("<ul><li>a</li><li>b</li></ul>");
    expect(h).toContain("x&lt;y");
  });
  it("never emits raw html or script", () => {
    const h = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(h).not.toContain("<script");
    expect(h).not.toContain("<img");
  });
  it("blocks javascript:/data: links", () => {
    expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("href");
    expect(renderMarkdown("[x](data:text/html,hi)")).not.toContain("href");
    expect(renderMarkdown("[x](https://a.b/?q=1&r=2)")).toContain('href="https://a.b/?q=1&amp;r=2"');
  });
  it("cannot break out of an attribute", () => {
    const h = renderMarkdown('[x](https://a.b/"onmouseover="alert(1))');
    expect(h).not.toMatch(/"onmouseover=/);
  });
  it("code spans are not re-interpreted", () => {
    expect(renderMarkdown("`**no**`")).toBe("<p><code>**no**</code></p>");
  });
});
