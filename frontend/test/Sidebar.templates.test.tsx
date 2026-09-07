import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import * as React from "react";
import type { Project, User, ProjectTemplate } from "../src/types";

const apiMock = vi.fn();
vi.mock("../src/api", () => ({
  api: (...args: any[]) => apiMock(...args),
}));

import Sidebar from "../src/components/Sidebar/Sidebar";

const TEMPLATES: ProjectTemplate[] = [
  {
    id: "python",
    name: "Python",
    description: "A minimal Python script with deterministic output",
    language: "python",
    entryFile: "main.py",
  },
  {
    id: "typescript",
    name: "TypeScript",
    description: "A minimal TypeScript program run with tsx",
    language: "typescript",
    entryFile: "main.ts",
  },
  {
    id: "static-web",
    name: "Static Web",
    description: "An HTML/CSS page served on the Preview tab",
    language: "node",
    entryFile: "main.js",
  },
  {
    id: "python-data",
    name: "Python Data Science",
    description: "Data analysis and computational routines in pure Python",
    language: "python",
    entryFile: "main.py",
  },
];

function baseProps(
  overrides: Partial<React.ComponentProps<typeof Sidebar>> = {},
) {
  const user: User = { id: 1, username: "alice" };
  const project: Project = { id: "proj-1", name: "My Project" };
  return {
    user,
    projects: [project],
    project,
    onSelectProject: vi.fn(),
    onCreateProject: vi.fn(),
    onProjectBootstrapped: vi.fn(),
    tree: [],
    onOpenFile: vi.fn(),
    activeFile: null,
    onLogout: vi.fn(),
    refreshTree: vi.fn(),
    ...overrides,
  };
}

// The catalog fetch is the first api() call every time the modal opens.
function mockCatalogResolves() {
  apiMock.mockImplementationOnce((path: string) => {
    expect(path).toBe("/api/projects/templates/catalog");
    return Promise.resolve({ templates: TEMPLATES });
  });
}

