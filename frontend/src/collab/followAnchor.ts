// M59: the "return to my location" anchor — navigation context ONLY. viewState
// is an opaque monaco.editor.ICodeEditorViewState token (cursor + selection +
// scroll + folding); it is NEVER model content. Held in a useRef in IDE.tsx,
// captured once per follow session, discarded on Stop/Return/reset.
export interface FollowAnchor {
  filePath: string;
  viewState: unknown;
  cursor: { line: number; column: number } | null;
  capturedAt: number;
}

export function anchorFilePresent(
  anchor: FollowAnchor,
  knownPaths: Iterable<string>,
): boolean {
  for (const p of knownPaths) if (p === anchor.filePath) return true;
  return false;
}

export function anchorFileBasename(anchor: FollowAnchor): string {
  const parts = anchor.filePath.split("/");
  return parts[parts.length - 1] || anchor.filePath;
}
