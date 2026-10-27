import { describe, it, expect } from "vitest";
import { dropDestination } from "../src/utils/dragMove";

describe("dropDestination", () => {
  it("moves into a folder, or beside a file target", () => {
    expect(dropDestination("a.txt", { path: "src", type: "dir" })).toBe("src/a.txt");
    expect(dropDestination("a.txt", { path: "src/b.ts", type: "file" })).toBe("src/a.txt");
    expect(dropDestination("x/a.txt", null)).toBe("a.txt");
  });
  it("rejects no-ops and cycles", () => {
    expect(dropDestination("src/a.txt", { path: "src", type: "dir" })).toBeNull();
    expect(dropDestination("src", { path: "src", type: "dir" })).toBeNull();
    expect(dropDestination("src", { path: "src/deep", type: "dir" })).toBeNull();
    expect(dropDestination("a.txt", null)).toBeNull();
  });
});
