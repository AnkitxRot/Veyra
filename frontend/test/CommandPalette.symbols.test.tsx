import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import * as React from "react";
import CommandPaletteModal from "../src/components/common/CommandPaletteModal";
import type { Command } from "../src/utils/commands";

Element.prototype.scrollIntoView =
  Element.prototype.scrollIntoView || (() => {});

afterEach(cleanup);

const commands: Command[] = [
  {
    id: "workbench.action.gotoSymbol",
    title: "Go to Symbol in Workspace",
    category: "Navigation",
    handler: () => {},
  },
];

const fileIndex = [
  { path: "src/a.ts", filename: "a.ts", extension: "ts", directory: "src" },
];

describe("CommandPalette symbols mode", () => {
  it("typing # switches to workspace symbols and opens a hit", async () => {
    const searchSymbols = vi.fn().mockResolvedValue([
      { name: "helper", filePath: "pkg/util.py", line: 1, column: 5 },
    ]);
    const onOpenSymbol = vi.fn();
    const { getByTestId, getByPlaceholderText } = render(
      React.createElement(CommandPaletteModal, {
        isOpen: true,
        initialMode: "files",
        onClose: vi.fn(),
        fileIndex,
        recentFiles: [],
        onOpenFile: vi.fn(),
        commands,
        onExecuteCommand: vi.fn(),
        searchSymbols,
        onOpenSymbol,
      }),
    );
    const input = getByTestId("command-palette-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "#helper" } });
    expect(getByPlaceholderText("Search workspace symbols...")).toBeTruthy();
    await waitFor(() => expect(searchSymbols).toHaveBeenCalled());
    await waitFor(() => expect(getByTestId("command-palette-symbol").textContent).toContain("helper"));
    fireEvent.click(getByTestId("command-palette-symbol"));
    expect(onOpenSymbol).toHaveBeenCalledWith({
      name: "helper",
      filePath: "pkg/util.py",
      line: 1,
      column: 5,
    });
  });
});
