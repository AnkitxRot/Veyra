import React from "react";

/**
 * M56: compact, read-only summary of which other collaborators are using a
 * file that a destructive operation (Git checkout, Replace All, workspace
 * restore/import) is about to overwrite.
 *
 * Privacy: shows identity + viewing/editing + an "unsaved changes" marker
 * ONLY when the collaborator's own client has actually reported a dirty bit
 * (`dirty === true`). "editing" with unknown dirty state is shown as
 * "editing this file" and MUST NOT imply unsaved work.
 */
export interface CollaboratorImpact {
  userId: number;
  username: string;
  path: string;
  editing: boolean;
  /** true / false / "unknown" — "unknown" is never rendered as "unsaved". */
  dirty: boolean | "unknown";
  color?: string;
}

export interface CollaboratorImpactNoticeProps {
  impacts: CollaboratorImpact[];
  /** Optional lead-in line, e.g. "This checkout affects files others have open:". */
  heading?: string;
  className?: string;
}

function initialsOf(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

export default function CollaboratorImpactNotice({
  impacts,
  heading,
  className,
}: CollaboratorImpactNoticeProps) {
  if (!impacts || impacts.length === 0) return null;

  const anyDirty = impacts.some((i) => i.dirty === true);

  return (
    <div
      className={`collab-impact-notice${anyDirty ? " has-dirty" : ""}${
        className ? ` ${className}` : ""
      }`}
      role="group"
      aria-label="Collaborators affected by this operation"
    >
      {heading ? <div className="collab-impact-heading">{heading}</div> : null}
      <ul className="collab-impact-list">
        {impacts.map((i) => {
          const fileName = i.path.split("/").pop() || i.path;
          const stateLabel =
            i.dirty === true
              ? "unsaved changes"
              : i.editing
                ? "editing"
                : "viewing";
          return (
            <li
              key={`${i.userId}:${i.path}`}
              className={`collab-impact-row${i.dirty === true ? " dirty" : ""}`}
            >
              <span
                className="collab-impact-avatar"
                style={
                  i.color
                    ? { background: i.color, borderColor: i.color }
                    : undefined
                }
                aria-hidden="true"
              >
                {initialsOf(i.username)}
              </span>
              <span className="collab-impact-name">{i.username}</span>
              <span className="collab-impact-sep">·</span>
              <span className="collab-impact-file" title={i.path}>
                {fileName}
              </span>
              <span
                className={`collab-impact-state${
                  i.dirty === true ? " unsaved" : ""
                }`}
              >
                {stateLabel}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
