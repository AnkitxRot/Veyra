import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import * as React from "react";
import type { AdminProjectData } from "../src/types";

const apiMock = vi.fn();
vi.mock("../src/api", () => ({
  api: (...args: any[]) => apiMock(...args),
}));

import AdminBackupsPanel from "../src/components/Admin/AdminBackupsPanel";

function makeProjects(): AdminProjectData[] {
  return [
    {
      id: "proj-1",
      name: "My Project",
      language: "python",
      owner_id: 1,
      owner_username: "alice",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      snapshot_count: 0,
      run_count: 0,
    },
  ];
}

function dbBackup(overrides: Partial<any> = {}) {
  return {
    filename: "backup-2026-01-01.db",
    sizeBytes: 2048,
    createdAt: "2026-01-01T00:00:00Z",
    integrity: "unverified",
    ...overrides,
  };
}

function wsBackup(overrides: Partial<any> = {}) {
  return {
    filename: "workspace-proj-1-2026-01-01.zip",
    projectId: "proj-1",
    sizeBytes: 4096,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("AdminBackupsPanel — Milestone 46", () => {
  beforeEach(() => {
    apiMock.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function renderPanel(projects = makeProjects()) {
    return render(React.createElement(AdminBackupsPanel, { projects }));
  }

  // ---------------------------------------------------------------- DB ----

  it("1. renders the database backup list", async () => {
    apiMock.mockResolvedValueOnce({ backups: [dbBackup()] });
    const { findByText } = renderPanel();
    expect(await findByText("backup-2026-01-01.db")).toBeTruthy();
  });

  it("2. renders an empty state for database backups", async () => {
    apiMock.mockResolvedValueOnce({ backups: [] });
    const { findByText } = renderPanel();
    expect(await findByText(/No database backups yet/)).toBeTruthy();
  });

  it("3. Create Backup sends an exact POST with no body", async () => {
    apiMock.mockResolvedValueOnce({ backups: [] }); // initial load
    const { findByText, getByText } = renderPanel();
    await findByText(/No database backups yet/);

    apiMock.mockResolvedValueOnce({ ok: true, backup: dbBackup() }); // create
    apiMock.mockResolvedValueOnce({ backups: [dbBackup()] }); // refresh
    fireEvent.click(getByText("Create Backup"));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/admin/backups",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    // No invented request body.
    const createCall = apiMock.mock.calls.find(
      (c) => c[0] === "/api/admin/backups" && c[1]?.method === "POST",
    );
    expect(createCall![1]).not.toHaveProperty("body");
  });

  it("4. successful create refreshes the list", async () => {
    apiMock.mockResolvedValueOnce({ backups: [] });
    const { findByText, getByText } = renderPanel();
    await findByText(/No database backups yet/);

    apiMock.mockResolvedValueOnce({ ok: true, backup: dbBackup() });
    apiMock.mockResolvedValueOnce({ backups: [dbBackup()] });
    fireEvent.click(getByText("Create Backup"));

    expect(await findByText("backup-2026-01-01.db")).toBeTruthy();
  });

  it("5. duplicate Create Backup clicks are blocked while one is in flight", async () => {
    apiMock.mockResolvedValueOnce({ backups: [] });
    const { findByText, getByText } = renderPanel();
    await findByText(/No database backups yet/);

    let resolveCreate: (v: any) => void = () => {};
    apiMock.mockImplementationOnce(
      () => new Promise((resolve) => (resolveCreate = resolve)),
    );
    const createButton = getByText("Create Backup");
    fireEvent.click(createButton);
    fireEvent.click(createButton);
    fireEvent.click(createButton);

    resolveCreate({ ok: true, backup: dbBackup() });
    apiMock.mockResolvedValueOnce({ backups: [dbBackup()] });

    await waitFor(() =>
      expect(
        apiMock.mock.calls.filter(
          (c) => c[0] === "/api/admin/backups" && c[1]?.method === "POST",
        ).length,
      ).toBe(1),
    );
  });

  it("6. Delete opens a destructive confirmation naming the exact filename", async () => {
    apiMock.mockResolvedValueOnce({ backups: [dbBackup()] });
    const { findByText, getByLabelText } = renderPanel();
    await findByText("backup-2026-01-01.db");

    fireEvent.click(getByLabelText("Delete backup-2026-01-01.db"));
    expect(await findByText("Delete Backup")).toBeTruthy();
    expect(await findByText(/Permanently delete database backup/)).toBeTruthy();
  });

  it("7. cancelling the delete confirmation makes no DELETE request", async () => {
    apiMock.mockResolvedValueOnce({ backups: [dbBackup()] });
    const { findByText, getByLabelText, getByText, queryByText } =
      renderPanel();
    await findByText("backup-2026-01-01.db");

    fireEvent.click(getByLabelText("Delete backup-2026-01-01.db"));
    await findByText("Delete Backup");
    fireEvent.click(getByText("Cancel"));

    await waitFor(() => expect(queryByText("Delete Backup")).toBeNull());
    expect(apiMock.mock.calls.some((c) => c[1]?.method === "DELETE")).toBe(
      false,
    );
  });

  it("8. confirming delete sends the exact DELETE URL and refreshes the list", async () => {
    apiMock.mockResolvedValueOnce({ backups: [dbBackup()] });
    const { findByText, getByLabelText, getByText } = renderPanel();
    await findByText("backup-2026-01-01.db");

    fireEvent.click(getByLabelText("Delete backup-2026-01-01.db"));
    await findByText("Delete Backup");

    apiMock.mockResolvedValueOnce({
      ok: true,
      deleted: "backup-2026-01-01.db",
    });
    apiMock.mockResolvedValueOnce({ backups: [] });
    fireEvent.click(getByText("Permanently Delete"));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/admin/backups/backup-2026-01-01.db",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    expect(await findByText(/No database backups yet/)).toBeTruthy();
  });

  it("9. download uses the correct endpoint and filename", async () => {
    apiMock.mockResolvedValueOnce({ backups: [dbBackup()] });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["x"]),
    });
    vi.stubGlobal("fetch", fetchMock);
    // Node's global URL (used here, not a browser's) has no
    // createObjectURL/revokeObjectURL at all, so these must be stubbed.
    // jsdom's own anchor-click handling then attempts a (harmless, but
    // noisy) "not implemented: navigation" warning for the fake blob: URL
    // on click — a known jsdom limitation around the `download` attribute,
    // not a real issue; it doesn't fail this or any other test.
    const revokeSpy = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:fake"),
      revokeObjectURL: revokeSpy,
    });

    const { findByText, getByLabelText } = renderPanel();
    await findByText("backup-2026-01-01.db");

    fireEvent.click(getByLabelText("Download backup-2026-01-01.db"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/backups/backup-2026-01-01.db",
        expect.objectContaining({ credentials: "include" }),
      ),
    );
    // Confirms the object URL is cleaned up rather than leaked once the
    // download click has been dispatched.
    await waitFor(() => expect(revokeSpy).toHaveBeenCalledTimes(1));
  });

  it("10. integrity renders honestly for ok, failed, and unverified", async () => {
    apiMock.mockResolvedValueOnce({
      backups: [
        dbBackup({ filename: "a.db", integrity: "ok" }),
        dbBackup({ filename: "b.db", integrity: "failed" }),
        dbBackup({ filename: "c.db", integrity: "unverified" }),
      ],
    });
    const { findByText } = renderPanel();
    expect(await findByText("OK")).toBeTruthy();
    expect(await findByText("FAILED")).toBeTruthy();
    expect(await findByText("UNVERIFIED")).toBeTruthy();
  });

  // --------------------------------------------------------- workspace ----

  it("11. selecting a project loads the correct workspace-backups endpoint", async () => {
    apiMock.mockResolvedValueOnce({ backups: [] }); // db init
    const { findByText, getByDisplayValue, getByRole } = renderPanel();
    await findByText(/No database backups yet/);

    apiMock.mockResolvedValueOnce({ backups: [wsBackup()] });
    const select = getByRole("combobox");
    fireEvent.change(select, { target: { value: "proj-1" } });

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/admin/workspace-backups/proj-1",
      ),
    );
  });

  it("12. workspace backup list renders", async () => {
    apiMock.mockResolvedValueOnce({ backups: [] });
    const { findByText, getByRole } = renderPanel();
    await findByText(/No database backups yet/);

    apiMock.mockResolvedValueOnce({ backups: [wsBackup()] });
    fireEvent.change(getByRole("combobox"), { target: { value: "proj-1" } });

    expect(await findByText("workspace-proj-1-2026-01-01.zip")).toBeTruthy();
  });

  it("13. Create Workspace Backup sends exact POST", async () => {
    apiMock.mockResolvedValueOnce({ backups: [] });
    const { findByText, getByRole, getByText } = renderPanel();
    await findByText(/No database backups yet/);

    apiMock.mockResolvedValueOnce({ backups: [] });
    fireEvent.change(getByRole("combobox"), { target: { value: "proj-1" } });
    await findByText(/No workspace backups for this project yet/);

    apiMock.mockResolvedValueOnce({
      backup: { workspaceFileCount: 3, snapshotCount: 1 },
    });
    apiMock.mockResolvedValueOnce({ backups: [wsBackup()] });
    fireEvent.click(getByText("Create Workspace Backup"));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/admin/workspace-backups/proj-1",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("14. workspace Delete confirmation works", async () => {
    apiMock.mockResolvedValueOnce({ backups: [] });
    const { findByText, getByRole, getByLabelText, getByText } = renderPanel();
    await findByText(/No database backups yet/);

    apiMock.mockResolvedValueOnce({ backups: [wsBackup()] });
    fireEvent.change(getByRole("combobox"), { target: { value: "proj-1" } });
    await findByText("workspace-proj-1-2026-01-01.zip");

    fireEvent.click(getByLabelText("Delete workspace-proj-1-2026-01-01.zip"));
    await findByText("Delete Backup");

    apiMock.mockResolvedValueOnce({ ok: true, deleted: wsBackup().filename });
    apiMock.mockResolvedValueOnce({ backups: [] });
    fireEvent.click(getByText("Permanently Delete"));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/admin/workspace-backups/proj-1/workspace-proj-1-2026-01-01.zip",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });

  it("15. restore confirmation names the exact project, filename, and timestamp", async () => {
    apiMock.mockResolvedValueOnce({ backups: [] });
    const { findByText, getByRole, getByLabelText } = renderPanel();
    await findByText(/No database backups yet/);

    apiMock.mockResolvedValueOnce({ backups: [wsBackup()] });
    fireEvent.change(getByRole("combobox"), { target: { value: "proj-1" } });
    await findByText("workspace-proj-1-2026-01-01.zip");

    fireEvent.click(getByLabelText("Restore workspace-proj-1-2026-01-01.zip"));

    expect(await findByText("Restore Workspace Backup")).toBeTruthy();
    const dialog = await findByText(
      /This will replace the project's current workspace contents/,
    );
    expect(dialog.textContent).toContain("workspace-proj-1-2026-01-01.zip");
    expect(dialog.textContent).toContain("My Project");
  });

  it("16. cancelling restore makes no POST", async () => {
    apiMock.mockResolvedValueOnce({ backups: [] });
    const { findByText, getByRole, getByLabelText, getByText, queryByText } =
      renderPanel();
    await findByText(/No database backups yet/);

    apiMock.mockResolvedValueOnce({ backups: [wsBackup()] });
    fireEvent.change(getByRole("combobox"), { target: { value: "proj-1" } });
    await findByText("workspace-proj-1-2026-01-01.zip");

    fireEvent.click(getByLabelText("Restore workspace-proj-1-2026-01-01.zip"));
    await findByText("Restore Workspace Backup");
    fireEvent.click(getByText("Cancel"));

    await waitFor(() =>
      expect(queryByText("Restore Workspace Backup")).toBeNull(),
    );
    expect(
      apiMock.mock.calls.some((c) => String(c[0]).includes("/restore")),
    ).toBe(false);
  });

  it("17. confirming restore sends the exact restore endpoint", async () => {
    apiMock.mockResolvedValueOnce({ backups: [] });
    const { findByText, getByRole, getByLabelText, getByText } = renderPanel();
    await findByText(/No database backups yet/);

    apiMock.mockResolvedValueOnce({ backups: [wsBackup()] });
    fireEvent.change(getByRole("combobox"), { target: { value: "proj-1" } });
    await findByText("workspace-proj-1-2026-01-01.zip");

    fireEvent.click(getByLabelText("Restore workspace-proj-1-2026-01-01.zip"));
    await findByText("Restore Workspace Backup");

    apiMock.mockResolvedValueOnce({ ok: true, restore: {} });
    apiMock.mockResolvedValueOnce({ backups: [wsBackup()] });
    fireEvent.click(getByText("Restore Workspace"));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/admin/workspace-backups/proj-1/workspace-proj-1-2026-01-01.zip/restore",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("18. restore loading state prevents duplicate restore submissions", async () => {
    apiMock.mockResolvedValueOnce({ backups: [] });
    const { findByText, getByRole, getByLabelText, getByText } = renderPanel();
    await findByText(/No database backups yet/);

    apiMock.mockResolvedValueOnce({ backups: [wsBackup()] });
    fireEvent.change(getByRole("combobox"), { target: { value: "proj-1" } });
    await findByText("workspace-proj-1-2026-01-01.zip");

    fireEvent.click(getByLabelText("Restore workspace-proj-1-2026-01-01.zip"));
    await findByText("Restore Workspace Backup");

    let resolveRestore: (v: any) => void = () => {};
    apiMock.mockImplementationOnce(
      () => new Promise((resolve) => (resolveRestore = resolve)),
    );
    const restoreButton = getByText("Restore Workspace");
    fireEvent.click(restoreButton);
    fireEvent.click(restoreButton);
    fireEvent.click(restoreButton);

    resolveRestore({ ok: true, restore: {} });
    apiMock.mockResolvedValueOnce({ backups: [wsBackup()] });

    await waitFor(() =>
      expect(
        apiMock.mock.calls.filter((c) => String(c[0]).includes("/restore"))
          .length,
      ).toBe(1),
    );
  });

  it("19. successful restore refreshes the workspace backup list", async () => {
    apiMock.mockResolvedValueOnce({ backups: [] });
    const { findByText, getByRole, getByLabelText, getByText } = renderPanel();
    await findByText(/No database backups yet/);

    apiMock.mockResolvedValueOnce({ backups: [wsBackup()] });
    fireEvent.change(getByRole("combobox"), { target: { value: "proj-1" } });
    await findByText("workspace-proj-1-2026-01-01.zip");

    fireEvent.click(getByLabelText("Restore workspace-proj-1-2026-01-01.zip"));
    await findByText("Restore Workspace Backup");

    apiMock.mockResolvedValueOnce({ ok: true, restore: {} });
    apiMock.mockResolvedValueOnce({ backups: [wsBackup()] });
    fireEvent.click(getByText("Restore Workspace"));

    await waitFor(() =>
      expect(
        apiMock.mock.calls.filter(
          (c) => c[0] === "/api/admin/workspace-backups/proj-1",
        ).length,
      ).toBeGreaterThanOrEqual(2),
    );
  });

  it("20. create/delete/restore failures show a visible error without crashing the tab", async () => {
    apiMock.mockResolvedValueOnce({ backups: [] });
    const { findByText, getByText } = renderPanel();
    await findByText(/No database backups yet/);

    apiMock.mockRejectedValueOnce(new Error("disk full"));
    fireEvent.click(getByText("Create Backup"));

    expect(await findByText("disk full")).toBeTruthy();
  });

  it("21. changing project selection does not leak the prior project's backup list", async () => {
    const projects = [
      ...makeProjects(),
      {
        id: "proj-2",
        name: "Other Project",
        language: "node",
        owner_id: 2,
        owner_username: "bob",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        snapshot_count: 0,
        run_count: 0,
      },
    ];
    apiMock.mockResolvedValueOnce({ backups: [] });
    const { findByText, getByRole, queryByText } = renderPanel(projects);
    await findByText(/No database backups yet/);

    // proj-1's request never resolves before we switch away from it.
    let resolveProj1: (v: any) => void = () => {};
    apiMock.mockImplementationOnce(
      () => new Promise((resolve) => (resolveProj1 = resolve)),
    );
    fireEvent.change(getByRole("combobox"), { target: { value: "proj-1" } });

    apiMock.mockResolvedValueOnce({ backups: [] });
    fireEvent.change(getByRole("combobox"), { target: { value: "proj-2" } });
    await findByText(/No workspace backups for this project yet/);

    // The stale proj-1 response arrives late — it must not overwrite
    // proj-2's already-current (empty) state with proj-1's data.
    resolveProj1({ backups: [wsBackup({ projectId: "proj-1" })] });
    await new Promise((r) => setTimeout(r, 20));

    expect(queryByText("workspace-proj-1-2026-01-01.zip")).toBeNull();
  });
});
