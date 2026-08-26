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
    id: "python-data",
    name: "Python Data Science",
    description: "Data analysis and computational routines in pure Python",
    language: "python",
  },
  {
    id: "cpp-systems",
    name: "C++ Systems & Algorithms",
    description: "High-performance modular C++17 project with GCC compiler",
    language: "cpp",
  },
  {
    id: "node-web",
    name: "Node.js Web Preview",
    description: "HTTP server with responsive frontend for live web previewing",
    language: "node",
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
    tree: [],
    onOpenFile: vi.fn(),
    activeFile: null,
    onLogout: vi.fn(),
    refreshTree: vi.fn(),
    ...overrides,
  };
}

// The catalog fetch is the first api() call every time the modal opens.
// Default to resolving with the full catalog; individual tests override
// via mockImplementationOnce/mockResolvedValueOnce before opening the modal.
function mockCatalogResolves() {
  apiMock.mockImplementationOnce((path: string) => {
    expect(path).toBe("/api/projects/templates/catalog");
    return Promise.resolve({ templates: TEMPLATES });
  });
}

describe("Sidebar — Milestone 35 Starter Project Templates UI", () => {
  beforeEach(() => {
    apiMock.mockReset();
    vi.spyOn(window, "alert").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("opens the create-project modal and fetches the template catalog", async () => {
    mockCatalogResolves();
    const props = baseProps();
    const { getByTitle, getByText } = render(
      React.createElement(Sidebar, props as any),
    );
    fireEvent.click(getByTitle("Create New Project"));

    expect(apiMock).toHaveBeenCalledWith("/api/projects/templates/catalog");
    await waitFor(() => expect(getByText("Python Data Science")).toBeTruthy());
  });

  it("renders all three templates plus Blank Project, which is selected by default", async () => {
    mockCatalogResolves();
    const props = baseProps();
    const { getByTitle, getByText } = render(
      React.createElement(Sidebar, props as any),
    );
    fireEvent.click(getByTitle("Create New Project"));

    await waitFor(() => expect(getByText("Python Data Science")).toBeTruthy());
    expect(getByText("C++ Systems & Algorithms")).toBeTruthy();
    expect(getByText("Node.js Web Preview")).toBeTruthy();

    const blankCard = getByText("Blank Project").closest("button")!;
    expect(blankCard.getAttribute("aria-pressed")).toBe("true");
  });

  it("selecting a template updates the selection and pre-fills the name field", async () => {
    mockCatalogResolves();
    const props = baseProps();
    const { getByTitle, getByText, getByPlaceholderText } = render(
      React.createElement(Sidebar, props as any),
    );
    fireEvent.click(getByTitle("Create New Project"));
    await waitFor(() => expect(getByText("Python Data Science")).toBeTruthy());

    fireEvent.click(getByText("Python Data Science"));

    const templateCard = getByText("Python Data Science").closest("button")!;
    const blankCard = getByText("Blank Project").closest("button")!;
    expect(templateCard.getAttribute("aria-pressed")).toBe("true");
    expect(blankCard.getAttribute("aria-pressed")).toBe("false");

    const nameInput = getByPlaceholderText("Project Name") as HTMLInputElement;
    expect(nameInput.value).toBe("Python Data Science");
  });

  it("the project name input is editable", async () => {
    mockCatalogResolves();
    const props = baseProps();
    const { getByTitle, getByText, getByPlaceholderText } = render(
      React.createElement(Sidebar, props as any),
    );
    fireEvent.click(getByTitle("Create New Project"));
    await waitFor(() => expect(getByText("Python Data Science")).toBeTruthy());

    const nameInput = getByPlaceholderText("Project Name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "My Custom Name" } });
    expect(nameInput.value).toBe("My Custom Name");
  });

  it("blank path POSTs /api/projects with the exact pre-existing body shape", async () => {
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

    fireEvent.change(getByPlaceholderText("Project Name"), {
      target: { value: "Blank One" },
    });
    fireEvent.click(getByText("Create"));

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    expect(apiMock).toHaveBeenNthCalledWith(2, "/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Blank One", language: "auto" }),
    });
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

    const props = baseProps();
    const { getByTitle, getByText } = render(
      React.createElement(Sidebar, props as any),
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
    await waitFor(() => expect(props.onCreateProject).toHaveBeenCalledTimes(1));
    expect(props.onSelectProject).toHaveBeenCalledWith({
      id: "proj-3",
      name: "Python Data Science",
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
    const { getByTitle, getByText, getByPlaceholderText } = render(
      React.createElement(Sidebar, props as any),
    );
    fireEvent.click(getByTitle("Create New Project"));
    await waitFor(() => expect(getByText("Python Data Science")).toBeTruthy());

    fireEvent.change(getByPlaceholderText("Project Name"), {
      target: { value: "Dup Test" },
    });
    const createButton = getByText("Create");
    fireEvent.click(createButton);
    fireEvent.click(createButton);

    resolveCreate({ project: { id: "proj-4", name: "Dup Test" } });
    await waitFor(() => expect(props.onCreateProject).toHaveBeenCalledTimes(1));
    // 1 catalog fetch + 1 create call, never 2 create calls.
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it("template catalog failure does not break blank project creation", async () => {
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
    // Blank Project card is still present and usable.
    expect(getByText("Blank Project")).toBeTruthy();

    fireEvent.change(getByPlaceholderText("Project Name"), {
      target: { value: "Still Works" },
    });
    fireEvent.click(getByText("Create"));

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    expect(apiMock).toHaveBeenNthCalledWith(2, "/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Still Works", language: "auto" }),
    });
    await waitFor(() => expect(props.onCreateProject).toHaveBeenCalledTimes(1));
  });

  it("a failed creation surfaces an error via the existing alert() convention", async () => {
    mockCatalogResolves();
    apiMock.mockRejectedValueOnce(new Error("name already taken"));

    const props = baseProps();
    const { getByTitle, getByText, getByPlaceholderText } = render(
      React.createElement(Sidebar, props as any),
    );
    fireEvent.click(getByTitle("Create New Project"));
    await waitFor(() => expect(getByText("Python Data Science")).toBeTruthy());

    fireEvent.change(getByPlaceholderText("Project Name"), {
      target: { value: "Dup Name" },
    });
    fireEvent.click(getByText("Create"));

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    expect(window.alert).toHaveBeenCalledWith(
      expect.stringContaining("name already taken"),
    );
    expect(props.onCreateProject).not.toHaveBeenCalled();
  });

  it("reopening the modal after a template was selected resets to Blank Project", async () => {
    mockCatalogResolves();
    const props = baseProps();
    const { getByTitle, getByText, queryByText } = render(
      React.createElement(Sidebar, props as any),
    );
    fireEvent.click(getByTitle("Create New Project"));
    await waitFor(() => expect(getByText("Python Data Science")).toBeTruthy());
    fireEvent.click(getByText("Python Data Science"));
    expect(
      getByText("Python Data Science")
        .closest("button")!
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(getByText("Cancel"));
    expect(queryByText("Python Data Science")).toBeNull();

    mockCatalogResolves();
    fireEvent.click(getByTitle("Create New Project"));
    await waitFor(() => expect(getByText("Python Data Science")).toBeTruthy());

    expect(
      getByText("Blank Project")
        .closest("button")!
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      getByText("Python Data Science")
        .closest("button")!
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });
});
