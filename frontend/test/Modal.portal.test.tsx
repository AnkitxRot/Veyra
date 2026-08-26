import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import * as React from "react";
import { PromptModal, ConfirmModal } from "../src/components/common/Modal";

// M36 regression: PromptModal/ConfirmModal must portal to document.body so
// they escape any backdrop-filter ancestor (sidebar, toolbar, editor, admin
// panels all have one), which would otherwise confine position:fixed content
// to that ancestor's box instead of the viewport. Assertions check DOM
// ancestry and behavior, not pixel positions (jsdom doesn't lay out CSS).

describe("Modal — M36 viewport-level portal rendering", () => {
  afterEach(() => {
    cleanup();
  });

  it("PromptModal renders its backdrop outside the component's own render subtree, as a direct child of document.body", () => {
    const { container } = render(
      <div className="fake-glass-ancestor">
        <PromptModal
          isOpen
          title="Rename"
          initialValue="old-name.py"
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
      </div>,
    );

    const backdrop = document.querySelector(".glass-modal-backdrop");
    expect(backdrop).toBeTruthy();
    expect(container.contains(backdrop)).toBe(false);
    expect(backdrop!.parentElement).toBe(document.body);
  });

  it("ConfirmModal renders its backdrop outside the component's own render subtree, as a direct child of document.body", () => {
    const { container } = render(
      <div className="fake-glass-ancestor">
        <ConfirmModal
          isOpen
          title="Delete file"
          message="This cannot be undone."
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
      </div>,
    );

    const backdrop = document.querySelector(".glass-modal-backdrop");
    expect(backdrop).toBeTruthy();
    expect(container.contains(backdrop)).toBe(false);
    expect(backdrop!.parentElement).toBe(document.body);
  });

  it("preserves the glass-modal-backdrop class (carries the existing z-index/stacking CSS) after portaling", () => {
    render(
      <PromptModal
        isOpen
        title="New File"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const backdrop = document.querySelector(".glass-modal-backdrop");
    expect(backdrop!.className).toBe("glass-modal-backdrop");
  });

  it("Escape closes PromptModal (calls onCancel)", () => {
    const onCancel = vi.fn();
    render(
      <PromptModal
        isOpen
        title="Rename"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Escape closes ConfirmModal (calls onCancel)", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmModal
        isOpen
        title="Delete file"
        message="This cannot be undone."
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("backdrop click cancels, but clicking inside the modal body does not (unchanged stopPropagation behavior)", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmModal
        isOpen
        title="Delete file"
        message="This cannot be undone."
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    const backdrop = document.querySelector(".glass-modal-backdrop")!;
    const floating = document.querySelector(".glass-floating")!;

    fireEvent.click(floating);
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("PromptModal submit still calls onConfirm with the trimmed value (rename-dialog path)", () => {
    const onConfirm = vi.fn();
    render(
      <PromptModal
        isOpen
        title="Rename"
        initialValue="old-name.py"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    const input = document.querySelector(
      ".glass-modal-backdrop input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "new-name.py  " } });
    fireEvent.click(
      Array.from(
        document.querySelectorAll(".glass-modal-backdrop button"),
      ).find((b) => b.textContent === "Confirm")!,
    );
    expect(onConfirm).toHaveBeenCalledWith("new-name.py");
  });

  it("ConfirmModal submit still calls onConfirm (delete-dialog path)", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmModal
        isOpen
        title="Delete file"
        message="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(
      Array.from(
        document.querySelectorAll(".glass-modal-backdrop button"),
      ).find((b) => b.textContent === "Delete")!,
    );
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("closing removes the portaled backdrop from the document (no leaked DOM)", () => {
    const { rerender } = render(
      <PromptModal
        isOpen
        title="New Folder"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(document.querySelector(".glass-modal-backdrop")).toBeTruthy();

    rerender(
      <PromptModal
        isOpen={false}
        title="New Folder"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(document.querySelector(".glass-modal-backdrop")).toBeNull();
  });

  it("reopening does not duplicate the portaled backdrop", () => {
    const { rerender } = render(
      <PromptModal
        isOpen
        title="New Folder"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    rerender(
      <PromptModal
        isOpen={false}
        title="New Folder"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    rerender(
      <PromptModal
        isOpen
        title="New Folder"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(document.querySelectorAll(".glass-modal-backdrop").length).toBe(1);
  });
});
