import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import ProfileCard from "../src/components/common/ProfileCard";

afterEach(cleanup);

describe("M72 ProfileCard", () => {
  it("shows the display name and @username when they differ", () => {
    render(
      <ProfileCard userId={1} username="rahul" displayName="Rahul K." />,
    );
    expect(screen.getByText("Rahul K.")).toBeTruthy();
    expect(screen.getByText("@rahul")).toBeTruthy();
  });

  it("shows only the username (no redundant handle) when no display name is set", () => {
    render(<ProfileCard userId={1} username="rahul" displayName={null} />);
    expect(screen.getByText("rahul")).toBeTruthy();
    expect(screen.queryByText("@rahul")).toBeNull();
  });

  it("renders pronouns only when present", () => {
    const { rerender } = render(
      <ProfileCard userId={1} username="a" pronouns={null} />,
    );
    expect(screen.queryByText("they/them")).toBeNull();
    rerender(<ProfileCard userId={1} username="a" pronouns="they/them" />);
    expect(screen.getByText("they/them")).toBeTruthy();
  });

  it("renders bio only when present, as plain text", () => {
    const { rerender } = render(
      <ProfileCard userId={1} username="a" bio={null} />,
    );
    expect(document.querySelector(".profile-card__bio")).toBeNull();
    rerender(
      <ProfileCard
        userId={1}
        username="a"
        bio={'<img src=x onerror="alert(1)">'}
      />,
    );
    const bioEl = document.querySelector(".profile-card__bio")!;
    expect(bioEl.textContent).toBe('<img src=x onerror="alert(1)">');
    expect(bioEl.querySelector("img")).toBeNull();
  });

  it("renders a presence chip with the tone class when supplied", () => {
    render(
      <ProfileCard
        userId={1}
        username="a"
        presence={{ label: "Online", tone: "online" }}
      />,
    );
    expect(
      document.querySelector(".profile-card__presence--online"),
    ).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
  });

  it("shows the avatar image when a version is set", () => {
    render(
      <ProfileCard userId={8} username="k" avatarVersion={3} />,
    );
    expect(document.querySelector("img")!.getAttribute("src")).toBe(
      "/api/auth/profile/8/avatar?v=3",
    );
  });
});
