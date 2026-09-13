import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import CollaboratorAvatarStack from "../src/components/Collab/CollaboratorAvatarStack";
import type { CollaboratorPresence } from "../src/collab/presence";

afterEach(cleanup);

const c = (o: Partial<CollaboratorPresence>): CollaboratorPresence => ({
  clientId: o.clientId ?? Math.random(),
  userId: o.userId ?? 1,
  name: o.name ?? "X",
  role: "editor",
  color: "#89b4fa",
  status: "online",
  activity: { type: "viewing", timestamp: 0 },
  lastActive: 0,
  ...o,
});

const base = {
  collaborators: [c({ userId: 2, name: "Rahul" })],
  status: "connected" as const,
  currentUserId: 1,
  onOpenTeamPanel: vi.fn(),
  onFollowCollaborator: vi.fn(),
  onJumpToCollaborator: vi.fn(),
  onToggleDnd: vi.fn(),
};

describe("CollaboratorAvatarStack — M58 attention badge", () => {
  it("shows the attention badge only when count > 0", () => {
    const { rerender } = render(
      <CollaboratorAvatarStack {...base} incomingRequestCount={0} />,
    );
    expect(document.querySelector(".collab-attn-badge")).toBeNull();
    rerender(
      <CollaboratorAvatarStack {...base} incomingRequestCount={2} />,
    );
    expect(screen.getByLabelText(/2 attention requests/i)).toBeTruthy();
  });

  it("still opens the team panel on chip click and keeps the quick popover", () => {
    const onOpenTeamPanel = vi.fn();
    render(
      <CollaboratorAvatarStack
        {...base}
        incomingRequestCount={1}
        onOpenTeamPanel={onOpenTeamPanel}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /open team panel/i }),
    );
    expect(onOpenTeamPanel).toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: /Collaborator Rahul/i }),
    );
    expect(document.querySelector(".collab-popover")).not.toBeNull();
  });

  it("M59 — popover shows the collaborator's latest callout + a focus-state chip", () => {
    const attention = [
      {
        id: "c1",
        kind: "callout" as const,
        author: { userId: 2, username: "Rahul", color: "#89b4fa" },
        file: "auth/session.ts",
        range: { startLine: 40, startColumn: 1, endLine: 52, endColumn: 1 },
        message: "the race is here",
        createdAt: Date.now(),
        expiresAt: Date.now() + 90_000,
      },
    ];
    render(
      <CollaboratorAvatarStack {...base} attention={attention as any} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Collaborator Rahul/i }),
    );
    expect(screen.getByText(/the race is here/)).toBeTruthy();
    expect(screen.getByText(/Lines 40–52/)).toBeTruthy();
    expect(document.querySelector(".focus-state-focused")).not.toBeNull();
  });

  it("M59 — no focus block when the collaborator has no range or message", () => {
    render(<CollaboratorAvatarStack {...base} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Collaborator Rahul/i }),
    );
    expect(document.querySelector(".collab-popover-focus")).toBeNull();
  });

  it("dispatches ide-focus-attention-tray when the chip is clicked with pending requests", () => {
    const spy = vi.fn();
    document.addEventListener("ide-focus-attention-tray", spy);
    render(
      <CollaboratorAvatarStack {...base} incomingRequestCount={3} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /open team panel/i }),
    );
    expect(spy).toHaveBeenCalled();
    document.removeEventListener("ide-focus-attention-tray", spy);
  });
});
