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

export function getWebSocketUrl(path: string, projectId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  return `${protocol}//${host}${path}?projectId=${projectId}`;
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
