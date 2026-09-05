import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import * as React from "react";
import NoticeStack from "../src/components/common/NoticeStack";
import type { Notice } from "../src/hooks/useNotices";

// M64 — shared renderer for surface:"stack" notices. Behaviour tests only;
// lifecycle/timers live in useNotices.

afterEach(cleanup);

let seq = 0;
function makeNotice(over: Partial<Notice> = {}): Notice {
  seq += 1;
  return {
    id: `n${seq}`,
    kind: "info",
    text: `notice ${seq}`,
    ttl: 4000,
    surface: "stack",
    role: "status",
    ...over,
  };
}

describe("NoticeStack", () => {
  it("renders nothing when the list is empty", () => {
    const { container } = render(
      <NoticeStack notices={[]} onDismiss={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders one row per notice with its text", () => {
    const notices = [
      makeNotice({ text: "alpha" }),
      makeNotice({ text: "beta" }),
    ];
    render(<NoticeStack notices={notices} onDismiss={() => {}} />);
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("beta")).toBeTruthy();
  });

  it("the dismiss control calls onDismiss with the notice id", () => {
    const onDismiss = vi.fn();
    const n = makeNotice({ id: "target-id", text: "close me" });
    render(<NoticeStack notices={[n]} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledWith("target-id");
  });

  it("an error notice carries role=alert; others role=status", () => {
    const notices = [
      makeNotice({ kind: "error", role: "alert", text: "err" }),
      makeNotice({ kind: "info", role: "status", text: "info" }),
    ];
    render(<NoticeStack notices={notices} onDismiss={() => {}} />);
    expect(screen.getByText("err").closest('[role="alert"]')).toBeTruthy();
    expect(screen.getByText("info").closest('[role="status"]')).toBeTruthy();
  });

  it("caps visible rows at max (default 3) and reports the hidden count", () => {
    const notices = [
      makeNotice({ text: "t0", ttl: 5000 }),
      makeNotice({ text: "t1", ttl: 5000 }),
      makeNotice({ text: "t2", ttl: 5000 }),
      makeNotice({ text: "t3", ttl: 5000 }),
      makeNotice({ text: "t4", ttl: 5000 }),
    ];
    render(<NoticeStack notices={notices} onDismiss={() => {}} />);
    // newest kept
    expect(screen.getByText("t4")).toBeTruthy();
    expect(screen.getByText("t3")).toBeTruthy();
    expect(screen.getByText("t2")).toBeTruthy();
    // oldest hidden
    expect(screen.queryByText("t0")).toBeNull();
    expect(screen.queryByText("t1")).toBeNull();
    expect(screen.getByText(/2 more/i)).toBeTruthy();
  });

  it("always shows persistent notices even when transient notices fill the cap", () => {
    const notices = [
      makeNotice({ text: "persistent", ttl: null, kind: "error", role: "alert" }),
      makeNotice({ text: "t1", ttl: 5000 }),
      makeNotice({ text: "t2", ttl: 5000 }),
      makeNotice({ text: "t3", ttl: 5000 }),
      makeNotice({ text: "t4", ttl: 5000 }),
    ];
    render(<NoticeStack notices={notices} onDismiss={() => {}} />);
    expect(screen.getByText("persistent")).toBeTruthy();
    // newest transients fill the remaining 2 slots
    expect(screen.getByText("t4")).toBeTruthy();
    expect(screen.getByText("t3")).toBeTruthy();
    expect(screen.queryByText("t1")).toBeNull();
  });

  it("renders notice actions as buttons wired to their handlers", () => {
    const onClick = vi.fn();
    const n = makeNotice({
      text: "with action",
      actions: [{ label: "Undo", onClick }],
    });
    render(<NoticeStack notices={[n]} onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is a labelled region for assistive tech", () => {
    render(
      <NoticeStack notices={[makeNotice()]} onDismiss={() => {}} />,
    );
    expect(screen.getByRole("region", { name: /notification/i })).toBeTruthy();
  });
});
