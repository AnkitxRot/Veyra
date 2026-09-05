import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import * as React from "react";
import CollabConnectionBanner from "../src/components/Collab/CollabConnectionBanner";
import type { CollabConnectionBannerProps } from "../src/components/Collab/CollabConnectionBanner";

afterEach(cleanup);

const noop = () => {};

function renderBanner(props: Partial<CollabConnectionBannerProps> = {}) {
  return render(
    <CollabConnectionBanner
      status="connected"
      pendingLocalUpdates={0}
      reconnectExhausted={false}
      onRetry={noop}
      {...props}
    />,
  );
}

describe("CollabConnectionBanner — M63 editor-region connection visibility", () => {
  it("renders nothing when connected with no pending local changes", () => {
    const { container } = renderBanner({ status: "connected" });
    expect(container.firstChild).toBeNull();
  });

  it("shows a reconnecting message while reconnecting", () => {
    renderBanner({ status: "reconnecting" });
    expect(screen.getByText(/reconnect/i)).toBeTruthy();
  });

  it("shows a syncing message while resynchronizing", () => {
    renderBanner({ status: "resynchronizing" });
    expect(screen.getByText(/sync/i)).toBeTruthy();
  });

  it("shows a disconnected message while disconnected", () => {
    renderBanner({ status: "disconnected" });
    expect(screen.getByText(/disconnect/i)).toBeTruthy();
  });

  it("shows an access-ended message when forbidden and offers no retry", () => {
    renderBanner({ status: "forbidden" });
    expect(screen.getByText(/access/i)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /retry|reconnect/i }),
    ).toBeNull();
  });

  it("offers a Retry button only when automatic reconnects are exhausted, and calls onRetry", () => {
    const onRetry = vi.fn();
    renderBanner({
      status: "disconnected",
      reconnectExhausted: true,
      onRetry,
    });
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("does not show a Retry button for an ordinary (non-exhausted) disconnect", () => {
    renderBanner({ status: "disconnected", reconnectExhausted: false });
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("warns about unsynced local changes without claiming data loss", () => {
    renderBanner({ status: "disconnected", pendingLocalUpdates: 3 });
    const warning = screen.getByText(/unsynced local changes/i);
    expect(warning).toBeTruthy();
    const t = warning.textContent?.toLowerCase() ?? "";
    expect(t.includes("lost")).toBe(false);
    expect(t.includes("deleted")).toBe(false);
  });

  it("shows the unsynced-changes warning even when the status is connected", () => {
    renderBanner({ status: "connected", pendingLocalUpdates: 1 });
    expect(screen.getByText(/unsynced local changes/i)).toBeTruthy();
  });

  it("renders independently of any collaborator list (takes no collaborators prop)", () => {
    renderBanner({ status: "reconnecting" });
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("marks terminal states as alerts for assistive tech", () => {
    const { rerender } = renderBanner({
      status: "disconnected",
      reconnectExhausted: true,
    });
    expect(screen.getByRole("alert")).toBeTruthy();
    rerender(
      <CollabConnectionBanner
        status="forbidden"
        pendingLocalUpdates={0}
        reconnectExhausted={false}
        onRetry={noop}
      />,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
