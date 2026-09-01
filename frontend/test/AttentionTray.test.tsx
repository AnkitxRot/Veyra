import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import AttentionTray from "../src/components/Collab/AttentionTray";
import type { AttentionEvent } from "../src/collab/attention";

afterEach(cleanup);

const reqTo = (
  uid: number,
  over: Partial<AttentionEvent> = {},
): AttentionEvent => ({
  id: over.id ?? Math.random().toString(16).slice(2),
  kind: "request",
  targetUserId: uid,
  author: over.author ?? { userId: 7, username: "Rahul", color: "#89b4fa" },
  file: over.file ?? "auth/session.ts",
  range: over.range ?? {
    startLine: 40,
    startColumn: 1,
    endLine: 52,
    endColumn: 1,
  },
  message: over.message ?? "I think the race is here.",
  createdAt: over.createdAt ?? Date.now(),
  expiresAt: Date.now() + 120_000,
});

const handlers = { onNavigate: vi.fn(), onDismiss: vi.fn() };

describe("M58 — AttentionTray", () => {
  it("renders a card for a request targeted at me", () => {
    render(
      <AttentionTray
        events={[reqTo(1)]}
        currentUserId={1}
        rateLimited={false}
        {...handlers}
      />,
    );
    expect(screen.getByText(/Rahul wants your attention/i)).toBeTruthy();
    expect(screen.getByText(/session\.ts · L40/i)).toBeTruthy();
    expect(screen.getByText("I think the race is here.")).toBeTruthy();
  });

  it("does not render requests targeted at someone else", () => {
    render(
      <AttentionTray
        events={[reqTo(99)]}
        currentUserId={1}
        rateLimited={false}
        {...handlers}
      />,
    );
    expect(screen.queryByText(/wants your attention/i)).toBeNull();
  });

  it("Go there navigates and marks acted", () => {
    const onNavigate = vi.fn();
    const onDismiss = vi.fn();
    const e = reqTo(1, { id: "r1" });
    render(
      <AttentionTray
        events={[e]}
        currentUserId={1}
        rateLimited={false}
        onNavigate={onNavigate}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /go there/i }));
    expect(onNavigate).toHaveBeenCalledWith(e);
    expect(onDismiss).toHaveBeenCalledWith("r1", true);
  });

  it("Dismiss calls onDismiss without acted", () => {
    const onDismiss = vi.fn();
    render(
      <AttentionTray
        events={[reqTo(1, { id: "r2" })]}
        currentUserId={1}
        rateLimited={false}
        onNavigate={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledWith("r2", undefined);
  });

  it("shows a Sent confirmation for a request I authored", () => {
    const mine = reqTo(2, {
      author: { userId: 1, username: "Me", color: "#111" },
    });
    render(
      <AttentionTray
        events={[mine]}
        currentUserId={1}
        rateLimited={false}
        {...handlers}
      />,
    );
    expect(screen.getByText(/sent/i)).toBeTruthy();
  });

  it("renders the message as text (no HTML injection)", () => {
    render(
      <AttentionTray
        events={[
          reqTo(1, { message: `<img src=x onerror="window.__x=1">` }),
        ]}
        currentUserId={1}
        rateLimited={false}
        {...handlers}
      />,
    );
    expect(document.querySelector(".attention-tray img")).toBeNull();
    expect(
      (window as unknown as { __x?: number }).__x,
    ).toBeUndefined();
  });

  it("collapses beyond 3 cards", () => {
    const many = [
      reqTo(1),
      reqTo(1),
      reqTo(1),
      reqTo(1),
      reqTo(1),
    ];
    render(
      <AttentionTray
        events={many}
        currentUserId={1}
        rateLimited={false}
        {...handlers}
      />,
    );
    expect(screen.getAllByRole("button", { name: /go there/i })).toHaveLength(3);
    expect(screen.getByText(/\+2 earlier/i)).toBeTruthy();
  });

  it("shows the rate-limited banner when rateLimited", () => {
    render(
      <AttentionTray
        events={[]}
        currentUserId={1}
        rateLimited={true}
        {...handlers}
      />,
    );
    expect(screen.getByText(/too many pending/i)).toBeTruthy();
  });

  it("M59 — request card shows a Follow button that calls onFollow(e)", () => {
    const onFollow = vi.fn();
    const e = reqTo(1, { id: "r-follow" });
    render(
      <AttentionTray
        events={[e]}
        currentUserId={1}
        rateLimited={false}
        onNavigate={vi.fn()}
        onDismiss={vi.fn()}
        onFollow={onFollow}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^follow$/i }));
    expect(onFollow).toHaveBeenCalledWith(e);
  });

  it("M59 — no Follow button when onFollow is not supplied", () => {
    render(
      <AttentionTray
        events={[reqTo(1)]}
        currentUserId={1}
        rateLimited={false}
        {...handlers}
      />,
    );
    expect(screen.queryByRole("button", { name: /^follow$/i })).toBeNull();
  });

  it("renders nothing when there is nothing to show", () => {
    const { container } = render(
      <AttentionTray
        events={[]}
        currentUserId={1}
        rateLimited={false}
        {...handlers}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
