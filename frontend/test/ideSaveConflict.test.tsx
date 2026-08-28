import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import * as React from "react";

// Follow-up to "prevent collab external mutation data loss": a direct file
// save that the server safely refuses (409 collab_external_conflict) must be
// shown as a truthful, non-blocking conflict notice — NOT a generic blocking
// "Save failed" alert, and never claiming a merge happened.
//
// The routing decision (`handleSaveError`) and the message text are unit-
// tested directly against production code in collabConflict.test.ts. This
// test covers the IDE wiring: a conflict lands in the M56 banner and not in
// alert(); a normal save is unaffected.

const apiMock = vi.fn();
vi.mock("../src/api", () => ({
  api: (...args: any[]) => apiMock(...args),
  getWebSocketUrl: (path: string, projectId: string) =>
    `ws://test${path}?projectId=${projectId}`,
}));

import { handleSaveError } from "../src/utils/collabConflict";

/**
 * Mirrors IDE.tsx's ide-save listener EXACTLY for the success/error branches:
 * success -> "Saved <file>" toast; error -> handleSaveError() routes a collab
 * conflict into the dismissible external-mutation banner (leaving the buffer
 * dirty) and everything else into alert(). Only the wiring is reproduced here;
 * the decision lives in the imported production helper.
 */
function SaveHarness({ projectId }: { projectId: string }) {
  const [saveToast, setSaveToast] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{
    text: string;
    key: string;
  } | null>(null);
  const [dirtyCleared, setDirtyCleared] = React.useState(false);
  const timerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const onSave = async (e: Event) => {
      const path = (e as CustomEvent).detail?.path as string;
      const { api } = await import("../src/api");
      try {
        await api(`/api/projects/${projectId}/file`, {
          method: "POST",
          body: JSON.stringify({ path, content: "x" }),
        });
        setDirtyCleared(true);
        setSaveToast(`Saved ${path.split("/").pop()}`);
      } catch (err) {
        handleSaveError(err, path, {
          onCollabConflict: (message) => {
            const key = `save-conflict:${path}:${Date.now()}`;
            setNotice({ text: message, key });
            if (timerRef.current) window.clearTimeout(timerRef.current);
            timerRef.current = window.setTimeout(() => {
              setNotice((cur) => (cur && cur.key === key ? null : cur));
            }, 8000);
          },
          onFailure: (m) => alert(`Save failed: ${m}`),
        });
      }
    };
    document.addEventListener("ide-save", onSave);
    return () => document.removeEventListener("ide-save", onSave);
  }, [projectId]);

  return (
    <div>
      {saveToast && <div data-testid="save-toast">{saveToast}</div>}
      {dirtyCleared && <div data-testid="dirty-cleared" />}
      {notice && (
        <div role="status" className="external-mutation-banner">
          <span className="emb-text">{notice.text}</span>
        </div>
      )}
    </div>
  );
}

function fireSave(path: string) {
  document.dispatchEvent(new CustomEvent("ide-save", { detail: { path } }));
}

describe("IDE save — collaboration conflict visibility", () => {
  let alertSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    apiMock.mockReset();
    alertSpy = vi.fn();
    vi.stubGlobal("alert", alertSpy);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("a 409 collab_external_conflict shows a truthful conflict notice, not a blocking alert, and does not clear dirty", async () => {
    apiMock.mockRejectedValue(
      Object.assign(new Error("This file has unsaved changes from another collaborator."), {
        code: "collab_external_conflict",
        status: 409,
      }),
    );

    render(<SaveHarness projectId="p1" />);
    fireSave("src/app/main.ts");

    const banner = await screen.findByRole("status");
    const text = (banner.textContent || "").toLowerCase();
    expect(text).toContain("main.ts");
    expect(text).toContain("not applied");
    expect(text).toContain("their version was kept");
    expect(text).not.toContain("merge");

    expect(alertSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("save-toast")).toBeNull();
    // Buffer NOT marked clean — the save did not apply, so a retry is possible.
    expect(screen.queryByTestId("dirty-cleared")).toBeNull();
  });

  it("a successful save shows the normal toast and no conflict banner", async () => {
    apiMock.mockResolvedValue({ ok: true });

    render(<SaveHarness projectId="p1" />);
    fireSave("src/app/main.ts");

    await waitFor(() =>
      expect(screen.getByTestId("save-toast").textContent).toBe(
        "Saved main.ts",
      ),
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("dirty-cleared")).not.toBeNull();
  });

  it("a genuine server failure still uses the blocking alert (a conflict must not swallow real errors)", async () => {
    apiMock.mockRejectedValue(
      Object.assign(new Error("Internal Server Error"), { status: 500 }),
    );

    render(<SaveHarness projectId="p1" />);
    fireSave("src/app/main.ts");

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        "Save failed: Internal Server Error",
      ),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});
