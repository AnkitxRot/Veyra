import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import CollaboratorImpactNotice, {
  type CollaboratorImpact,
} from "../src/components/Collab/CollaboratorImpactNotice";

const base: CollaboratorImpact = {
  userId: 2,
  username: "Rahul",
  path: "auth/routes.ts",
  editing: false,
  dirty: "unknown",
};

afterEach(() => cleanup());

describe("CollaboratorImpactNotice — M56", () => {
  it("renders nothing for an empty impact list", () => {
    const { container } = render(<CollaboratorImpactNotice impacts={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows 'viewing' for a collaborator who is neither editing nor dirty", () => {
    const { getByText, queryByText } = render(
      <CollaboratorImpactNotice impacts={[base]} />,
    );
    expect(getByText("Rahul")).toBeTruthy();
    expect(getByText("viewing")).toBeTruthy();
    expect(queryByText(/unsaved/i)).toBeNull();
  });

  it("shows 'editing' — NOT 'unsaved' — when editing but dirty is unknown", () => {
    const { getByText, queryByText } = render(
      <CollaboratorImpactNotice
        impacts={[{ ...base, editing: true, dirty: "unknown" }]}
      />,
    );
    expect(getByText("editing")).toBeTruthy();
    expect(queryByText(/unsaved changes/i)).toBeNull();
  });

  it("shows 'unsaved changes' only when dirty is explicitly true", () => {
    const { getByText } = render(
      <CollaboratorImpactNotice
        impacts={[{ ...base, editing: true, dirty: true }]}
      />,
    );
    expect(getByText("unsaved changes")).toBeTruthy();
  });

  it("renders only identity + path + state — no content-ish leakage", () => {
    const { container } = render(
      <CollaboratorImpactNotice impacts={[{ ...base, dirty: true }]} />,
    );
    const text = container.textContent || "";
    expect(text).toContain("Rahul");
    expect(text).toContain("routes.ts");
    expect(text).not.toMatch(/password|secret|SELECT |function /i);
  });
});
