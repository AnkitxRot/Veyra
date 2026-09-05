import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import * as React from "react";

// Follow-up to "prevent collab external mutation data loss": a direct file
// save that the server safely refuses (409 collab_external_conflict) must be
// shown as a truthful, non-blocking conflict notice — NOT a "Save failed"
// error, and never claiming a merge happened.
//
// M64: the ide-save listener no longer calls alert() at all. A real failure
// becomes a persistent error notice; a collab conflict goes to the shared
// "ext-mutation" transient slot; a success clears any standing save-failure
// notice for that path. The routing decision (`handleSaveError`) and message
// text are unit-tested in collabConflict.test.ts; this test covers the IDE
// wiring against the real useNotices hook.

const apiMock = vi.fn();
vi.mock("../src/api", () => ({
  api: (...args: any[]) => apiMock(...args),
  getWebSocketUrl: (path: string, projectId: string) =>
    `ws://test${path}?projectId=${projectId}`,
}));

import { handleSaveError } from "../src/utils/collabConflict";
import { useNotices } from "../src/hooks/useNotices";
import NoticeStack from "../src/components/common/NoticeStack";

/**
 * Mirrors IDE.tsx's ide-save listener for the success/error branches after
 * M64: success -> statusbar "Saved <file>" + clear this path's save-failure
 * notice; error -> handleSaveError() routes a collab conflict into the shared
 * transient "ext-mutation" slot (buffer left dirty) and everything else into
 * a persistent per-path save-failure error notice. No alert() anywhere.
 */
function SaveHarness({ projectId }: { projectId: string }) {
  const { notices, notify, dismiss, dismissKey } = useNotices();
  const [dirtyCleared, setDirtyCleared] = React.useState(false);

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
        dismissKey(`save-fail:${path}`);
        notify({
          kind: "success",
          text: `Saved ${path.split("/").pop()}`,
          ttl: 2000,
          surface: "statusbar",
          dedupeKey: "save-toast",
        });
      } catch (err) {
        handleSaveError(err, path, {
          onCollabConflict: (message) => {
            notify({
              kind: "warning",
              text: message,
              ttl: 8000,
              dedupeKey: "ext-mutation",
            });
          },
          onFailure: (message) => {
            notify({
              kind: "error",
              text: `Save failed: ${message}`,
              ttl: null,
              dedupeKey: `save-fail:${path}`,
            });
          },
        });
      }
    };
    document.addEventListener("ide-save", onSave);
    return () => document.removeEventListener("ide-save", onSave);
  }, [projectId, notify, dismissKey]);

  const statusbar = notices.find((n) => n.surface === "statusbar")?.text ?? null;

  return (
    <div>
      {statusbar && <div data-testid="save-toast">{statusbar}</div>}
      {dirtyCleared && <div data-testid="dirty-cleared" />}
      <NoticeStack
        notices={notices.filter((n) => n.surface === "stack")}
        onDismiss={dismiss}
      />
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

  it("a 409 collab_external_conflict shows a truthful conflict notice, never alert(), and does not clear dirty", async () => {
    apiMock.mockRejectedValue(
      Object.assign(
        new Error("This file has unsaved changes from another collaborator."),
        { code: "collab_external_conflict", status: 409 },
      ),
    );

    render(<SaveHarness projectId="p1" />);
    fireSave("src/app/main.ts");

    const stack = await screen.findByRole("region", { name: /notification/i });
    const text = (stack.textContent || "").toLowerCase();
    expect(text).toContain("main.ts");
    expect(text).toContain("not applied");
    expect(text).toContain("their version was kept");
    expect(text).not.toContain("merge");

    expect(alertSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("save-toast")).toBeNull();
    // Buffer NOT marked clean — the save did not apply, so a retry is possible.
    expect(screen.queryByTestId("dirty-cleared")).toBeNull();
  });

  it("a successful save shows the normal toast and no conflict/error notice", async () => {
    apiMock.mockResolvedValue({ ok: true });

    render(<SaveHarness projectId="p1" />);
    fireSave("src/app/main.ts");

    await waitFor(() =>
      expect(screen.getByTestId("save-toast").textContent).toBe("Saved main.ts"),
    );
    expect(screen.queryByRole("region", { name: /notification/i })).toBeNull();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("dirty-cleared")).not.toBeNull();
  });

  it("a genuine server failure becomes a persistent error notice, not a blocking alert", async () => {
    apiMock.mockRejectedValue(
      Object.assign(new Error("Internal Server Error"), { status: 500 }),
    );

    render(<SaveHarness projectId="p1" />);
    fireSave("src/app/main.ts");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Save failed: Internal Server Error");
    expect(alertSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("save-toast")).toBeNull();
  });

  it("repeated failures for the same path collapse to a single notice", async () => {
    apiMock.mockRejectedValue(
      Object.assign(new Error("Internal Server Error"), { status: 500 }),
    );

    render(<SaveHarness projectId="p1" />);
    fireSave("src/app/main.ts");
    await screen.findByRole("alert");
    fireSave("src/app/main.ts");
    fireSave("src/app/main.ts");

    await waitFor(() =>
      expect(screen.getAllByRole("alert")).toHaveLength(1),
    );
  });

  it("a later successful save clears the standing failure notice for that path", async () => {
    apiMock.mockRejectedValueOnce(
      Object.assign(new Error("Internal Server Error"), { status: 500 }),
    );
    apiMock.mockResolvedValueOnce({ ok: true });

    render(<SaveHarness projectId="p1" />);
    fireSave("src/app/main.ts");
    await screen.findByRole("alert");

    fireSave("src/app/main.ts");
    await waitFor(() =>
      expect(screen.getByTestId("save-toast").textContent).toBe("Saved main.ts"),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
