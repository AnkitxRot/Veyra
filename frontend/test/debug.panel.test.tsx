import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import * as React from "react";
import DebugPanel from "../src/components/Debug/DebugPanel";
import { DebugSessionProvider } from "../src/hooks/useDebugger";

describe("DebugPanel", () => {
  afterEach(() => cleanup());

  it("renders idle state without a live session", () => {
    const { getByTestId, getByText } = render(
      <DebugSessionProvider projectId="p1" dirtyPaths={[]}>
        <DebugPanel />
      </DebugSessionProvider>,
    );
    expect(getByTestId("debug-status").textContent).toBe("Idle");
    expect((getByTestId("debug-continue") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((getByTestId("debug-pause") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(getByText("Call stack")).toBeTruthy();
    expect(getByText("Variables")).toBeTruthy();
  });

  it("does not enable continue until the backend reports paused", () => {
    const { getByTestId } = render(
      <DebugSessionProvider projectId="p1" dirtyPaths={[]}>
        <DebugPanel />
      </DebugSessionProvider>,
    );
    fireEvent.click(getByTestId("debug-continue"));
    expect((getByTestId("debug-continue") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
