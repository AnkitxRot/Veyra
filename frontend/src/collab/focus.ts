// M59: pure derived "collaborative focus" view over the three existing sources
// of truth (M57 presence, M58 attention, M48 followedUserId). NOT a store —
// callers wrap in useMemo. FocusState is a UI-only enum, never sent on the wire.
import type { CollaboratorPresence, ActivityType } from "./presence";
import type { AttentionEvent, AttentionRange } from "./attention";

export const FOLLOW_ABSENCE_GRACE_MS = 6_000;
export const FOLLOW_LEFT_NOTICE_MS = 8_000;

export type FocusState = "idle" | "viewing" | "focused" | "following";

export interface FocusContext {
  user: CollaboratorPresence;
  file: string | null;
  range: AttentionRange | null;
  activity: ActivityType;
  attention: AttentionEvent | null;
  state: FocusState;
  isFollowing: boolean;
  timestamp: number;
}

export function deriveFocusState(
  user: CollaboratorPresence,
  attention: AttentionEvent | null,
  isFollowing: boolean,
): FocusState {
  if (isFollowing) return "following";
  if (attention) return "focused";
  const a = user.activity?.type;
  if (
    user.status === "online" &&
    (a === "viewing" || a === "editing" || a === "navigating")
  ) {
    return "viewing";
  }
  return "idle";
}

/**
 * Newest attention event authored by `authorUserId` that is either targeted at
 * `currentUserId` or broadcast (no target). Pure.
 */
export function latestAttentionFrom(
  list: AttentionEvent[],
  authorUserId: number,
  currentUserId: number,
): AttentionEvent | null {
  let best: AttentionEvent | null = null;
  for (const e of list) {
    if (e.author.userId !== authorUserId) continue;
    if (e.targetUserId != null && e.targetUserId !== currentUserId) continue;
    if (!best || e.createdAt > best.createdAt) best = e;
  }
  return best;
}

export function buildFocusContext(
  user: CollaboratorPresence,
  allAttention: AttentionEvent[],
  currentUserId: number,
  followedUserId: number | null,
): FocusContext {
  const attention = latestAttentionFrom(
    allAttention,
    user.userId,
    currentUserId,
  );
  const isFollowing = followedUserId === user.userId;
  return {
    user,
    file: user.activeFile ?? attention?.file ?? null,
    range: attention?.range ?? null,
    activity: user.activity?.type ?? "viewing",
    attention,
    state: deriveFocusState(user, attention, isFollowing),
    isFollowing,
    timestamp: Math.max(user.lastActive ?? 0, attention?.createdAt ?? 0),
  };
}
