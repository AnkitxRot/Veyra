import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import * as React from "react";

vi.mock("../src/api", () => ({
  getProfile: () => Promise.resolve({}),
  updateProfile: () => Promise.resolve({}),
}));

import SettingsModal, {
  DEFAULT_PREFERENCES,
} from "../src/components/Settings/SettingsModal";

afterEach(cleanup);

function renderModal(formatOnSave: boolean) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <SettingsModal
      isOpen
      preferences={{ ...DEFAULT_PREFERENCES, formatOnSave }}
      onSave={
        onSave as unknown as React.ComponentProps<typeof SettingsModal>["onSave"]
      }
      onClose={vi.fn()}
      username="ada99"
    />,
  );
  return { onSave };
}

describe("M66 — SettingsModal Format on Save toggle", () => {
  it("DEFAULT_PREFERENCES carries formatOnSave: false", () => {
    expect(DEFAULT_PREFERENCES.formatOnSave).toBe(false);
  });

  it("renders the toggle reflecting the current preference", () => {
    renderModal(true);
    let row: HTMLElement | null = screen.getByText("Format on Save");
    while (row && !row.querySelector('input[type="checkbox"]')) {
      row = row.parentElement;
    }
    const checkbox = row!.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it("saving after toggling on sends formatOnSave: true", async () => {
    const { onSave } = renderModal(false);
    let row: HTMLElement | null = screen.getByText("Format on Save");
    while (row && !row.querySelector('input[type="checkbox"]')) {
      row = row.parentElement;
    }
    const checkbox = row!.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ formatOnSave: true }),
    );
  });
});
