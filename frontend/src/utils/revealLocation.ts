export interface RevealTarget {
  filePath: string;
  line: number;
  column?: number;
  /** Length of the text to select at the target position (search hits). */
  matchLength?: number;
}

/**
 * Open `target.filePath` as an editor tab (fetching + loading it if it is not
 * already open) and then dispatch the editor's `ide-reveal-location` event.
 *
 * The open MUST happen before the reveal: the Editor's `ide-reveal-location`
 * handler calls `setActiveFile`, which only switches among tabs that are
 * already open. Dispatching a reveal for a file that has no open tab is
 * silently dropped (Problems panel) or misapplied to whatever file is
 * currently active (Workspace Search). Awaiting the open here guarantees the
 * Editor has a loaded model to act on by the time the event fires.
 *
 * If the open fails (`openFile` rejects), the reveal is not dispatched.
 */
export async function openAndRevealLocation(
  openFile: (path: string) => Promise<void> | void,
  target: RevealTarget,
): Promise<void> {
  await openFile(target.filePath);
  document.dispatchEvent(
    new CustomEvent("ide-reveal-location", {
      detail: {
        filePath: target.filePath,
        line: target.line,
        column: target.column,
        matchLength: target.matchLength,
      },
    }),
  );
}
