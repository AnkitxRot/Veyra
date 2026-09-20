import { EventEmitter } from "node:events";
import type { Db } from "./db.js";

export type AuditEventType =
  | "AUTH_LOGIN"
  | "AUTH_LOGOUT"
  | "AUTH_FAILED_LOGIN"
  | "ADMIN_LOGIN"
  | "DEMO_SESSION_CREATED"
  | "DEMO_ACCOUNTS_GC"
  | "PROJECT_CREATED"
  | "PROJECT_DELETED"
  | "PROJECT_EXPORTED"
  | "PROJECT_IMPORTED"
  | "PROJECT_FILES_UPLOADED"
  | "PROJECT_FORKED"
  | "EXECUTION_STARTED"
  | "EXECUTION_COMPLETED"
  | "EXECUTION_FAILED"
  | "SANDBOX_CREATED"
  | "SANDBOX_REAPED"
  | "SANDBOX_STOPPED"
  | "SANDBOX_TERMINATED_BY_ADMIN"
  | "SNAPSHOT_CREATED"
  | "SNAPSHOT_RESTORED"
  | "SNAPSHOT_DELETED"
  | "USER_UPDATED_BY_ADMIN"
  | "USER_PASSWORD_RESET_BY_ADMIN"
  | "USER_DELETED_BY_ADMIN"
  | "USER_PREFERENCES_UPDATED"
  | "PROFILE_UPDATED"
  | "PROFILE_MEDIA_UPLOADED"
  | "PROFILE_MEDIA_DELETED"
  | "DATABASE_BACKUP_CREATED"
  | "DATABASE_BACKUP_DELETED"
  | "DATABASE_BACKUP_DOWNLOADED"
  | "WORKSPACE_BACKUP_CREATED"
  | "WORKSPACE_BACKUP_DOWNLOADED"
  | "WORKSPACE_BACKUP_DELETED"
  | "WORKSPACE_BACKUP_RESTORED"
  | "SECRET_CREATED"
  | "SECRET_UPDATED"
  | "SECRET_DELETED"
  | "SECRET_ACCESSED"
  | "GIT_OPERATION"
  | "TERMINAL_SESSION_CREATED"
  | "TERMINAL_SESSION_CLOSED"
  | "COLLAB_ROOM_CREATED"
  | "COLLAB_ROOM_DISPOSED"
  | "FILE_UPLOADED"
  | "USER_LOGIN_FAILED"
  | "USER_REGISTERED"
  | "GIT_INIT"
  | "GIT_COMMIT"
  | "GIT_BRANCH_CREATED"
  | "GIT_BRANCH_DELETED"
  | "GIT_CHECKOUT"
  | "GIT_CLONE"
  | "GIT_REMOTE_SET"
  | "GIT_FETCH"
  | "GIT_PULL"
  | "GIT_PUSH"
  | "GIT_CREDENTIAL_UPDATED"
  | "GIT_CREDENTIAL_DELETED"
  | "COMMENT_ADDED"
  | "COMMENT_RESOLVED"
  | "ADMIN_ACTION";

export interface AuditRecord {
  id: number;
  user_id: number | null;
  username?: string | null;
  project_id: string | null;
  project_name?: string | null;
  event_type: AuditEventType;
  details: Record<string, any>;
  ip_address: string | null;
  created_at: string;
}

export const auditEmitter = new EventEmitter();
export const auditFailureEmitter = new EventEmitter();

/** Test-only: reset the failure counter to a clean state. */
export function _resetAuditFailureStateForTests(): void {
  state.totalFailures = 0;
  state.byCategory = {};
  state.lastFailureAt = null;
  state.lastFailureMessage = null;
  state.since = Date.now();
}

/** M93 — in-memory audit write failure counter. Process-local, resets on restart. */
export interface AuditFailureSnapshot {
  totalFailures: number;
  byCategory: Record<string, number>;
  lastFailureAt: string | null;
  lastFailureMessage: string | null;
  since: string;
}

interface AuditFailureState {
  totalFailures: number;
  byCategory: Record<string, number>;
  lastFailureAt: number | null;
  lastFailureMessage: string | null;
  since: number;
}

const state: AuditFailureState = {
  totalFailures: 0,
  byCategory: {},
  lastFailureAt: null,
  lastFailureMessage: null,
  since: Date.now(),
};

const MAX_MESSAGE_LENGTH = 200;

function classifyError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("disk") || msg.includes("full") || msg.includes("sqlite") || msg.includes("locked")) {
      return "db_error";
    }
    if (msg.includes("constraint") || msg.includes("foreign key") || msg.includes("unique") || msg.includes("schema")) {
      return "integrity_error";
    }
  }
  return "unknown";
}

export function recordAuditFailure(err: unknown): void {
  const category = classifyError(err);
  const message = err instanceof Error ? err.message : String(err);
  const truncated = message.length > MAX_MESSAGE_LENGTH ? message.slice(0, MAX_MESSAGE_LENGTH) + "…" : message;

  state.totalFailures++;
  state.byCategory[category] = (state.byCategory[category] ?? 0) + 1;
  state.lastFailureAt = Date.now();
  state.lastFailureMessage = truncated;

  auditFailureEmitter.emit("failure", {
    totalFailures: state.totalFailures,
    byCategory: { ...state.byCategory },
    lastFailureAt: state.lastFailureAt,
    lastFailureMessage: state.lastFailureMessage,
    since: new Date(state.since).toISOString(),
  });
}

