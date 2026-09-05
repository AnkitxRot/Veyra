import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  cleanup,
  fireEvent,
  waitFor,
  screen,
} from "@testing-library/react";
import * as React from "react";
import type { UserProfile } from "../src/types";

const getProfileMock = vi.fn();
const updateProfileMock = vi.fn();
vi.mock("../src/api", () => ({
  getProfile: () => getProfileMock(),
  updateProfile: (patch: unknown) => updateProfileMock(patch),
}));

import SettingsModal, {
  DEFAULT_PREFERENCES,
} from "../src/components/Settings/SettingsModal";

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    displayName: null,
    pronouns: null,
    bio: null,
    updatedAt: null,
    ...overrides,
  };
}

function renderModal(props: { isDemo?: boolean; username?: string } = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const utils = render(
    <SettingsModal
      isOpen
      preferences={DEFAULT_PREFERENCES}
      onSave={onSave as unknown as React.ComponentProps<typeof SettingsModal>["onSave"]}
      onClose={onClose}
      username={props.username ?? "ada99"}
      isDemo={props.isDemo}
    />,
  );
  return { ...utils, onSave, onClose };
}

async function openProfileTab() {
  fireEvent.click(screen.getByRole("tab", { name: "Profile" }));
  // GET resolves → fields appear
  await screen.findByLabelText("Display name");
}

