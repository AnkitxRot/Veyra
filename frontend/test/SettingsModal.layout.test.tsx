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

// M67 — layout preferences persist through direct IDE interaction, never the
// settings modal. The modal must not carry the layout keys in its save
// payload, so "Reset Defaults" there can never rewrite a user's panel layout.

const LAYOUT_KEYS = [
  "sidebarWidth",
  "bottomHeight",
  "sidebarHidden",
  "bottomCollapsed",
] as const;

function renderModal() {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <SettingsModal
      isOpen
      preferences={{
        ...DEFAULT_PREFERENCES,
        sidebarWidth: 421,
        bottomHeight: 333,
        sidebarHidden: true,
        bottomCollapsed: true,
      }}
      onSave={
        onSave as unknown as React.ComponentProps<typeof SettingsModal>["onSave"]
      }
      onClose={vi.fn()}
      username="ada99"
    />,
  );
  return { onSave };
}

describe("SettingsModal — layout keys are never in the save payload", () => {
  it("DEFAULT_PREFERENCES still carries the layout keys for type completeness", () => {
    for (const k of LAYOUT_KEYS) {
      expect(DEFAULT_PREFERENCES).toHaveProperty(k);
    }
  });

  it("a plain Save omits every layout key", () => {
    const { onSave } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: /save preferences/i }));
    const payload = onSave.mock.calls[0][0];
    for (const k of LAYOUT_KEYS) {
      expect(payload).not.toHaveProperty(k);
    }
    expect(payload).toHaveProperty("fontSize");
  });

  it("Reset Defaults then Save still omits every layout key", () => {
    const { onSave } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: /reset defaults/i }));
    fireEvent.click(screen.getByRole("button", { name: /save preferences/i }));
    const payload = onSave.mock.calls[0][0];
    for (const k of LAYOUT_KEYS) {
      expect(payload).not.toHaveProperty(k);
    }
  });
});
