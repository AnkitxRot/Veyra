import React, { Suspense, useEffect, useMemo, useRef } from "react";
import type { EditorProps } from "../Editor/Editor";
import {
  MAIN_GROUP,
  mainPaths,
  type EditorGroupsState,
  type GroupsAction,
} from "../../editorGroups";

const Editor = React.lazy(() => import("../Editor/Editor"));

type OpenFile = { path: string; content: string; dirty?: boolean };

export type EditorGroupsViewProps = EditorProps & {
  groups: EditorGroupsState;
  dispatch: React.Dispatch<GroupsAction>;
};

const TAB_MIME = "application/x-veyra-tab";

/**
 * Applies a subset-scoped state update to the global open-files list: edits
 * to entries in the subset are merged, removals drop the entry, additions are
 * appended. Entries outside the subset are untouched.
 */
export function mergeSubsetUpdate(
  prev: OpenFile[],
  inSubset: (path: string) => boolean,
  updater: (sub: OpenFile[]) => OpenFile[],
): OpenFile[] {
  const sub = prev.filter((f) => inSubset(f.path));
  const next = updater(sub);
  const byPath = new Map(next.map((f) => [f.path, f]));
  const merged: OpenFile[] = [];
  for (const f of prev) {
    if (!inSubset(f.path)) merged.push(f);
    else if (byPath.has(f.path)) merged.push(byPath.get(f.path)!);
  }
  for (const f of next) if (!prev.some((p) => p.path === f.path)) merged.push(f);
  return merged;
}

export default function EditorGroupsView({ groups, dispatch, ...editorProps }: EditorGroupsViewProps) {
  const { openFiles, setOpenFiles, activeFile, setActiveFile } = editorProps;
  const allPaths = useMemo(() => openFiles.map((f: OpenFile) => f.path), [openFiles]);
  const main = useMemo(() => mainPaths(allPaths, groups), [allPaths, groups]);

  useEffect(() => {
    dispatch({ type: "reconcile", open: allPaths });
  }, [allPaths, dispatch]);

  // The Editor re-creates Monaco whenever its setOpenFiles identity changes,
  // so each group's wrapper must be stable; live membership is read via a ref.
  const membership = useRef<Record<string, Set<string>>>({});
  const wrappers = useRef(new Map<string, React.Dispatch<React.SetStateAction<any[]>>>());
  const wrapperFor = (groupId: string) => {
    let fn = wrappers.current.get(groupId);
    if (!fn) {
      fn = (action) =>
        setOpenFiles((prev: OpenFile[]) =>
          mergeSubsetUpdate(prev, (p) => membership.current[groupId]?.has(p) ?? false, (sub) =>
            typeof action === "function" ? (action as (s: OpenFile[]) => OpenFile[])(sub) : (action as OpenFile[]),
          ),
        );
      wrappers.current.set(groupId, fn);
    }
    return fn;
  };

  const mainSet = useMemo(() => new Set(main), [main]);
  membership.current[MAIN_GROUP] = mainSet;
  for (const g of groups.extras) membership.current[g.id] = new Set(g.tabs);
  const mainActive =
    activeFile && mainSet.has(activeFile) ? activeFile : (main[main.length - 1] ?? null);

  const dropProps = (groupId: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes(TAB_MIME)) e.preventDefault();
    },
    onDrop: (e: React.DragEvent) => {
      const raw = e.dataTransfer.getData(TAB_MIME);
      if (!raw) return;
      e.preventDefault();
      try {
        const { path, from } = JSON.parse(raw) as { path: string; from: string };
        if (from === groupId) return;
        dispatch({ type: "move", path, to: groupId });
        setActiveFile(path);
      } catch {
        /* malformed drag payload */
      }
    },
  });

  const row = groups.direction === "right";
  const fallback = <div className="editor-group-loading" />;

  return (
    <div
      className="editor-groups"
      style={{ display: "flex", flexDirection: row ? "row" : "column", height: "100%", width: "100%" }}
    >
      <div className="editor-group" style={{ flex: 1, minWidth: 0, minHeight: 0, position: "relative" }} {...dropProps(MAIN_GROUP)}>
        <Suspense fallback={fallback}>
          <Editor
            {...editorProps}
            openFiles={openFiles.filter((f: OpenFile) => mainSet.has(f.path))}
            setOpenFiles={wrapperFor(MAIN_GROUP)}
            activeFile={mainActive}
            setActiveFile={setActiveFile}
            retainPaths={allPaths}
            groupId={MAIN_GROUP}
          />
        </Suspense>
      </div>
      {groups.extras.map((g) => {
        const tabSet = new Set(g.tabs);
        return (
          <div
            key={g.id}
            className="editor-group editor-group-extra"
            style={{ flex: 1, minWidth: 0, minHeight: 0, position: "relative" }}
            {...dropProps(g.id)}
          >
            <button
              type="button"
              className="editor-group-close"
              title="Close editor group (tabs return to the main group)"
              aria-label="Close editor group"
              onClick={() => dispatch({ type: "closeGroup", id: g.id })}
            >
              ×
            </button>
            <Suspense fallback={fallback}>
              <Editor
                {...editorProps}
                secondary
                collabClient={null}
                liveApiRef={undefined}
                editorViewApiRef={undefined}
                openFiles={openFiles.filter((f: OpenFile) => tabSet.has(f.path))}
                setOpenFiles={wrapperFor(g.id)}
                activeFile={g.active}
                setActiveFile={(p) => {
                  dispatch({ type: "activate", group: g.id, path: p });
                  if (p) setActiveFile(p);
                }}
                groupId={g.id}
              />
            </Suspense>
          </div>
        );
      })}
    </div>
  );
}