describe("M62-4 — SettingsModal Profile tab", () => {
  beforeEach(() => {
    getProfileMock.mockReset();
    updateProfileMock.mockReset();
    getProfileMock.mockResolvedValue({ profile: profile() });
    updateProfileMock.mockImplementation((patch: any) =>
      Promise.resolve({
        profile: profile({
          displayName: patch.displayName,
          pronouns: patch.pronouns,
          bio: patch.bio,
          updatedAt: "2026-09-04T00:00:00.000Z",
        }),
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("1. shows the Editor tab first", () => {
    renderModal();
    expect(screen.getByRole("tab", { name: "Editor" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Save Preferences")).toBeTruthy();
    expect(getProfileMock).not.toHaveBeenCalled();
  });

  it("2. + 3. switching to Profile triggers exactly one GET /api/auth/profile", async () => {
    renderModal();
    await openProfileTab();
    expect(getProfileMock).toHaveBeenCalledTimes(1);
    // toggling back and forth does NOT refetch
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    fireEvent.click(screen.getByRole("tab", { name: "Profile" }));
    await screen.findByLabelText("Display name");
    expect(getProfileMock).toHaveBeenCalledTimes(1);
  });

  it("4. shows a loading state before the profile resolves", async () => {
    let resolve!: (v: { profile: UserProfile }) => void;
    getProfileMock.mockImplementation(
      () => new Promise((r) => (resolve = r)),
    );
    renderModal();
    fireEvent.click(screen.getByRole("tab", { name: "Profile" }));
    expect(screen.getByText("Loading…")).toBeTruthy();
    resolve({ profile: profile({ displayName: "Ada L." }) });
    await screen.findByLabelText("Display name");
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("5. renders persisted values", async () => {
    getProfileMock.mockResolvedValue({
      profile: profile({
        displayName: "Ada L.",
        pronouns: "she/her",
        bio: "Compiler nerd",
      }),
    });
    renderModal();
    await openProfileTab();
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Ada L.");
    expect((screen.getByLabelText("Pronouns") as HTMLInputElement).value).toBe("she/her");
    expect((screen.getByLabelText("Bio") as HTMLTextAreaElement).value).toBe("Compiler nerd");
  });

  it("6.-8. edits each field", async () => {
    renderModal();
    await openProfileTab();
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Ada L." } });
    fireEvent.change(screen.getByLabelText("Pronouns"), { target: { value: "she/her" } });
    fireEvent.change(screen.getByLabelText("Bio"), { target: { value: "hi" } });
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Ada L.");
    expect((screen.getByLabelText("Pronouns") as HTMLInputElement).value).toBe("she/her");
    expect((screen.getByLabelText("Bio") as HTMLTextAreaElement).value).toBe("hi");
  });

  it("9.-11. enforces maxLength 48 / 24 / 280", async () => {
    renderModal();
    await openProfileTab();
    expect((screen.getByLabelText("Display name") as HTMLInputElement).maxLength).toBe(48);
    expect((screen.getByLabelText("Pronouns") as HTMLInputElement).maxLength).toBe(24);
    expect((screen.getByLabelText("Bio") as HTMLTextAreaElement).maxLength).toBe(280);
  });

  it("12. character counters reflect the current length", async () => {
    renderModal();
    await openProfileTab();
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Ada" } });
    expect(screen.getByText("3/48")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Bio"), { target: { value: "hello" } });
    expect(screen.getByText("5/280")).toBeTruthy();
  });

  it("13. blank display-name helper names the username", async () => {
    renderModal();
    await openProfileTab();
    expect(screen.getByText(/Blank → @ada99\./)).toBeTruthy();
  });

  it("14. Save sends exactly displayName/pronouns/bio, blank → null", async () => {
    renderModal();
    await openProfileTab();
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "  Ada L.  " } });
    fireEvent.click(screen.getByText("Save Profile"));
    await waitFor(() => expect(updateProfileMock).toHaveBeenCalledTimes(1));
    expect(updateProfileMock.mock.calls[0][0]).toEqual({
      displayName: "Ada L.",
      pronouns: null,
      bio: null,
    });
  });

  it("15. Save success adopts the canonical server response", async () => {
    updateProfileMock.mockResolvedValue({
      profile: profile({ displayName: "Server Wins", pronouns: null, bio: null }),
    });
    renderModal();
    await openProfileTab();
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "typed" } });
    fireEvent.click(screen.getByText("Save Profile"));
    await screen.findByText("Profile saved");
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Server Wins");
  });

  it("16. Save disables the button and shows Saving…", async () => {
    let resolve!: (v: { profile: UserProfile }) => void;
    updateProfileMock.mockImplementation(() => new Promise((r) => (resolve = r)));
    renderModal();
    await openProfileTab();
    fireEvent.click(screen.getByText("Save Profile"));
    const btn = screen.getByText("Saving…") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // a second click while in-flight does not fire a second request
    fireEvent.click(btn);
    resolve({ profile: profile() });
    await waitFor(() => expect(updateProfileMock).toHaveBeenCalledTimes(1));
  });

  it("17. a 400 surfaces the server's own message verbatim", async () => {
    updateProfileMock.mockRejectedValue(
      new Error("displayName must be at most 48 characters"),
    );
    renderModal();
    await openProfileTab();
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "x" } });
    fireEvent.click(screen.getByText("Save Profile"));
    expect(
      await screen.findByText("displayName must be at most 48 characters"),
    ).toBeTruthy();
  });

  it("18. demo mode disables every profile control", async () => {
    renderModal({ isDemo: true });
    await openProfileTab();
    expect((screen.getByLabelText("Display name") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Pronouns") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Bio") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByText("Save Profile") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Profile editing is disabled for demo sessions")).toBeTruthy();
    fireEvent.click(screen.getByText("Save Profile"));
    expect(updateProfileMock).not.toHaveBeenCalled();
  });

  it("19. Editor save still calls onSave with preferences and never updateProfile", async () => {
    const { onSave, onClose } = renderModal();
    fireEvent.click(screen.getByText("Save Preferences"));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({
      fontSize: DEFAULT_PREFERENCES.fontSize,
      tabSize: DEFAULT_PREFERENCES.tabSize,
    });
    expect(onClose).toHaveBeenCalled();
    expect(updateProfileMock).not.toHaveBeenCalled();
  });

  it("20. the Profile submit button is the only submit in the Profile panel", async () => {
    const { onSave } = renderModal();
    await openProfileTab();
    // Editor's "Save Preferences" is not mounted while Profile is active
    expect(screen.queryByText("Save Preferences")).toBeNull();
    const panel = screen.getByRole("tabpanel", { name: "Profile" });
    fireEvent.submit(panel);
    await waitFor(() => expect(updateProfileMock).toHaveBeenCalled());
    expect(onSave).not.toHaveBeenCalled();
  });

  it("21. reopening reloads persisted values (no stale draft)", async () => {
    const { rerender } = renderModal();
    await openProfileTab();
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "unsaved edit" } });
    // close
    rerender(
      <SettingsModal
        isOpen={false}
        preferences={DEFAULT_PREFERENCES}
        onSave={vi.fn()}
        onClose={vi.fn()}
        username="ada99"
      />,
    );
    getProfileMock.mockResolvedValue({ profile: profile({ displayName: "Persisted" }) });
    // reopen
    rerender(
      <SettingsModal
        isOpen
        preferences={DEFAULT_PREFERENCES}
        onSave={vi.fn()}
        onClose={vi.fn()}
        username="ada99"
      />,
    );
    await openProfileTab();
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Persisted");
    expect(getProfileMock).toHaveBeenCalledTimes(2);
  });

  it("does not render profile values through any HTML sink", async () => {
    getProfileMock.mockResolvedValue({
      profile: profile({ displayName: "<img src=x onerror=alert(1)>" }),
    });
    const { container } = renderModal();
    await openProfileTab();
    // the value is a plain input value, never parsed as markup
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe(
      "<img src=x onerror=alert(1)>",
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("a load failure surfaces an error and keeps the tab usable", async () => {
    getProfileMock.mockRejectedValue(new Error("network down"));
    renderModal();
    fireEvent.click(screen.getByRole("tab", { name: "Profile" }));
    expect(await screen.findByText("network down")).toBeTruthy();
  });
});
