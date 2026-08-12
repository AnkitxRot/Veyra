export const TOKEN_KEY = 'cloudide_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  
  const res = await fetch(path, { credentials: 'include', ...opts, headers });
  
  // if 204 No Content, return empty object to prevent JSON parse error
  if (res.status === 204) {
    return {} as T;
  }
  
  const data = (await res.json().catch(() => ({}))) as T & ApiErrorBody;
  if (!res.ok) {
    const message = data?.error?.message ?? `request failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

export function getWebSocketUrl(path: string, projectId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
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
    'ts-node': boolean;
    gcc: boolean;
    'g++': boolean;
    jdk: boolean;
  };
}

export async function getCapabilities(): Promise<Capabilities> {
  return api<Capabilities>('/api/system/capabilities');
}
