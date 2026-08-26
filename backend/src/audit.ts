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
  | "SANDBOX_TERMINATED_BY_ADMIN"
  | "SNAPSHOT_CREATED"
  | "SNAPSHOT_RESTORED"
  | "SNAPSHOT_DELETED"
  | "USER_UPDATED_BY_ADMIN"
  | "USER_PASSWORD_RESET_BY_ADMIN"
  | "USER_DELETED_BY_ADMIN"
  | "USER_PREFERENCES_UPDATED"
  | "DATABASE_BACKUP_CREATED"
  | "DATABASE_BACKUP_DELETED"
  | "DATABASE_BACKUP_DOWNLOADED"
  | "WORKSPACE_BACKUP_CREATED"
  | "WORKSPACE_BACKUP_DOWNLOADED"
  | "WORKSPACE_BACKUP_DELETED"
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

const REDACTED_KEYS = new Set([
  "password",
  "password_hash",
  "token",
  "secret",
  "cookie",
  "session_token",
  "newpassword",
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
