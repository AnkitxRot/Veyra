import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import UserAvatar from "../src/components/common/UserAvatar";
import { avatarUrl } from "../src/api";
import { getUserColor } from "../src/collab/presence";

afterEach(cleanup);

describe("M72 UserAvatar", () => {
  it("renders initials from the username when there is no avatar", () => {
    render(<UserAvatar userId={3} username="rahul" size={24} />);
    const el = screen.getByText("RA") as HTMLElement;
    expect(el.tagName).toBe("SPAN");
    // jsdom normalises the hex to rgb(); compare after the same normalisation.
    const probe = document.createElement("span");
    probe.style.background = getUserColor(3);
    expect(el.style.background).toBe(probe.style.background);
    expect(document.querySelector("img")).toBeNull();
  });

  it("renders an <img> with a cache-busted src when avatarVersion > 0", () => {
    render(
      <UserAvatar userId={5} username="asha" size={32} avatarVersion={7} />,
    );
    const img = document.querySelector("img")!;
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toBe("/api/auth/profile/5/avatar?v=7");
    expect(img.getAttribute("alt")).toBe("");
  });

  it("uses the self route when `self` is set", () => {
    render(
      <UserAvatar
        userId={5}
        username="asha"
        size={32}
        avatarVersion={2}
        self
      />,
    );
    expect(document.querySelector("img")!.getAttribute("src")).toBe(
      "/api/auth/profile/avatar?v=2",
    );
  });

  it("falls back to initials after the image fails to load", () => {
    render(
      <UserAvatar userId={9} username="kim" size={24} avatarVersion={1} />,
    );
    const img = document.querySelector("img")!;
    fireEvent.error(img);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("KI")).toBeTruthy();
  });

  it("initials stay derived from the username, not any display name", () => {
    render(<UserAvatar userId={1} username="bob" size={20} />);
    expect(screen.getByText("BO")).toBeTruthy();
  });

  it("avatarUrl builds the documented shapes", () => {
    expect(avatarUrl(4, 3)).toBe("/api/auth/profile/4/avatar?v=3");
    expect(avatarUrl(4, 3, true)).toBe("/api/auth/profile/avatar?v=3");
  });
});
