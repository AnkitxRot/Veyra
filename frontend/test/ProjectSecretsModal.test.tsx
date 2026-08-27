import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import * as React from "react";
import ProjectSecretsModal from "../src/components/ProjectSecrets/ProjectSecretsModal";

const META = [
  {
    name: "API_KEY",
    environment: null,
    isSecret: true,
    fingerprint: "z999",
    createdBy: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastUsedAt: null,
  },
  {
    name: "NODE_ENV",
    environment: "prod",
    isSecret: false,
    fingerprint: null,
    createdBy: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastUsedAt: null,
  },
];

function jsonResponse(body: any, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
  });
}

function renderModal() {
  return render(
    <ProjectSecretsModal
      projectId="p1"
      projectName="Demo"
      isOpen
      onClose={() => {}}
    />,
  );
}

describe("ProjectSecretsModal", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((url: string, opts?: any) => {
      const method = opts?.method ?? "GET";
      if (url.endsWith("/secrets") && method === "GET") {
        return jsonResponse({ secrets: META });
      }
      if (url.endsWith("/secrets") && method === "POST") {
        return jsonResponse({ secret: META[0] }, true, 201);
      }
      if (method === "PUT") return jsonResponse({ secret: META[0] });
      if (method === "DELETE") return jsonResponse({ ok: true });
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists secret metadata with a type badge and no value", async () => {
    const { getByText, queryByText, findByText } = renderModal();
    await findByText("API_KEY");
    expect(getByText("NODE_ENV")).toBeTruthy();
    expect(getByText("prod")).toBeTruthy();
    // secret vs config distinction
    expect(getByText("Secret")).toBeTruthy();
    expect(getByText("Config")).toBeTruthy();
    // fingerprint shown, raw value never
    expect(getByText("z999")).toBeTruthy();
    expect(queryByText("supersecret")).toBeNull();
  });

  it("creates a secret and clears the value input afterward", async () => {
    const { getByLabelText, getByText, findByText } = renderModal();
    await findByText("API_KEY");

    fireEvent.change(getByLabelText("Secret name"), {
      target: { value: "NEW_KEY" },
    });
    const valueInput = getByLabelText("Secret value") as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: "topsecretvalue" } });
    fireEvent.click(getByText("Add"));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) => c[1]?.method === "POST" && String(c[0]).endsWith("/secrets"),
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(call![1].body)).toMatchObject({
        name: "NEW_KEY",
        value: "topsecretvalue",
        isSecret: true,
      });
    });
    // value input reset — never retained
    await waitFor(() => expect(valueInput.value).toBe(""));
  });

  it("uses a password field for secret values", async () => {
    const { getByLabelText, findByText } = renderModal();
    await findByText("API_KEY");
    expect((getByLabelText("Secret value") as HTMLInputElement).type).toBe(
      "password",
    );
  });

  it("rejects an invalid name without calling the API", async () => {
    const { getByLabelText, getByText, findByText } = renderModal();
    await findByText("API_KEY");
    fireEvent.change(getByLabelText("Secret name"), {
      target: { value: "bad name" },
    });
    fireEvent.change(getByLabelText("Secret value"), {
      target: { value: "x" },
    });
    fireEvent.click(getByText("Add"));
    await waitFor(() => expect(getByText(/Name must be/i)).toBeTruthy());
    expect(
      fetchMock.mock.calls.filter((c) => c[1]?.method === "POST").length,
    ).toBe(0);
  });

  it("updates a secret value via PUT", async () => {
    const { getAllByText, getByLabelText, getByText, findByText } =
      renderModal();
    await findByText("API_KEY");
    fireEvent.click(getAllByText("Update")[0]);
    fireEvent.change(getByLabelText("New value for API_KEY"), {
      target: { value: "rotated" },
    });
    fireEvent.click(getByText("Save"));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
      expect(put).toBeTruthy();
      expect(String(put![0])).toContain("/secrets/API_KEY");
      expect(JSON.parse(put![1].body)).toMatchObject({ value: "rotated" });
    });
  });

  it("confirms before deleting and calls DELETE", async () => {
    const { getAllByLabelText, findByText } = renderModal();
    await findByText("API_KEY");
    fireEvent.click(getAllByLabelText(/^Delete /)[0]);
    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalled();
      const del = fetchMock.mock.calls.find((c) => c[1]?.method === "DELETE");
      expect(del).toBeTruthy();
      expect(String(del![0])).toContain("/secrets/API_KEY");
    });
  });

  it("surfaces a server error on create", async () => {
    fetchMock.mockImplementation((url: string, opts?: any) => {
      if ((opts?.method ?? "GET") === "GET")
        return jsonResponse({ secrets: META });
      return jsonResponse(
        { error: { message: "a secret with this name already exists" } },
        false,
        409,
      );
    });
    const { getByLabelText, getByText, findByText } = renderModal();
    await findByText("API_KEY");
    fireEvent.change(getByLabelText("Secret name"), {
      target: { value: "API_KEY" },
    });
    fireEvent.change(getByLabelText("Secret value"), {
      target: { value: "x" },
    });
    fireEvent.click(getByText("Add"));
    await waitFor(() => expect(getByText(/already exists/i)).toBeTruthy());
  });

  it("guards against duplicate in-flight requests", async () => {
    let resolvePost: () => void = () => {};
    fetchMock.mockImplementation((url: string, opts?: any) => {
      const method = opts?.method ?? "GET";
      if (method === "GET") return jsonResponse({ secrets: META });
      if (method === "POST") {
        return new Promise((r) => {
          resolvePost = () => r({ ok: true, status: 201, json: () => Promise.resolve({ secret: META[0] }) });
        });
      }
      return jsonResponse({});
    });
    const { getByLabelText, getByText, findByText } = renderModal();
    await findByText("API_KEY");
    fireEvent.change(getByLabelText("Secret name"), {
      target: { value: "FAST_KEY" },
    });
    fireEvent.change(getByLabelText("Secret value"), {
      target: { value: "fastval" },
    });
    const addBtn = getByText("Add");
    fireEvent.click(addBtn);
    fireEvent.click(addBtn); // duplicate rapid click
    expect(
      fetchMock.mock.calls.filter((c) => c[1]?.method === "POST").length,
    ).toBe(1);
    resolvePost();
  });
});