export function getAuditFailureSnapshot(): AuditFailureSnapshot {
  return {
    totalFailures: state.totalFailures,
    byCategory: { ...state.byCategory },
    lastFailureAt: state.lastFailureAt !== null ? new Date(state.lastFailureAt).toISOString() : null,
    lastFailureMessage: state.lastFailureMessage,
    since: new Date(state.since).toISOString(),
  };
}

/** M93 — delete audit_logs rows older than retentionDays. */
export function pruneAuditLogs(db: Db, retentionDays: number): number {
  const result = db
    .prepare(
      "DELETE FROM audit_logs WHERE created_at < datetime('now', '-' || ? || ' days')",
    )
    .run(retentionDays);
  return Number(result.changes);
}

const REDACTED_KEYS = new Set([
  "password",
  "password_hash",
  "token",
  "secret",
  "cookie",
  "session_token",
  "newpassword",
  // M47 defence-in-depth: secret values must never be passed into audit
  // details in the first place, but redact these key names too in case a
  // future caller slips.
  "plaintext",
  "secret_value",
  "secretvalue",
  "ciphertext",
  "pat",
  "authorization",
  "access_token",
  "accesstoken",
  "git_token",
  "credential",
  "token_value",
]);

function sanitizeDetails(details: any): any {
  if (!details || typeof details !== "object") {
    return details;
  }
  if (Array.isArray(details)) {
    return details.map(sanitizeDetails);
  }
  const clean: Record<string, any> = {};
  for (const [key, val] of Object.entries(details)) {
    if (REDACTED_KEYS.has(key.toLowerCase())) {
      clean[key] = "[REDACTED]";
    } else if (typeof val === "object") {
      clean[key] = sanitizeDetails(val);
    } else {
      clean[key] = val;
    }
  }
  return clean;
}

export function recordAuditLog(
  db: Db,
  params: {
    userId?: number | null;
    projectId?: string | null;
    eventType: AuditEventType;
    details?: Record<string, any> | string;
    ipAddress?: string | null;
  },
): void {
  try {
    let rawDetailsObj: Record<string, any> = {};
    let detailsStr = "{}";
    if (typeof params.details === "string") {
      rawDetailsObj = { message: params.details };
      detailsStr = JSON.stringify(rawDetailsObj);
    } else if (params.details && typeof params.details === "object") {
      rawDetailsObj = sanitizeDetails(params.details);
      detailsStr = JSON.stringify(rawDetailsObj);
    }

    const res = db
      .prepare(
        `
      INSERT INTO audit_logs (user_id, project_id, event_type, details, ip_address)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(
        params.userId ?? null,
        params.projectId ?? null,
        params.eventType,
        detailsStr,
        params.ipAddress ?? null,
      );

    const record: AuditRecord = {
      id: Number(res.lastInsertRowid),
      user_id: params.userId ?? null,
      project_id: params.projectId ?? null,
      event_type: params.eventType,
      details: rawDetailsObj,
      ip_address: params.ipAddress ?? null,
      created_at: new Date().toISOString(),
    };

    auditEmitter.emit("audit", record);
  } catch (err) {
    // Non-fatal: audit log should not crash transaction
    console.error("[AuditLog] Failed to record audit log:", err);
    recordAuditFailure(err);
  }
}

export function queryAuditLogs(
  db: Db,
  filters: {
    eventType?: string;
    userId?: number;
    projectId?: string;
    limit?: number;
    offset?: number;
  } = {},
): { logs: AuditRecord[]; total: number } {
  const limit = Math.max(1, Math.min(filters.limit ?? 50, 200));
  const offset = Math.max(0, filters.offset ?? 0);

  const whereClauses: string[] = [];
  const params: any[] = [];

  if (filters.eventType) {
    whereClauses.push("a.event_type = ?");
    params.push(filters.eventType);
  }
  if (filters.userId !== undefined) {
    whereClauses.push("a.user_id = ?");
    params.push(filters.userId);
  }
  if (filters.projectId) {
    whereClauses.push("a.project_id = ?");
    params.push(filters.projectId);
  }

  const whereSql =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const countRow = db
    .prepare(`SELECT COUNT(*) as total FROM audit_logs a ${whereSql}`)
    .get(...params) as { total: number };
  const total = countRow?.total ?? 0;

  const rows = db
    .prepare(
      `
    SELECT a.id, a.user_id, a.project_id, a.event_type, a.details, a.ip_address, a.created_at,
           u.username, p.name as project_name
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN projects p ON p.id = a.project_id
    ${whereSql}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `,
    )
    .all(...params, limit, offset) as Array<{
    id: number;
    user_id: number | null;
    username: string | null;
    project_id: string | null;
    project_name: string | null;
    event_type: string;
    details: string;
    ip_address: string | null;
    created_at: string;
  }>;

  const logs: AuditRecord[] = rows.map((r) => {
    let parsedDetails = {};
    try {
      parsedDetails = JSON.parse(r.details);
    } catch {}
    return {
      id: r.id,
      user_id: r.user_id,
      username: r.username,
      project_id: r.project_id,
      project_name: r.project_name,
      event_type: r.event_type as AuditEventType,
      details: parsedDetails,
      ip_address: r.ip_address,
      created_at: r.created_at,
    };
  });

  return { logs, total };
}
