import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import * as React from "react";
import { mentionText } from "../src/components/Comments/mentionText";

describe("M61-A mentionText", () => {
  it("wraps only known @usernames; escapes everything else", () => {
    const { container } = render(
      React.createElement(
        React.Fragment,
        null,
        mentionText("hi @rahul <b>x</b> @ghost", new Set(["rahul"])),
      ),
    );
    expect(container.querySelectorAll(".mention").length).toBe(1);
    expect(container.textContent).toContain("<b>x</b>");
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("@ghost");
  });

  it("renders a bare string when there are no mentions", () => {
    const { container } = render(
      React.createElement(
        React.Fragment,
        null,
        mentionText("just text", new Set()),
      ),
    );
    expect(container.textContent).toBe("just text");
    expect(container.querySelectorAll(".mention").length).toBe(0);
  });
});
