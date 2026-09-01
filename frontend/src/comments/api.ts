import { api } from "../api";
import type { CommentThreadDTO } from "../types";
import type { AnchorPayload } from "./anchor";

/**
 * M61-A comment REST client. Every write derives identity + project scope on
 * the server; the client only supplies content and anchor coordinates.
 */

export type ThreadStatusFilter = "active" | "resolved" | "all";

export interface ThreadListResponse {
  threads: CommentThreadDTO[];
  nextBefore: string | null;
}

const base = (projectId: string) => `/api/projects/${projectId}/comments`;

export function fetchThreads(
  projectId: string,
  file: string | null,
  status: ThreadStatusFilter = "active",
): Promise<ThreadListResponse> {
  const params = new URLSearchParams();
  if (file) params.set("file", file);
  params.set("status", status);
  return api<ThreadListResponse>(`${base(projectId)}?${params.toString()}`);
}

export function createThread(
  projectId: string,
  input: {
    filePath: string;
    anchor: AnchorPayload;
    body: string;
    mentions: number[];
  },
): Promise<{ thread: CommentThreadDTO }> {
  return api(`${base(projectId)}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function addReply(
  projectId: string,
  threadId: string,
  input: { body: string; mentions: number[] },
): Promise<{ thread: CommentThreadDTO }> {
  return api(`${base(projectId)}/${threadId}/replies`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function editComment(
  projectId: string,
  commentId: string,
  input: { body: string; mentions?: number[] },
): Promise<{ thread: CommentThreadDTO }> {
  return api(`${base(projectId)}/${commentId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteComment(
  projectId: string,
  commentId: string,
): Promise<{ thread: CommentThreadDTO }> {
  return api(`${base(projectId)}/${commentId}`, { method: "DELETE" });
}

export function resolveThread(
  projectId: string,
  threadId: string,
): Promise<{ thread: CommentThreadDTO }> {
  return api(`${base(projectId)}/${threadId}/resolve`, { method: "POST" });
}

export function reopenThread(
  projectId: string,
  threadId: string,
): Promise<{ thread: CommentThreadDTO }> {
  return api(`${base(projectId)}/${threadId}/reopen`, { method: "POST" });
}

export function react(
  projectId: string,
  commentId: string,
  emoji: string,
): Promise<{ thread: CommentThreadDTO }> {
  return api(
    `${base(projectId)}/${commentId}/reactions/${encodeURIComponent(emoji)}`,
    { method: "PUT" },
  );
}

export function unreact(
  projectId: string,
  commentId: string,
  emoji: string,
): Promise<{ thread: CommentThreadDTO }> {
  return api(
    `${base(projectId)}/${commentId}/reactions/${encodeURIComponent(emoji)}`,
    { method: "DELETE" },
  );
}

export function reportAnchorStatus(
  projectId: string,
  threadId: string,
  status: "ok" | "stale",
): Promise<{ ok: boolean }> {
  return api(`${base(projectId)}/${threadId}/anchor-status`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
}
