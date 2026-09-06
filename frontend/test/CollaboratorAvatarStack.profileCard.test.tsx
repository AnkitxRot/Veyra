import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import CollaboratorAvatarStack from "../src/components/Collab/CollaboratorAvatarStack";
import type { CollaboratorPresence } from "../src/collab/presence";

afterEach(cleanup);

const c = (o: Partial<CollaboratorPresence>): CollaboratorPresence => ({
  clientId: o.clientId ?? Math.random(),
  userId: o.userId ?? 1,
  name: o.name ?? "x",
  role: "editor",
  color: "#89b4fa",
  status: "online",
  activity: { type: "viewing", timestamp: 0 },
  lastActive: 0,
  ...o,
});

function openPopover(target: CollaboratorPresence) {
  render(
    <CollaboratorAvatarStack
      collaborators={[c({ userId: 1, name: "me" }), target]}
      status="connected"
      currentUserId={1}
      onFollowCollaborator={vi.fn()}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: new RegExp(`Collaborator `) }),
  );
  return screen.getByRole("dialog");
}

describe("M73 — collaborator popover reuses the canonical ProfileCard", () => {
  it("renders a .profile-card (not a bespoke identity block)", () => {
    const dialog = openPopover(c({ userId: 2, name: "rahul", displayName: "Rahul K." }));
    expect(dialog.querySelector(".profile-card")).toBeTruthy();
    expect(within(dialog).getByText("Rahul K.")).toBeTruthy();
    expect(within(dialog).getByText("@rahul")).toBeTruthy();
  });

  it("shows pronouns in the card when the collaborator has them", () => {
    const dialog = openPopover(
      c({ userId: 2, name: "rahul", displayName: "Rahul K.", pronouns: "he/him" }),
    );
    expect(within(dialog).getByText("he/him")).toBeTruthy();
    expect(dialog.querySelector(".profile-card__pronouns")).toBeTruthy();
  });

  it("omits pronouns when unset", () => {
    const dialog = openPopover(c({ userId: 2, name: "rahul" }));
    expect(dialog.querySelector(".profile-card__pronouns")).toBeNull();
  });

  it("carries a presence chip reflecting the availability axis", () => {
    const dialog = openPopover(c({ userId: 2, name: "rahul", status: "away" }));
    const chip = dialog.querySelector(".profile-card__presence");
    expect(chip).toBeTruthy();
    expect(chip!.className).toContain("profile-card__presence--away");
    expect(chip!.textContent).toContain("Away");
  });

  it("still exposes the Follow action alongside the card", () => {
    openPopover(c({ userId: 2, name: "rahul", activeFile: "src/a.ts" }));
    expect(screen.getByRole("button", { name: /^Follow$/i })).toBeTruthy();
  });
});
