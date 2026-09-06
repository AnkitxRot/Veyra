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

function renderModal(theme: "system" | "dark" | "light" = "system") {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <SettingsModal
      isOpen
      preferences={{ ...DEFAULT_PREFERENCES, theme }}
      onSave={
        onSave as unknown as React.ComponentProps<typeof SettingsModal>["onSave"]
      }
      onClose={vi.fn()}
      username="ada99"
    />,
  );
  return { onSave };
}

describe("SettingsModal — theme selector (M69)", () => {
  it("renders a Theme control reflecting the current preference", () => {
    renderModal("dark");
    const select = screen.getByLabelText(/theme/i) as HTMLSelectElement;
    expect(select.value).toBe("dark");
  });

  it("offers System, Dark and Light", () => {
    renderModal();
    const select = screen.getByLabelText(/theme/i) as HTMLSelectElement;
    const values = [...select.options].map((o) => o.value).sort();
    expect(values).toEqual(["dark", "light", "system"]);
  });

  it("a changed theme is in the Save payload", () => {
    const { onSave } = renderModal("system");
    fireEvent.change(screen.getByLabelText(/theme/i), {
      target: { value: "light" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save preferences/i }));
    expect(onSave.mock.calls[0][0]).toMatchObject({ theme: "light" });
  });

  it("Reset Defaults returns the theme to system", () => {
    const { onSave } = renderModal("dark");
    fireEvent.click(screen.getByRole("button", { name: /reset defaults/i }));
    fireEvent.click(screen.getByRole("button", { name: /save preferences/i }));
    expect(onSave.mock.calls[0][0]).toMatchObject({ theme: "system" });
  });

  it("the Save payload still omits the layout keys", () => {
    const { onSave } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: /save preferences/i }));
    const payload = onSave.mock.calls[0][0];
    for (const k of ["sidebarWidth", "bottomHeight", "sidebarHidden", "bottomCollapsed"]) {
      expect(payload).not.toHaveProperty(k);
    }
    expect(payload).toHaveProperty("theme");
  });
});
