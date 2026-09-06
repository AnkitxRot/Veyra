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

describe("CollaboratorAvatarStack — M57 count chip", () => {
  it("shows the collaborator count and opens the team panel when clicked", () => {
    const onOpenTeamPanel = vi.fn();
    render(
      <CollaboratorAvatarStack
        collaborators={[c({ userId: 1, name: "Me" }), c({ userId: 2, name: "Rahul" })]}
        status="connected"
        currentUserId={1}
        onOpenTeamPanel={onOpenTeamPanel}
      />,
    );
    const chip = screen.getByRole("button", {
      name: /2 collaborators — open team panel/i,
    });
    fireEvent.click(chip);
    expect(onOpenTeamPanel).toHaveBeenCalledTimes(1);
  });

  it("still opens the per-avatar quick popover on avatar click (preserved)", () => {
    render(
      <CollaboratorAvatarStack
        collaborators={[
          c({ userId: 1, name: "Me" }),
          c({ userId: 2, name: "Rahul", activeFile: "src/a.ts" }),
        ]}
        status="connected"
        currentUserId={1}
        onOpenTeamPanel={vi.fn()}
        onFollowCollaborator={vi.fn()}
      />,
    );
    // the "RA" avatar button for Rahul
    fireEvent.click(screen.getByRole("button", { name: /Collaborator Rahul/i }));
    // quick popover renders a dialog with Rahul's details + Follow action
    expect(screen.getByRole("dialog", { name: /Rahul/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Follow$/i })).toBeTruthy();
  });

  it("M73: dims the roster and speaks a caveat while reconnecting", () => {
    const { container, rerender } = render(
      <CollaboratorAvatarStack
        collaborators={[c({ userId: 1, name: "Me" }), c({ userId: 2, name: "Rahul" })]}
        status="connected"
        currentUserId={1}
        onOpenTeamPanel={vi.fn()}
      />,
    );
    const liveGroup = screen.getByRole("group", { name: "Active Collaborators" });
    expect(liveGroup.style.opacity).toBe("1");

    rerender(
      <CollaboratorAvatarStack
        collaborators={[c({ userId: 1, name: "Me" }), c({ userId: 2, name: "Rahul" })]}
        status="reconnecting"
        currentUserId={1}
        onOpenTeamPanel={vi.fn()}
      />,
    );
    const staleGroup = screen.getByRole("group", {
      name: /Active Collaborators — Reconnecting/,
    });
    expect(parseFloat(staleGroup.style.opacity)).toBeLessThan(1);
    expect(container).toBeTruthy();
  });

  it("renders an away collaborator's status dot", () => {
    render(
      <CollaboratorAvatarStack
        collaborators={[c({ userId: 1 }), c({ userId: 2, name: "Away", status: "away" })]}
        status="connected"
        currentUserId={1}
        onOpenTeamPanel={vi.fn()}
      />,
    );
    expect(screen.getByTitle("Away")).toBeTruthy();
  });
});