describe("Sidebar — runnable-by-default starter templates", () => {
  let noticeEvents: any[] = [];
  const captureNotice = (e: Event) =>
    noticeEvents.push((e as CustomEvent).detail);

  beforeEach(() => {
    apiMock.mockReset();
    noticeEvents = [];
    document.addEventListener("ide-notice", captureNotice);
  });

  afterEach(() => {
    document.removeEventListener("ide-notice", captureNotice);
    cleanup();
    vi.restoreAllMocks();
  });

  it("opens the modal and fetches the template catalog", async () => {
    mockCatalogResolves();
    const { getByTitle, getByText } = render(
      React.createElement(Sidebar, baseProps() as any),
    );
    fireEvent.click(getByTitle("Create New Project"));

    expect(apiMock).toHaveBeenCalledWith("/api/projects/templates/catalog");
    await waitFor(() => expect(getByText("Python Data Science")).toBeTruthy());
  });

  it("preselects the Python starter once the catalog loads; Blank is not selected", async () => {
    mockCatalogResolves();
    const { getByTitle, getByText } = render(
      React.createElement(Sidebar, baseProps() as any),
    );
    fireEvent.click(getByTitle("Create New Project"));

    await waitFor(() =>
      expect(
        getByText("Python").closest("button")!.getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    expect(
      getByText("Blank Project").closest("button")!.getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("Blank Project remains selectable and clears the preselected name", async () => {
    mockCatalogResolves();
    const { getByTitle, getByText, getByPlaceholderText } = render(
      React.createElement(Sidebar, baseProps() as any),
    );
    fireEvent.click(getByTitle("Create New Project"));
    await waitFor(() =>
      expect(
        getByText("Python").closest("button")!.getAttribute("aria-pressed"),
      ).toBe("true"),
    );

    fireEvent.click(getByText("Blank Project"));
    expect(
      getByText("Blank Project").closest("button")!.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      getByText("Python").closest("button")!.getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      (getByPlaceholderText("Project Name") as HTMLInputElement).value,
    ).toBe("");
  });

  it("changing selection between starters works and pre-fills the name", async () => {
    mockCatalogResolves();
    const { getByTitle, getByText, getByPlaceholderText } = render(
      React.createElement(Sidebar, baseProps() as any),
    );
    fireEvent.click(getByTitle("Create New Project"));
    await waitFor(() => expect(getByText("TypeScript")).toBeTruthy());

    fireEvent.click(getByText("TypeScript"));
    expect(
      getByText("TypeScript").closest("button")!.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      (getByPlaceholderText("Project Name") as HTMLInputElement).value,
    ).toBe("TypeScript");
  });

  it("creating the default Python starter POSTs from-template and hands the IDE its entry file", async () => {
    mockCatalogResolves();
    apiMock.mockResolvedValueOnce({
      project: { id: "proj-py", name: "Python" },
    });

    const props = baseProps();
    const { getByTitle, getByText } = render(
      React.createElement(Sidebar, props as any),
    );
    fireEvent.click(getByTitle("Create New Project"));
    await waitFor(() =>
      expect(
        getByText("Python").closest("button")!.getAttribute("aria-pressed"),
      ).toBe("true"),
    );

    fireEvent.click(getByText("Create"));

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    expect(apiMock).toHaveBeenNthCalledWith(2, "/api/projects/from-template", {
      method: "POST",
      body: JSON.stringify({ templateId: "python", name: "Python" }),
    });
    await waitFor(() =>
      expect(props.onProjectBootstrapped).toHaveBeenCalledWith(
        { id: "proj-py", name: "Python" },
        "main.py",
      ),
    );
    expect(props.onSelectProject).toHaveBeenCalledWith({
      id: "proj-py",
      name: "Python",
    });
  });

  it("blank path still POSTs /api/projects with the pre-existing body and no bootstrap hint", async () => {
    mockCatalogResolves();
    apiMock.mockResolvedValueOnce({
      project: { id: "proj-2", name: "Blank One" },
    });

    const props = baseProps();
    const { getByTitle, getByText, getByPlaceholderText } = render(
      React.createElement(Sidebar, props as any),
    );
    fireEvent.click(getByTitle("Create New Project"));
    await waitFor(() => expect(getByText("Python Data Science")).toBeTruthy());

    fireEvent.click(getByText("Blank Project"));
    fireEvent.change(getByPlaceholderText("Project Name"), {
      target: { value: "Blank One" },
    });
    fireEvent.click(getByText("Create"));

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    expect(apiMock).toHaveBeenNthCalledWith(2, "/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Blank One", language: "auto" }),
    });
    expect(props.onProjectBootstrapped).not.toHaveBeenCalled();
    await waitFor(() => expect(props.onCreateProject).toHaveBeenCalledTimes(1));
    expect(props.onSelectProject).toHaveBeenCalledWith({
      id: "proj-2",
      name: "Blank One",
    });
  });

  it("template path POSTs /api/projects/from-template with { templateId, name }", async () => {
    mockCatalogResolves();
    apiMock.mockResolvedValueOnce({
      project: { id: "proj-3", name: "Python Data Science" },
    });

    const { getByTitle, getByText } = render(
      React.createElement(Sidebar, baseProps() as any),
    );
    fireEvent.click(getByTitle("Create New Project"));
    await waitFor(() => expect(getByText("Python Data Science")).toBeTruthy());

    fireEvent.click(getByText("Python Data Science"));
    fireEvent.click(getByText("Create"));

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    expect(apiMock).toHaveBeenNthCalledWith(2, "/api/projects/from-template", {
      method: "POST",
      body: JSON.stringify({
        templateId: "python-data",
        name: "Python Data Science",
      }),
    });
  });

  it("does not fire a duplicate create request on a rapid double confirm", async () => {
    mockCatalogResolves();
    let resolveCreate: (v: any) => void = () => {};
    apiMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const props = baseProps();
    const { getByTitle, getByText } = render(
      React.createElement(Sidebar, props as any),
    );
    fireEvent.click(getByTitle("Create New Project"));
    await waitFor(() =>
      expect(
        getByText("Python").closest("button")!.getAttribute("aria-pressed"),
      ).toBe("true"),
    );

    const createButton = getByText("Create");
    fireEvent.click(createButton);
    fireEvent.click(createButton);

    resolveCreate({ project: { id: "proj-4", name: "Python" } });
    await waitFor(() => expect(props.onCreateProject).toHaveBeenCalledTimes(1));
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it("template catalog failure falls back to a usable Blank Project", async () => {
    apiMock.mockImplementationOnce(() =>
      Promise.reject(new Error("catalog unavailable")),
    );
    apiMock.mockResolvedValueOnce({
      project: { id: "proj-5", name: "Still Works" },
    });

    const props = baseProps();
    const { getByTitle, getByText, getByPlaceholderText } = render(
      React.createElement(Sidebar, props as any),
    );
    fireEvent.click(getByTitle("Create New Project"));

    await waitFor(() =>
      expect(getByText(/Templates unavailable/)).toBeTruthy(),
    );
    expect(
      getByText("Blank Project").closest("button")!.getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.change(getByPlaceholderText("Project Name"), {
      target: { value: "Still Works" },
    });
    fireEvent.click(getByText("Create"));

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    expect(apiMock).toHaveBeenNthCalledWith(2, "/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Still Works", language: "auto" }),
    });
  });

  it("a failed creation surfaces an error notice", async () => {
    mockCatalogResolves();
    apiMock.mockRejectedValueOnce(new Error("name already taken"));

    const props = baseProps();
    const { getByTitle, getByText } = render(
      React.createElement(Sidebar, props as any),
    );
    fireEvent.click(getByTitle("Create New Project"));
    await waitFor(() =>
      expect(
        getByText("Python").closest("button")!.getAttribute("aria-pressed"),
      ).toBe("true"),
    );

    fireEvent.click(getByText("Create"));

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        noticeEvents.some(
          (n) =>
            n.kind === "error" && /name already taken/.test(n.text ?? ""),
        ),
      ).toBe(true),
    );
    expect(props.onCreateProject).not.toHaveBeenCalled();
  });

  it("reopening the modal resets the selection back to the Python default", async () => {
    mockCatalogResolves();
    const { getByTitle, getByText, queryByText } = render(
      React.createElement(Sidebar, baseProps() as any),
    );
    fireEvent.click(getByTitle("Create New Project"));
    await waitFor(() => expect(getByText("TypeScript")).toBeTruthy());
    fireEvent.click(getByText("TypeScript"));
    expect(
      getByText("TypeScript").closest("button")!.getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(getByText("Cancel"));
    expect(queryByText("TypeScript")).toBeNull();

    mockCatalogResolves();
    fireEvent.click(getByTitle("Create New Project"));
    await waitFor(() =>
      expect(
        getByText("Python").closest("button")!.getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    expect(
      getByText("TypeScript").closest("button")!.getAttribute("aria-pressed"),
    ).toBe("false");
  });
});
