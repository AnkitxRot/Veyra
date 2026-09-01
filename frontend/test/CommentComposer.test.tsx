import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import * as React from "react";
import CommentComposer from "../src/components/Comments/CommentComposer";

afterEach(cleanup);

const members = [
  { userId: 7, username: "rahul" },
  { userId: 9, username: "ankit" },
];

describe("M61-A CommentComposer", () => {
  it("derives mentions from known @tokens; unknown handles stay literal", () => {
    const onSubmit = vi.fn();
    render(
      React.createElement(CommentComposer, { members, onSubmit } as never),
    );
    const ta = screen.getByLabelText("Comment") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "@rahul look @ghost" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith({
      body: "@rahul look @ghost",
      mentions: [7],
    });
  });

  it("@ prefix opens a member menu; Shift+Enter does not submit", () => {
    const onSubmit = vi.fn();
    render(
      React.createElement(CommentComposer, { members, onSubmit } as never),
    );
    const ta = screen.getByLabelText("Comment") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hey @ra" } });
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getByText("@rahul")).toBeTruthy();
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("selecting a suggestion inserts @username and a trailing space", () => {
    const onSubmit = vi.fn();
    render(
      React.createElement(CommentComposer, { members, onSubmit } as never),
    );
    const ta = screen.getByLabelText("Comment") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "cc @an" } });
    fireEvent.keyDown(ta, { key: "Enter" }); // picks the highlighted suggestion
    expect(ta.value).toBe("cc @ankit ");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
