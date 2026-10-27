/** M104: explorer drag-and-drop move. Returns the destination path, or null if the drop is a no-op/invalid. */
export const DRAG_PATH_MIME = "application/x-veyra-path";

export function dropDestination(from: string, target: { path: string; type: "file" | "dir" } | null): string | null {
  const dirOf = (p: string) => p.split("/").slice(0, -1).join("/");
  const destDir = target === null ? "" : target.type === "dir" ? target.path : dirOf(target.path);
  if (destDir === from || destDir.startsWith(`${from}/`)) return null; // into itself/descendant
  if (destDir === dirOf(from)) return null; // same folder
  const name = from.split("/").pop()!;
  return destDir ? `${destDir}/${name}` : name;
}
