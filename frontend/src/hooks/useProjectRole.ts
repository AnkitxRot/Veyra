import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Project } from "../types";

/**
 * M68 — the project access-role lookup, isolated so it can FAIL CLOSED.
 *
 * `GET /api/projects/:id` returns the caller's effective role. Every failure
 * mode — network error, 5xx, an in-flight fetch, a role-less body — resolves to
 * the read-only `viewer` state. The role is only ever raised to `editor` /
 * `owner` by a response that explicitly says so. A stale response for a
 * previous project id is discarded. `retry()` re-runs the lookup and is inert
 * while one is already in flight (so a doubled Retry click is one request).
 *
 * Backend authorization is untouched; this only governs what the client is
 * willing to render before the server has confirmed access.
 */

export type ProjectRole = "owner" | "editor" | "viewer";
export type ProjectRoleStatus = "idle" | "loading" | "ready" | "error";

export interface UseProjectRole {
  /** `viewer` until a successful fetch says otherwise. */
  role: ProjectRole;
  status: ProjectRoleStatus;
  /** Re-run the lookup. No-op while a fetch is in flight. */
  retry: () => void;
}

function isRole(v: unknown): v is ProjectRole {
  return v === "owner" || v === "editor" || v === "viewer";
}

export function useProjectRole(projectId: string | null): UseProjectRole {
  const [role, setRole] = useState<ProjectRole>("viewer");
  const [status, setStatus] = useState<ProjectRoleStatus>("idle");
  // The request generation this hook currently cares about. Bumped on every
  // project switch and every retry; a resolved fetch whose generation is stale
  // is dropped.
  const genRef = useRef(0);
  const inFlightRef = useRef(false);

  const run = useCallback(
    (pid: string) => {
      if (inFlightRef.current) return;
      const gen = ++genRef.current;
      inFlightRef.current = true;
      setStatus("loading");
      setRole("viewer");
      api<{ project?: Project; role?: unknown }>(`/api/projects/${pid}`)
        .then((res) => {
          if (gen !== genRef.current) return;
          setRole(isRole(res.role) ? res.role : "viewer");
          setStatus("ready");
        })
        .catch(() => {
          if (gen !== genRef.current) return;
          setRole("viewer");
          setStatus("error");
        })
        .finally(() => {
          if (gen === genRef.current) inFlightRef.current = false;
        });
    },
    [],
  );

  useEffect(() => {
    if (!projectId) {
      genRef.current++;
      inFlightRef.current = false;
      setRole("viewer");
      setStatus("idle");
      return;
    }
    // A project switch supersedes any in-flight lookup.
    genRef.current++;
    inFlightRef.current = false;
    run(projectId);
  }, [projectId, run]);

  const retry = useCallback(() => {
    if (projectId) run(projectId);
  }, [projectId, run]);

  return { role, status, retry };
}
