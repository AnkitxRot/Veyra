import type { TimelinePage, WhileAwayResponse, UserProfile } from "./types";

export interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((opts.headers as Record<string, string>) || {}),
  };

  const res = await fetch(path, { credentials: "include", ...opts, headers });

  // if 204 No Content, return empty object to prevent JSON parse error
  if (res.status === 204) {
    return {} as T;
  }

  const data = (await res.json().catch(() => ({}))) as T & ApiErrorBody;
  if (!res.ok) {
    const message = data?.error?.message ?? `request failed (${res.status})`;
    const err = new Error(message);
    (err as any).code = data?.error?.code;
    (err as any).status = res.status;
    // Full response body — lets callers read structured 409 details such as
    // M56's `collaboratorImpacts` / `remainingDirty`.
    (err as any).body = data;
    throw err;
  }
  return data;
}

export function getWebSocketUrl(
  path: string,
  projectId: string,
  extraParams?: Record<string, string | number>,
): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  const params = new URLSearchParams({ projectId });
  for (const [k, v] of Object.entries(extraParams ?? {})) {
    params.set(k, String(v));
  }
  return `${protocol}//${host}${path}?${params.toString()}`;
}

export interface Capabilities {
  docker: boolean;
  runnerImage: boolean;
  languages: {
    python: boolean;
    node: boolean;
    typescript: boolean;
    c: boolean;
    cpp: boolean;
    java: boolean;
  };
  toolchains: {
    python: boolean;
    node: boolean;
    "ts-node": boolean;
    gcc: boolean;
    "g++": boolean;
    jdk: boolean;
  };
}

export async function getCapabilities(): Promise<Capabilities> {
  return api<Capabilities>("/api/system/capabilities");
}

export interface AIResponsePayload {
  action: string;
  providerType: string;
  modelName: string;
  rootCause?: string;
  explanation: string;
  patch?: {
    filePath: string;
    originalContent: string;
    modifiedContent: string;
    explanation: string;
    linesAdded: number;
    linesRemoved: number;
    baseRevision?: string;
  } | null;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  suggestedTests?: string;
  approxTokens: { input: number; output: number };
}

export interface AIVerificationRecord {
  id: string;
  project_id: string;
  user_id: number;
  action: string;
  provider_type: string;
  model_name?: string;
  status: "VERIFIED" | "FAILED" | "UNVERIFIED";
  file_path?: string;
  explanation?: string;
  diff_summary?: string;
  snapshot_id?: string;
  execution_id?: string;
  exit_code?: number | null;
  stdout_summary?: string;
  stderr_summary?: string;
  skip_reason?: string;
  duration_ms: number;
  created_at: string;
}

export async function triggerAIAction(
  projectId: string,
  payload: {
    action: string;
    activeFilePath: string;
    selectedCode?: string;
    selectionRange?: any;
    diagnostics?: any[];
    searchQuery?: string;
    providerId?: string;
  },
): Promise<{ response: AIResponsePayload }> {
  return api<{ response: AIResponsePayload }>(
    `/api/projects/${projectId}/ai/action`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export async function applyAIPatch(
  projectId: string,
  payload: {
    filePath: string;
    content: string;
    createSafetySnapshot?: boolean;
    explanation?: string;
    baseRevision: string;
  },
): Promise<{ ok: boolean; snapshotId?: string }> {
  return api<{ ok: boolean; snapshotId?: string }>(
    `/api/projects/${projectId}/ai/apply-patch`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export async function verifyAIPatch(
  projectId: string,
  payload: {
    action: string;
    providerType: string;
    modelName: string;
    filePath: string;
    explanation: string;
    diffSummary?: string;
    snapshotId?: string;
    skipVerification?: boolean;
  },
): Promise<{ verification: AIVerificationRecord }> {
  return api<{ verification: AIVerificationRecord }>(
    `/api/projects/${projectId}/ai/verify`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export async function listAIVerifications(
  projectId: string,
): Promise<{ verifications: AIVerificationRecord[] }> {
  return api<{ verifications: AIVerificationRecord[] }>(
    `/api/projects/${projectId}/ai/verifications`,
  );
}

// --- M60: collaboration history --------------------------------------------

export async function fetchCollabTimeline(
  projectId: string,
  opts: { limit?: number; before?: string | null } = {},
): Promise<TimelinePage> {
  const q = new URLSearchParams();
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.before) q.set("before", opts.before);
  const qs = q.toString();
  return api<TimelinePage>(
    `/api/projects/${projectId}/collab/timeline${qs ? `?${qs}` : ""}`,
  );
}

export async function fetchWhileAway(
  projectId: string,
): Promise<WhileAwayResponse> {
  return api<WhileAwayResponse>(
    `/api/projects/${projectId}/collab/while-away`,
  );
}

export async function ackWhileAway(
  projectId: string,
  upTo: string,
): Promise<void> {
  await api<{ ok: true }>(
    `/api/projects/${projectId}/collab/while-away/ack`,
    { method: "POST", body: JSON.stringify({ upTo }) },
  );
}

// --- M62: self-service profile identity -----------------------------------

/** GET the current user's profile. Missing row → all-null fields (200). */
export async function getProfile(): Promise<{ profile: UserProfile }> {
  return api<{ profile: UserProfile }>("/api/auth/profile");
}

/**
 * PUT the three writable identity fields. `null` clears a field. The server
 * is authoritative for normalization + length validation; a 400 arrives as a
 * thrown `Error` whose `.message` is the server's own message.
 */
export async function updateProfile(patch: {
  displayName: string | null;
  pronouns: string | null;
  bio: string | null;
}): Promise<{ profile: UserProfile }> {
  return api<{ profile: UserProfile }>("/api/auth/profile", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

/** M72: cache-busted avatar URL. `self` targets the caller's own route. */
export function avatarUrl(
  userId: number,
  avatarVersion: number,
  self = false,
): string {
  const path = self
    ? "/api/auth/profile/avatar"
    : `/api/auth/profile/${userId}/avatar`;
  return `${path}?v=${avatarVersion}`;
}

export interface AvatarUploadResult {
  avatarVersion: number;
  mime: string;
  width: number;
  height: number;
}

/**
 * M72: upload a new avatar. The browser sets the multipart boundary; the
 * server re-validates the bytes and ignores the declared type. A 400 (bad
 * image / too large) or 429 (rate limited) arrives as a thrown `Error` whose
 * `.message` is the server's own text.
 */
export async function uploadAvatar(file: File): Promise<AvatarUploadResult> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/auth/profile/avatar", {
    method: "POST",
    credentials: "include",
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as
    | AvatarUploadResult
    | ApiErrorBody;
  if (!res.ok) {
    const err = new Error(
      (data as ApiErrorBody)?.error?.message ??
        `avatar upload failed (${res.status})`,
    );
    (err as any).code = (data as ApiErrorBody)?.error?.code;
    (err as any).status = res.status;
    throw err;
  }
  return data as AvatarUploadResult;
}

/** M72: remove the current avatar. Idempotent — a no-op when none is set. */
export async function removeAvatar(): Promise<{ avatarVersion: number }> {
  return api<{ ok: true; avatarVersion: number }>("/api/auth/profile/avatar", {
    method: "DELETE",
  });
}
