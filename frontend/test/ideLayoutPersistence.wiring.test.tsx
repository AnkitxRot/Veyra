import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ide = readFileSync(
  join(here, "../src/components/IDE/IDE.tsx"),
  "utf-8",
);

/**
 * M67 — the four user-scoped IDE layout dimensions are persisted through the
 * typed user_preferences store via `useLayoutPreferences`. The hook's own
 * behaviour is covered in useLayoutPreferences.test.tsx; these are wiring
 * guards for its integration into the ~3700-line IDE.tsx (rendering that whole
 * component in a test is not the house style).
 */
describe("M67 — IDE layout persistence wiring", () => {
  it("the four layout values come from useLayoutPreferences, not raw useState", () => {
    expect(ide).toContain("} = useLayoutPreferences(layoutLoaded, persistLayout);");
    expect(ide).not.toContain("const [sidebarWidth, setSidebarWidth] = useState");
    expect(ide).not.toContain("const [bottomHeight, setBottomHeight] = useState");
    expect(ide).not.toContain(
      "const [isSidebarHidden, setIsSidebarHidden] = useState",
    );
    expect(ide).not.toContain(
      "const [isBottomCollapsed, setIsBottomCollapsed] = useState",
    );
  });

  it("hydration is gated on the preferences actually having loaded", () => {
    expect(ide).toContain("setPreferencesLoaded(true);");
    const at = ide.indexOf("const layoutLoaded = useMemo");
    expect(at).toBeGreaterThan(-1);
    const block = ide.slice(at, at + 500);
    expect(block).toContain("preferencesLoaded");
    expect(block).toContain("preferences.sidebarWidth");
    expect(block).toContain("preferences.bottomCollapsed");
    expect(block).toContain(": null");
  });

  it("a completed drag persists exactly once, on mouse-up — never per mousemove", () => {
    const upAt = ide.indexOf("const handleMouseUp = () => {");
    const upBlock = ide.slice(upAt, upAt + 320);
    expect(upBlock).toContain("if (isDraggingSidebar) persistSidebarWidth();");
    expect(upBlock).toContain("if (isDraggingBottom) persistBottomHeight();");

    const moveAt = ide.indexOf("const handleMouseMove = (e: MouseEvent) => {");
    const moveBlock = ide.slice(moveAt, ide.indexOf("};", moveAt));
    // the mousemove path only updates local state
    expect(moveBlock).not.toContain("persistSidebarWidth");
    expect(moveBlock).not.toContain("persistBottomHeight");
    expect(moveBlock).not.toContain("persistLayout");
  });

  it("persistLayout routes through the existing preference PUT and keeps failures silent", () => {
    const at = ide.indexOf("const persistLayout = useCallback(");
    const block = ide.slice(at, at + 360);
    expect(block).toContain("handleUpdatePreferences(patch)");
    expect(block).toContain(".catch(");
  });
});
