import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { api } from "../../api";
import {
  User,
  AdminOverviewData,
  AdminSandboxData,
  AdminExecutionMetrics,
  AdminUserData,
  AdminProjectData,
  AdminAuditRecord,
  AdminUserDetails,
  RunRecord,
  AdminBackupHealth,
} from "../../types";
import {
  IconShield,
  IconServer,
  IconUsers,
  IconCode,
  IconActivity,
  IconRefresh,
  IconTrash,
  IconLogOut,
  IconCheck,
  IconAlertTriangle,
  IconDocker,
  IconLayers,
  IconEdit,
  IconCpu,
  IconDatabase,
} from "../common/Icons";
import AdminResourceAnalytics from "./AdminResourceAnalytics";
import AdminBackupsPanel from "./AdminBackupsPanel";

export default function AdminDashboard({
  user: _user,
  onLogout,
  onSwitchToIde,
}: {
  user: User;
  onLogout: () => void;
  onSwitchToIde: () => void;
}) {
  const [activeTab, setActiveTab] = useState<
    | "overview"
    | "sandboxes"
    | "executions"
    | "resources"
    | "tenants"
    | "audit"
    | "backups"
  >("overview");

  // Real-time streaming state
  const [wsStatus, setWsStatus] = useState<
    "connected" | "reconnecting" | "stale"
  >("reconnecting");
  // Not React state: only read by the staleness-check interval below, never
  // rendered directly. Keeping it as a ref (instead of useState) means
  // updating it on every ~1Hz tick does not itself trigger a re-render or
  // re-run of the WebSocket connection effect.
  const lastTickTimeRef = useRef<number>(Date.now());
  const wsRef = useRef<WebSocket | null>(null);

  // Data states
  const [overview, setOverview] = useState<AdminOverviewData | null>(null);
  const [sandboxes, setSandboxes] = useState<AdminSandboxData[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [execMetrics, setExecMetrics] = useState<AdminExecutionMetrics | null>(
    null,
  );
  const [users, setUsers] = useState<AdminUserData[]>([]);
  const [projects, setProjects] = useState<AdminProjectData[]>([]);
  const [auditLogs, setAuditLogs] = useState<AdminAuditRecord[]>([]);
  const [backupHealth, setBackupHealth] = useState<AdminBackupHealth | null>(
    null,
  );
  const [backupHealthError, setBackupHealthError] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  // User Management Modals / Drawer states
  const [inspectingUser, setInspectingUser] = useState<AdminUserDetails | null>(
    null,
  );
  const [, setInspectLoading] = useState(false);
  const [editingUser, setEditingUser] = useState<AdminUserData | null>(null);
  const [editUsername, setEditUsername] = useState("");
  const [editRole, setEditRole] = useState<"user" | "admin">("user");
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [resettingPasswordUser, setResettingPasswordUser] =
    useState<AdminUserData | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const [deletingUser, setDeletingUser] = useState<AdminUserData | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Sandbox Termination Modal
  const [terminatingSandbox, setTerminatingSandbox] =
    useState<AdminSandboxData | null>(null);
  const [terminateLoading, setTerminateLoading] = useState(false);

  // Search, Filter & Sort states for Tenants & Workspaces
  const [tenantSubTab, setTenantSubTab] = useState<"users" | "projects">(
    "users",
  );
  const [userSearch, setUserSearch] = useState("");
  const [userRoleFilter, setUserRoleFilter] = useState<
    "all" | "admin" | "user"
  >("all");
  const [userTypeFilter, setUserTypeFilter] = useState<
    "all" | "standard" | "demo"
  >("all");
  const [userSortField, setUserSortField] = useState<
    "id" | "username" | "project_count" | "execution_count" | "created_at"
  >("created_at");
  const [userSortAsc, setUserSortAsc] = useState(false);

  // Execution & Audit Filters
  const [execStatusFilter, setExecStatusFilter] = useState("");
  const [execLangFilter, setExecLangFilter] = useState("");
  const [auditEventFilter, setAuditEventFilter] = useState("");

  // 1. HTTP Fetchers (Slow / On-Demand Data)
  const fetchExecutions = useCallback(async () => {
    try {
      let query = "/api/admin/executions?limit=50";
      if (execStatusFilter)
        query += `&status=${encodeURIComponent(execStatusFilter)}`;
      if (execLangFilter)
        query += `&language=${encodeURIComponent(execLangFilter)}`;
      const res = await api<{
        runs: RunRecord[];
        metrics: AdminExecutionMetrics;
      }>(query);
      setRuns(res.runs);
      setExecMetrics(res.metrics);
    } catch {}
  }, [execStatusFilter, execLangFilter]);

  const fetchTenants = useCallback(async () => {
    try {
      const [uRes, pRes] = await Promise.all([
        api<{ users: AdminUserData[] }>("/api/admin/users"),
        api<{ projects: AdminProjectData[] }>("/api/admin/projects"),
      ]);
      setUsers(uRes.users);
      setProjects(pRes.projects);
    } catch {}
  }, []);

  const fetchAudit = useCallback(async () => {
    try {
      let query = "/api/admin/audit?limit=50";
      if (auditEventFilter)
        query += `&event_type=${encodeURIComponent(auditEventFilter)}`;
      const res = await api<{ logs: AdminAuditRecord[]; total: number }>(query);
      setAuditLogs(res.logs);
    } catch {}
  }, [auditEventFilter]);

  const fetchOverviewFallback = useCallback(async () => {
    try {
      const [ov, sb] = await Promise.all([
        api<AdminOverviewData>("/api/admin/overview"),
        api<{ sandboxes: AdminSandboxData[] }>("/api/admin/sandboxes"),
      ]);
      setOverview(ov);
      setSandboxes(sb.sandboxes);
    } catch {}
  }, []);

  const fetchBackupHealth = useCallback(async () => {
    try {
      const res = await api<{ backups: AdminBackupHealth }>(
        "/api/admin/health",
      );
      setBackupHealth(res.backups);
      setBackupHealthError(null);
    } catch (err: any) {
      setBackupHealthError(err.message || "Failed to load backup health");
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([
      fetchOverviewFallback(),
      fetchExecutions(),
      fetchTenants(),
      fetchAudit(),
      fetchBackupHealth(),
    ]);
    setLoading(false);
  }, [
    fetchOverviewFallback,
    fetchExecutions,
    fetchTenants,
    fetchAudit,
    fetchBackupHealth,
  ]);

  // 2. Real-Time WebSocket Connection (~1 Hz stream + platform events)
  useEffect(() => {
    let reconnectTimeout: NodeJS.Timeout;
    let isUnmounted = false;

    const connectWs = () => {
      if (isUnmounted) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws/admin`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsStatus("connected");
        lastTickTimeRef.current = Date.now();
      };

      ws.onmessage = (event) => {
        try {
          const packet = JSON.parse(event.data);
          if (packet.type === "telemetry_tick" || packet.type === "snapshot") {
            const data = packet.data;
            if (data) {
              setOverview((prev) => {
                if (!prev) return data;
                return {
                  ...prev,
                  system: data.system,
                  counters: data.counters,
                  aggregateTelemetry: data.aggregateTelemetry,
                };
              });
              setSandboxes(data.sandboxes || []);
              lastTickTimeRef.current = Date.now();
              setWsStatus("connected");
            }
          } else if (packet.type === "platform_event") {
            // Immediately invalidate relevant data
            fetchTenants();
            fetchExecutions();
            fetchAudit();
            fetchOverviewFallback();
          }
        } catch {}
      };

      ws.onclose = () => {
        if (!isUnmounted) {
          setWsStatus("reconnecting");
          reconnectTimeout = setTimeout(connectWs, 2500);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connectWs();

    // Heartbeat liveness check
    const staleInterval = setInterval(() => {
      if (Date.now() - lastTickTimeRef.current > 4000) {
        setWsStatus("stale");
      }
    }, 2000);

    return () => {
      isUnmounted = true;
      clearTimeout(reconnectTimeout);
      clearInterval(staleInterval);
      if (wsRef.current) wsRef.current.close();
    };
  }, [fetchTenants, fetchExecutions, fetchAudit, fetchOverviewFallback]);

  // Initial load
  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (activeTab === "executions") fetchExecutions();
    if (activeTab === "tenants") fetchTenants();
    if (activeTab === "audit") fetchAudit();
  }, [activeTab, fetchExecutions, fetchTenants, fetchAudit]);

  // User Actions: Inspect
  const handleInspectUser = async (userId: number) => {
    setInspectLoading(true);
    setInspectingUser(null);
    try {
      const res = await api<AdminUserDetails>(`/api/admin/users/${userId}`);
      setInspectingUser(res);
    } catch (err: any) {
      alert(`Failed to load user details: ${err.message}`);
    } finally {
      setInspectLoading(false);
    }
  };

  // User Actions: Edit
  const openEditModal = (u: AdminUserData) => {
    setEditingUser(u);
    setEditUsername(u.username);
    setEditRole(u.role);
    setEditError(null);
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setEditLoading(true);
    setEditError(null);
    try {
      await api(`/api/admin/users/${editingUser.id}`, {
        method: "PATCH",
        body: JSON.stringify({ username: editUsername.trim(), role: editRole }),
      });
      setActionMessage(`Updated user ${editUsername}`);
      setTimeout(() => setActionMessage(null), 3500);
      setEditingUser(null);
      await fetchTenants();
      if (inspectingUser?.user.id === editingUser.id) {
        await handleInspectUser(editingUser.id);
      }
    } catch (err: any) {
      setEditError(err.message || "Failed to update user");
    } finally {
      setEditLoading(false);
    }
  };

  // User Actions: Password Reset
  const openResetPasswordModal = (u: AdminUserData) => {
    setResettingPasswordUser(u);
    setNewPassword("");
    setResetError(null);
  };

  const handleResetPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resettingPasswordUser) return;
    if (newPassword.length < 8) {
      setResetError("Password must be at least 8 characters long");
      return;
    }
    setResetLoading(true);
    setResetError(null);
    try {
      await api(`/api/admin/users/${resettingPasswordUser.id}/reset-password`, {
        method: "POST",
        body: JSON.stringify({ newPassword }),
      });
      setActionMessage(
        `Password reset for ${resettingPasswordUser.username}. Sessions revoked.`,
      );
      setTimeout(() => setActionMessage(null), 4000);
      setResettingPasswordUser(null);
    } catch (err: any) {
      setResetError(err.message || "Failed to reset password");
    } finally {
      setResetLoading(false);
    }
  };

  // User Actions: Delete
  const openDeleteModal = (u: AdminUserData) => {
    setDeletingUser(u);
    setDeleteError(null);
  };

  const handleDeleteUserSubmit = async () => {
    if (!deletingUser) return;
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      await api(`/api/admin/users/${deletingUser.id}`, {
        method: "DELETE",
      });
      setActionMessage(
        `Deleted user ${deletingUser.username} and all workspaces.`,
      );
      setTimeout(() => setActionMessage(null), 4000);
      if (inspectingUser?.user.id === deletingUser.id) {
        setInspectingUser(null);
      }
      setDeletingUser(null);
      await fetchTenants();
      await fetchOverviewFallback();
    } catch (err: any) {
      setDeleteError(err.message || "Failed to delete user");
    } finally {
      setDeleteLoading(false);
    }
  };

  // Sandbox Termination
  const handleTerminateConfirm = async () => {
    if (!terminatingSandbox) return;
    setTerminateLoading(true);
    try {
      await api(
        `/api/admin/sandboxes/${terminatingSandbox.containerId}/terminate`,
        {
          method: "POST",
        },
      );
      setActionMessage(`Terminated sandbox ${terminatingSandbox.containerId}`);
      setTimeout(() => setActionMessage(null), 3500);
      setTerminatingSandbox(null);
      await fetchOverviewFallback();
      await fetchAudit();
    } catch (err: any) {
      alert(`Termination failed: ${err.message}`);
    } finally {
      setTerminateLoading(false);
    }
  };

  // Filtered & Sorted Users List
  const filteredUsers = useMemo(() => {
    return users
      .filter((u) => {
        if (userSearch.trim()) {
          const q = userSearch.toLowerCase();
          if (
            !u.username.toLowerCase().includes(q) &&
            !String(u.id).includes(q)
          ) {
            return false;
          }
        }
        if (userRoleFilter !== "all" && u.role !== userRoleFilter) return false;
        if (userTypeFilter === "demo" && !u.isDemo) return false;
        if (userTypeFilter === "standard" && u.isDemo) return false;
        return true;
      })
      .sort((a, b) => {
        let valA: any = a[userSortField];
        let valB: any = b[userSortField];
        if (userSortField === "created_at") {
          valA = new Date(valA).getTime();
          valB = new Date(valB).getTime();
        }
        if (valA < valB) return userSortAsc ? -1 : 1;
        if (valA > valB) return userSortAsc ? 1 : -1;
        return 0;
      });
  }, [
    users,
    userSearch,
    userRoleFilter,
    userTypeFilter,
    userSortField,
    userSortAsc,
  ]);

  const handleUserSort = (field: typeof userSortField) => {
    if (userSortField === field) {
      setUserSortAsc(!userSortAsc);
    } else {
      setUserSortField(field);
      setUserSortAsc(false);
    }
  };

  const formatUptime = (seconds: number) => {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    return `${m}m ${s}s`;
  };

  const formatBytes = (bytes: number) => {
    if (!bytes || bytes === 0) return "0 MB";
    const mb = bytes / 1024 / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    return `${(mb / 1024).toFixed(2)} GB`;
  };

  const formatAge = (ms: number | null) => {
    if (ms === null) return "never";
    const hours = ms / 3600000;
    if (hours < 1) return `${Math.round(ms / 60000)}m ago`;
    if (hours < 48) return `${hours.toFixed(1)}h ago`;
    return `${(hours / 24).toFixed(1)}d ago`;
  };

  const backupStatusBadgeClass = (status: string) =>
    status === "ok"
      ? "glass-badge-success"
      : status === "stale"
        ? "glass-badge-warning"
        : "glass-badge-error";

  return (
    <div className="admin-layout">
      {/* Liquid Glass Admin Header */}
      <header className="admin-header">
        <div className="admin-header-title">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "32px",
              height: "32px",
              borderRadius: "8px",
              background: "rgba(243, 139, 168, 0.15)",
              color: "#f38ba8",
              border: "1px solid rgba(243, 139, 168, 0.3)",
            }}
          >
            <IconShield size={16} />
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span
                style={{
                  fontWeight: 700,
                  fontSize: "15px",
                  color: "var(--fg-primary)",
                }}
              >
                CloudeeeIDE Control Plane
              </span>
              <span className="admin-header-badge">ADMIN</span>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {/* Real-time Connection Capsule */}
          <div className={`admin-live-capsule ${wsStatus}`}>
            <span className="admin-live-dot" />
            <span>
              {wsStatus === "connected"
                ? "LIVE (1.0s)"
                : wsStatus === "reconnecting"
                  ? "RECONNECTING..."
                  : "STALE"}
            </span>
          </div>

          {actionMessage && (
            <span
              className="glass-badge glass-badge-success"
              style={{ animation: "fadeIn 200ms ease" }}
            >
              <IconCheck size={11} />
              <span>{actionMessage}</span>
            </span>
          )}

          <button
            className="glass-btn glass-btn-secondary"
            onClick={refreshAll}
            title="Refresh All Telemetry"
            style={{ fontSize: "12px", padding: "6px 12px" }}
          >
            <IconRefresh size={12} className={loading ? "spinning" : ""} />
            <span>Refresh</span>
          </button>

          <button
            className="glass-btn glass-btn-primary"
            onClick={onSwitchToIde}
            style={{
              fontSize: "12px",
              padding: "6px 14px",
              background: "var(--accent)",
            }}
          >
            <IconLayers size={13} />
            <span>IDE Workspace</span>
          </button>

          <button
            className="glass-btn glass-btn-ghost"
            onClick={onLogout}
            title="Sign Out Admin"
            style={{ fontSize: "12px", color: "#f38ba8" }}
          >
            <IconLogOut size={13} />
            <span>Logout</span>
          </button>
        </div>
      </header>

      {/* Control Plane Navigation Tabs */}
      <nav className="admin-subnav" role="tablist">
        <button
          className={`admin-nav-tab ${activeTab === "overview" ? "active" : ""}`}
          onClick={() => setActiveTab("overview")}
          role="tab"
          aria-selected={activeTab === "overview"}
        >
          <IconActivity size={14} />
          <span>System Overview</span>
        </button>

        <button
          className={`admin-nav-tab ${activeTab === "sandboxes" ? "active" : ""}`}
          onClick={() => setActiveTab("sandboxes")}
          role="tab"
          aria-selected={activeTab === "sandboxes"}
        >
          <IconServer size={14} />
          <span>Sandbox Operations ({sandboxes.length})</span>
        </button>

        <button
          className={`admin-nav-tab ${activeTab === "executions" ? "active" : ""}`}
          onClick={() => setActiveTab("executions")}
          role="tab"
          aria-selected={activeTab === "executions"}
        >
          <IconCode size={14} />
          <span>Execution Monitor</span>
        </button>

        <button
          className={`admin-nav-tab ${activeTab === "resources" ? "active" : ""}`}
          onClick={() => setActiveTab("resources")}
          role="tab"
          aria-selected={activeTab === "resources"}
        >
          <IconCpu size={14} />
          <span>Resource Analytics</span>
        </button>

        <button
          className={`admin-nav-tab ${activeTab === "tenants" ? "active" : ""}`}
          onClick={() => setActiveTab("tenants")}
          role="tab"
          aria-selected={activeTab === "tenants"}
        >
          <IconUsers size={14} />
          <span>Tenants & Workspaces ({users.length})</span>
        </button>

        <button
          className={`admin-nav-tab ${activeTab === "audit" ? "active" : ""}`}
          onClick={() => setActiveTab("audit")}
          role="tab"
          aria-selected={activeTab === "audit"}
        >
          <IconShield size={14} />
          <span>Audit Journal</span>
        </button>

        <button
          className={`admin-nav-tab ${activeTab === "backups" ? "active" : ""}`}
          onClick={() => setActiveTab("backups")}
          role="tab"
          aria-selected={activeTab === "backups"}
        >
          <IconDatabase size={14} />
          <span>Database &amp; Workspace Backups</span>
        </button>
      </nav>

      {/* Main Content Area (With Full-Height Smooth Scrolling) */}
      <main className="admin-content" tabIndex={0}>
        {/* =========================================================================
            TAB 1: SYSTEM OVERVIEW
            ========================================================================= */}
        {activeTab === "overview" && (
          <>
            {/* KPI Counters Grid */}
            <div className="admin-cards-grid">
              <div className="admin-card">
                <div className="admin-card-header">
                  <span>Active Sandboxes</span>
                  <IconDocker size={14} color="#89b4fa" />
                </div>
                <div className="admin-card-value">
                  {overview?.counters?.activeSandboxes ?? sandboxes.length}
                </div>
                <div className="admin-card-sub">
                  <span>
                    Max Pool: {overview?.infrastructure?.maxSandboxes ?? 20}{" "}
                    containers
                  </span>
                </div>
              </div>

              <div className="admin-card">
                <div className="admin-card-header">
                  <span>Aggregate Sandbox CPU</span>
                  <IconActivity size={14} color="#a6e3a1" />
                </div>
                <div className="admin-card-value">
                  {overview?.aggregateTelemetry?.cpuPercent ?? 0}%
                </div>
                <div className="admin-gauge-bar">
                  <div
                    className="admin-gauge-fill"
                    style={{
                      width: `${Math.min(100, overview?.aggregateTelemetry?.cpuPercent ?? 0)}%`,
                    }}
                  />
                </div>
              </div>

              <div className="admin-card">
                <div className="admin-card-header">
                  <span>Total Memory Usage</span>
                  <IconServer size={14} color="#cba6f7" />
                </div>
                <div className="admin-card-value">
                  {formatBytes(
                    overview?.aggregateTelemetry?.memoryUsageBytes ?? 0,
                  )}
                </div>
                <div className="admin-card-sub">
                  <span>
                    Ceiling:{" "}
                    {formatBytes(
                      overview?.aggregateTelemetry?.memoryLimitBytes ??
                        536870912,
                    )}
                  </span>
                </div>
              </div>

              <div className="admin-card">
                <div className="admin-card-header">
                  <span>Total Executions</span>
                  <IconCode size={14} color="#f9e2af" />
                </div>
                <div className="admin-card-value">
                  {overview?.counters?.totalExecutions ?? 0}
                </div>
                <div className="admin-card-sub">
                  <span>All language pipelines</span>
                </div>
              </div>

              <div className="admin-card">
                <div className="admin-card-header">
                  <span>Total Tenants</span>
                  <IconUsers size={14} color="#74c7ec" />
                </div>
                <div className="admin-card-value">
                  {overview?.counters?.totalUsers ?? 0}
                </div>
                <div className="admin-card-sub">
                  <span>
                    {overview?.counters?.demoSessions ?? 0} disposable demo
                    sessions
                  </span>
                </div>
              </div>
            </div>

            {/* Diagnostics & Infrastructure Health */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
                gap: "16px",
              }}
            >
              <div className="admin-table-wrap" style={{ padding: "20px" }}>
                <h2
                  style={{
                    fontSize: "14px",
                    fontWeight: 600,
                    color: "var(--fg-primary)",
                    marginBottom: "14px",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  <IconActivity size={15} color="#89b4fa" />
                  <span>Node Process & Host Runtime</span>
                </h2>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                    fontSize: "13px",
                  }}
                >
                  <div
                    style={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <span style={{ color: "var(--fg-muted)" }}>Status:</span>
                    <span className="glass-badge glass-badge-success">
                      LIVE / HEALTHY
                    </span>
                  </div>
                  <div
                    style={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <span style={{ color: "var(--fg-muted)" }}>
                      Process Uptime:
                    </span>
                    <span style={{ fontFamily: "var(--font-mono)" }}>
                      {formatUptime(overview?.system?.uptimeSeconds ?? 0)}
                    </span>
                  </div>
                  <div
                    style={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <span style={{ color: "var(--fg-muted)" }}>
                      Node.js Runtime:
                    </span>
                    <span style={{ fontFamily: "var(--font-mono)" }}>
                      {overview?.system?.nodeVersion} (
                      {overview?.system?.platform} {overview?.system?.arch})
                    </span>
                  </div>
                  <div
                    style={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <span style={{ color: "var(--fg-muted)" }}>
                      Backend Process Memory (RSS):
                    </span>
                    <span style={{ fontFamily: "var(--font-mono)" }}>
                      {formatBytes(overview?.system?.memoryRssBytes ?? 0)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="admin-table-wrap" style={{ padding: "20px" }}>
                <h2
                  style={{
                    fontSize: "14px",
                    fontWeight: 600,
                    color: "var(--fg-primary)",
                    marginBottom: "14px",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  <IconDocker size={15} color="#89b4fa" />
                  <span>Container Infrastructure & Isolation</span>
                </h2>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                    fontSize: "13px",
                  }}
                >
                  <div
                    style={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <span style={{ color: "var(--fg-muted)" }}>
                      Docker Daemon Engine:
                    </span>
                    <span
                      className={`glass-badge ${overview?.infrastructure?.docker ? "glass-badge-success" : "glass-badge-warning"}`}
                    >
                      {overview?.infrastructure?.docker
                        ? "AVAILABLE"
                        : "OFFLINE / NOT RUNNING"}
                    </span>
                  </div>
                  <div
                    style={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <span style={{ color: "var(--fg-muted)" }}>
                      Runner Base Image:
                    </span>
                    <span
                      className={`glass-badge ${overview?.infrastructure?.runnerImage ? "glass-badge-success" : "glass-badge-warning"}`}
                    >
                      {overview?.infrastructure?.runnerImage
                        ? "cloudeeeide-runner:latest"
                        : "NOT FOUND"}
                    </span>
                  </div>
                  <div
                    style={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <span style={{ color: "var(--fg-muted)" }}>
                      Database WAL Storage:
                    </span>
                    <span className="glass-badge glass-badge-success">
                      SQLITE WAL ACTIVE
                    </span>
                  </div>
                  <div
                    style={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <span style={{ color: "var(--fg-muted)" }}>
                      cgroup v2 Quota Ceiling:
                    </span>
                    <span style={{ fontFamily: "var(--font-mono)" }}>
                      512 MB / 1.0 CPU Core
                    </span>
                  </div>
                </div>
              </div>

              <div className="admin-table-wrap" style={{ padding: "20px" }}>
                <h2
                  style={{
                    fontSize: "14px",
                    fontWeight: 600,
                    color: "var(--fg-primary)",
                    marginBottom: "14px",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  <IconDatabase size={15} color="#89b4fa" />
                  <span>Backup & Disaster Recovery Health</span>
                </h2>
                {backupHealthError ? (
                  <div style={{ fontSize: "13px", color: "#f38ba8" }}>
                    {backupHealthError}
                  </div>
                ) : !backupHealth ? (
                  <div
                    style={{
                      fontSize: "13px",
                      color: "var(--fg-muted)",
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    <IconRefresh size={13} className="spinning" />
                    <span>Loading backup posture...</span>
                  </div>
                ) : (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "10px",
                      fontSize: "13px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span style={{ color: "var(--fg-muted)" }}>
                        Database Backups:
                      </span>
                      <span
                        className={`glass-badge ${backupStatusBadgeClass(backupHealth.database.status)}`}
                      >
                        {backupHealth.database.status.toUpperCase()}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span style={{ color: "var(--fg-muted)" }}>
                        Latest DB Backup:
                      </span>
                      <span style={{ fontFamily: "var(--font-mono)" }}>
                        {formatAge(backupHealth.database.latestBackupAgeMs)} (
                        {backupHealth.database.backupCount} retained)
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span style={{ color: "var(--fg-muted)" }}>
                        Workspace Backup Coverage:
                      </span>
                      <span
                        className={`glass-badge ${backupStatusBadgeClass(backupHealth.workspaces.status)}`}
                      >
                        {backupHealth.workspaces.status.toUpperCase()}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span style={{ color: "var(--fg-muted)" }}>
                        Projects Covered:
                      </span>
                      <span style={{ fontFamily: "var(--font-mono)" }}>
                        {backupHealth.workspaces.coveredProjects} /{" "}
                        {backupHealth.workspaces.totalProjects} (
                        {backupHealth.workspaces.coveragePercent}%)
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span style={{ color: "var(--fg-muted)" }}>
                        Oldest Covered Backup:
                      </span>
                      <span style={{ fontFamily: "var(--font-mono)" }}>
                        {formatAge(
                          backupHealth.workspaces.oldestLatestBackupAgeMs,
                        )}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* =========================================================================
            TAB 2: SANDBOX OPERATIONS
            ========================================================================= */}
        {activeTab === "sandboxes" && (
          <div className="admin-table-wrap">
            <div className="admin-table-toolbar">
              <h2
                style={{
                  fontSize: "14px",
                  fontWeight: 600,
                  margin: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <IconServer size={16} color="#89b4fa" />
                <span>Active Sandboxes Pool ({sandboxes.length})</span>
              </h2>
              <span style={{ fontSize: "12px", color: "var(--fg-muted)" }}>
                Live 1Hz telemetry streaming via persistent control-plane
                WebSocket
              </span>
            </div>

            <div className="admin-table-scroll">
              {sandboxes.length === 0 ? (
                <div
                  style={{
                    padding: "40px",
                    textAlign: "center",
                    color: "var(--fg-muted)",
                    fontSize: "13px",
                  }}
                >
                  No active sandboxes currently running. Sandboxes spin up
                  on-demand when users run code or open a terminal.
                </div>
              ) : (
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Container ID</th>
                      <th>Workspace</th>
                      <th>Owner</th>
                      <th>Status</th>
                      <th>CPU</th>
                      <th>Memory</th>
                      <th>PIDs</th>
                      <th>Idle Time</th>
                      <th>Operator Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sandboxes.map((sb) => (
                      <tr key={sb.containerId}>
                        <td
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: "12px",
                            color: "#89b4fa",
                          }}
                        >
                          {sb.containerId}
                        </td>
                        <td>{sb.projectName}</td>
                        <td>{sb.ownerUsername}</td>
                        <td>
                          <span
                            className={`glass-badge ${sb.status === "running" ? "glass-badge-success" : "glass-badge-warning"}`}
                          >
                            {sb.status.toUpperCase()}
                          </span>
                        </td>
                        <td style={{ fontFamily: "var(--font-mono)" }}>
                          {sb.cpuPercent}%
                        </td>
                        <td style={{ fontFamily: "var(--font-mono)" }}>
                          {formatBytes(sb.memoryUsageBytes)}
                        </td>
                        <td style={{ fontFamily: "var(--font-mono)" }}>
                          {sb.pids}
                        </td>
                        <td style={{ color: "var(--fg-muted)" }}>
                          {sb.idleSeconds}s
                        </td>
                        <td>
                          <button
                            className="admin-action-btn danger"
                            onClick={() => setTerminatingSandbox(sb)}
                          >
                            <IconTrash size={11} />
                            <span>Terminate</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* =========================================================================
            TAB 3: EXECUTION MONITOR
            ========================================================================= */}
        {activeTab === "executions" && (
          <>
            {/* Execution Metrics Cards */}
            {execMetrics && (
              <div className="admin-cards-grid">
                <div className="admin-card">
                  <div className="admin-card-header">Success Rate</div>
                  <div
                    className="admin-card-value"
                    style={{ color: "#a6e3a1" }}
                  >
                    {execMetrics.successRatePercent}%
                  </div>
                  <div className="admin-card-sub">
                    <span>
                      {execMetrics.successCount} of {execMetrics.totalRuns} runs
                    </span>
                  </div>
                </div>

                <div className="admin-card">
                  <div className="admin-card-header">Failures & Errors</div>
                  <div
                    className="admin-card-value"
                    style={{
                      color:
                        execMetrics.failureCount > 0
                          ? "#f38ba8"
                          : "var(--fg-primary)",
                    }}
                  >
                    {execMetrics.failureCount}
                  </div>
                  <div className="admin-card-sub">
                    <span>Compiler & runtime faults</span>
                  </div>
                </div>

                <div className="admin-card">
                  <div className="admin-card-header">Timeouts & OOMs</div>
                  <div
                    className="admin-card-value"
                    style={{
                      color:
                        execMetrics.timeoutCount > 0
                          ? "#fab387"
                          : "var(--fg-primary)",
                    }}
                  >
                    {execMetrics.timeoutCount + execMetrics.oomCount}
                  </div>
                  <div className="admin-card-sub">
                    <span>
                      Timeouts: {execMetrics.timeoutCount} | OOMs:{" "}
                      {execMetrics.oomCount}
                    </span>
                  </div>
                </div>

                <div className="admin-card">
                  <div className="admin-card-header">Avg Execution Latency</div>
                  <div className="admin-card-value">
                    {execMetrics.avgDurationMs} ms
                  </div>
                  <div className="admin-card-sub">
                    <span>Across all languages</span>
                  </div>
                </div>
              </div>
            )}

            {/* Filterable Executions Table */}
            <div className="admin-table-wrap">
              <div className="admin-table-toolbar">
                <h2
                  style={{
                    fontSize: "14px",
                    fontWeight: 600,
                    margin: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  <IconCode size={16} color="#89b4fa" />
                  <span>Platform Execution Log ({runs.length})</span>
                </h2>

                <div style={{ display: "flex", gap: "10px" }}>
                  <select
                    className="glass-input"
                    value={execStatusFilter}
                    onChange={(e) => setExecStatusFilter(e.target.value)}
                    style={{ fontSize: "12px", padding: "4px 10px" }}
                  >
                    <option value="">All Statuses</option>
                    <option value="success">Success</option>
                    <option value="compile_error">Compile Error</option>
                    <option value="timeout">Timeout</option>
                    <option value="oom">OOM</option>
                    <option value="missing_toolchain">Missing Toolchain</option>
                  </select>

                  <select
                    className="glass-input"
                    value={execLangFilter}
                    onChange={(e) => setExecLangFilter(e.target.value)}
                    style={{ fontSize: "12px", padding: "4px 10px" }}
                  >
                    <option value="">All Languages</option>
                    <option value="python">Python</option>
                    <option value="c">C</option>
                    <option value="cpp">C++</option>
                    <option value="node">Node.js</option>
                    <option value="typescript">TypeScript</option>
                    <option value="java">Java</option>
                  </select>
                </div>
              </div>

              <div className="admin-table-scroll">
                {runs.length === 0 ? (
                  <div
                    style={{
                      padding: "40px",
                      textAlign: "center",
                      color: "var(--fg-muted)",
                      fontSize: "13px",
                    }}
                  >
                    No execution records match the active filter criteria.
                  </div>
                ) : (
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Execution ID</th>
                        <th>Workspace</th>
                        <th>User</th>
                        <th>Language</th>
                        <th>Entrypoint</th>
                        <th>Status</th>
                        <th>Exit</th>
                        <th>Duration</th>
                        <th>Timestamp</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((r) => (
                        <tr key={r.id}>
                          <td
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: "11px",
                              color: "#89b4fa",
                            }}
                          >
                            {r.id.slice(0, 8)}...
                          </td>
                          <td>{r.project_name || r.project_id.slice(0, 8)}</td>
                          <td>{r.username || `User #${r.user_id}`}</td>
                          <td>
                            <span
                              style={{
                                textTransform: "capitalize",
                                fontWeight: 500,
                              }}
                            >
                              {r.language}
                            </span>
                          </td>
                          <td
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: "12px",
                            }}
                          >
                            {r.file_path}
                          </td>
                          <td>
                            <span
                              className={`glass-badge ${r.status === "success" ? "glass-badge-success" : "glass-badge-warning"}`}
                            >
                              {r.status.toUpperCase()}
                            </span>
                          </td>
                          <td style={{ fontFamily: "var(--font-mono)" }}>
                            {r.exit_code ?? "-"}
                          </td>
                          <td style={{ fontFamily: "var(--font-mono)" }}>
                            {r.duration_ms}ms
                          </td>
                          <td
                            style={{
                              fontSize: "11px",
                              color: "var(--fg-muted)",
                            }}
                          >
                            {new Date(r.created_at).toLocaleTimeString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </>
        )}

        {/* =========================================================================
            TAB: RESOURCE ANALYTICS & HISTORIAN
            ========================================================================= */}
        {activeTab === "resources" && <AdminResourceAnalytics />}

        {/* =========================================================================
            TAB 4: TENANTS & WORKSPACES (With Full Scrolling, Search, Filter, Sort)
            ========================================================================= */}
        {activeTab === "tenants" && (
          <div className="admin-table-wrap">
            <div className="admin-table-toolbar">
              <div
                style={{ display: "flex", gap: "8px", alignItems: "center" }}
              >
                <button
                  className={`glass-btn ${tenantSubTab === "users" ? "glass-btn-primary" : "glass-btn-ghost"}`}
                  onClick={() => setTenantSubTab("users")}
                  style={{ fontSize: "12px", padding: "6px 14px" }}
                >
                  <IconUsers size={13} />
                  <span>Users Directory ({users.length})</span>
                </button>
                <button
                  className={`glass-btn ${tenantSubTab === "projects" ? "glass-btn-primary" : "glass-btn-ghost"}`}
                  onClick={() => setTenantSubTab("projects")}
                  style={{ fontSize: "12px", padding: "6px 14px" }}
                >
                  <IconLayers size={13} />
                  <span>Workspaces Catalog ({projects.length})</span>
                </button>
              </div>

              {tenantSubTab === "users" && (
                <div
                  style={{
                    display: "flex",
                    gap: "10px",
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <input
                    type="text"
                    className="admin-search-input"
                    placeholder="Search username or ID..."
                    value={userSearch}
                    onChange={(e) => setUserSearch(e.target.value)}
                  />

                  <select
                    className="glass-input"
                    value={userRoleFilter}
                    onChange={(e) => setUserRoleFilter(e.target.value as any)}
                    style={{ fontSize: "12px", padding: "4px 8px" }}
                  >
                    <option value="all">All Roles</option>
                    <option value="admin">Admins Only</option>
                    <option value="user">Regular Users</option>
                  </select>

                  <select
                    className="glass-input"
                    value={userTypeFilter}
                    onChange={(e) => setUserTypeFilter(e.target.value as any)}
                    style={{ fontSize: "12px", padding: "4px 8px" }}
                  >
                    <option value="all">All Account Types</option>
                    <option value="standard">Standard Users</option>
                    <option value="demo">Demo Guests</option>
                  </select>
                </div>
              )}
            </div>

            <div className="admin-table-scroll">
              {tenantSubTab === "users" ? (
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th
                        className="sortable"
                        onClick={() => handleUserSort("id")}
                      >
                        ID{" "}
                        {userSortField === "id"
                          ? userSortAsc
                            ? "▲"
                            : "▼"
                          : ""}
                      </th>
                      <th
                        className="sortable"
                        onClick={() => handleUserSort("username")}
                      >
                        Username{" "}
                        {userSortField === "username"
                          ? userSortAsc
                            ? "▲"
                            : "▼"
                          : ""}
                      </th>
                      <th>Role</th>
                      <th>Account Type</th>
                      <th
                        className="sortable"
                        onClick={() => handleUserSort("project_count")}
                      >
                        Projects{" "}
                        {userSortField === "project_count"
                          ? userSortAsc
                            ? "▲"
                            : "▼"
                          : ""}
                      </th>
                      <th
                        className="sortable"
                        onClick={() => handleUserSort("execution_count")}
                      >
                        Executions{" "}
                        {userSortField === "execution_count"
                          ? userSortAsc
                            ? "▲"
                            : "▼"
                          : ""}
                      </th>
                      <th
                        className="sortable"
                        onClick={() => handleUserSort("created_at")}
                      >
                        Created{" "}
                        {userSortField === "created_at"
                          ? userSortAsc
                            ? "▲"
                            : "▼"
                          : ""}
                      </th>
                      <th>Administrative Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.length === 0 ? (
                      <tr>
                        <td
                          colSpan={8}
                          style={{
                            textAlign: "center",
                            padding: "30px",
                            color: "var(--fg-muted)",
                          }}
                        >
                          No users match active search and filter criteria.
                        </td>
                      </tr>
                    ) : (
                      filteredUsers.map((u) => (
                        <tr key={u.id}>
                          <td
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: "12px",
                            }}
                          >
                            #{u.id}
                          </td>
                          <td style={{ fontWeight: 600 }}>{u.username}</td>
                          <td>
                            <span
                              className={`glass-badge ${u.role === "admin" ? "glass-badge-error" : "glass-badge-info"}`}
                            >
                              {u.role.toUpperCase()}
                            </span>
                          </td>
                          <td>
                            {u.isDemo ? (
                              <span className="glass-badge glass-badge-warning">
                                DISPOSABLE DEMO
                              </span>
                            ) : (
                              <span
                                style={{
                                  color: "var(--fg-muted)",
                                  fontSize: "12px",
                                }}
                              >
                                Standard
                              </span>
                            )}
                          </td>
                          <td style={{ fontFamily: "var(--font-mono)" }}>
                            {u.project_count}
                          </td>
                          <td style={{ fontFamily: "var(--font-mono)" }}>
                            {u.execution_count}
                          </td>
                          <td
                            style={{
                              fontSize: "11px",
                              color: "var(--fg-muted)",
                            }}
                          >
                            {new Date(u.created_at).toLocaleDateString()}
                          </td>
                          <td>
                            <div style={{ display: "flex", gap: "6px" }}>
                              <button
                                className="admin-action-btn"
                                onClick={() => handleInspectUser(u.id)}
                                title="Inspect User Details & Workspaces"
                              >
                                <span>Inspect</span>
                              </button>
                              <button
                                className="admin-action-btn"
                                onClick={() => openEditModal(u)}
                                title="Edit Username or Role"
                              >
                                <IconEdit size={11} />
                                <span>Edit</span>
                              </button>
                              <button
                                className="admin-action-btn"
                                onClick={() => openResetPasswordModal(u)}
                                title="Reset User Password & Invalidate Sessions"
                              >
                                <span>Reset Pass</span>
                              </button>
                              <button
                                className="admin-action-btn danger"
                                onClick={() => openDeleteModal(u)}
                                title="Delete User and Cascade Cleanup Workspaces"
                              >
                                <IconTrash size={11} />
                                <span>Delete</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              ) : (
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Project ID</th>
                      <th>Workspace Name</th>
                      <th>Language</th>
                      <th>Owner</th>
                      <th>Snapshots</th>
                      <th>Executions</th>
                      <th>Last Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((p) => (
                      <tr key={p.id}>
                        <td
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: "11px",
                            color: "#89b4fa",
                          }}
                        >
                          {p.id.slice(0, 8)}...
                        </td>
                        <td style={{ fontWeight: 600 }}>{p.name}</td>
                        <td style={{ textTransform: "capitalize" }}>
                          {p.language}
                        </td>
                        <td>{p.owner_username}</td>
                        <td style={{ fontFamily: "var(--font-mono)" }}>
                          {p.snapshot_count}
                        </td>
                        <td style={{ fontFamily: "var(--font-mono)" }}>
                          {p.run_count}
                        </td>
                        <td
                          style={{ fontSize: "11px", color: "var(--fg-muted)" }}
                        >
                          {new Date(p.updated_at).toLocaleDateString()}{" "}
                          {new Date(p.updated_at).toLocaleTimeString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* =========================================================================
            TAB 5: AUDIT JOURNAL
            ========================================================================= */}
        {activeTab === "audit" && (
          <div className="admin-table-wrap">
            <div className="admin-table-toolbar">
              <h2
                style={{
                  fontSize: "14px",
                  fontWeight: 600,
                  margin: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <IconShield size={16} color="#f38ba8" />
                <span>
                  Security & Operations Audit Trail ({auditLogs.length})
                </span>
              </h2>

              <select
                className="glass-input"
                value={auditEventFilter}
                onChange={(e) => setAuditEventFilter(e.target.value)}
                style={{ fontSize: "12px", padding: "4px 10px" }}
              >
                <option value="">All Event Types</option>
                <option value="AUTH_LOGIN">AUTH_LOGIN</option>
                <option value="ADMIN_LOGIN">ADMIN_LOGIN</option>
                <option value="AUTH_FAILED_LOGIN">AUTH_FAILED_LOGIN</option>
                <option value="DEMO_SESSION_CREATED">
                  DEMO_SESSION_CREATED
                </option>
                <option value="USER_UPDATED_BY_ADMIN">
                  USER_UPDATED_BY_ADMIN
                </option>
                <option value="USER_PASSWORD_RESET_BY_ADMIN">
                  USER_PASSWORD_RESET_BY_ADMIN
                </option>
                <option value="USER_DELETED_BY_ADMIN">
                  USER_DELETED_BY_ADMIN
                </option>
                <option value="SANDBOX_TERMINATED_BY_ADMIN">
                  SANDBOX_TERMINATED_BY_ADMIN
                </option>
                <option value="PROJECT_CREATED">PROJECT_CREATED</option>
                <option value="SNAPSHOT_CREATED">SNAPSHOT_CREATED</option>
                <option value="SNAPSHOT_RESTORED">SNAPSHOT_RESTORED</option>
              </select>
            </div>

            <div className="admin-table-scroll">
              {auditLogs.length === 0 ? (
                <div
                  style={{
                    padding: "40px",
                    textAlign: "center",
                    color: "var(--fg-muted)",
                    fontSize: "13px",
                  }}
                >
                  No audit events recorded matching filter.
                </div>
              ) : (
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Timestamp</th>
                      <th>Event Type</th>
                      <th>Actor</th>
                      <th>Workspace</th>
                      <th>IP Address</th>
                      <th>Metadata</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditLogs.map((log) => (
                      <tr key={log.id}>
                        <td
                          style={{
                            fontSize: "11px",
                            color: "var(--fg-muted)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {new Date(log.created_at).toLocaleString()}
                        </td>
                        <td>
                          <span
                            className={`glass-badge ${
                              log.event_type.startsWith("ADMIN") ||
                              log.event_type.includes("TERMINATED") ||
                              log.event_type.includes("DELETED")
                                ? "glass-badge-error"
                                : log.event_type.includes("FAILED")
                                  ? "glass-badge-warning"
                                  : "glass-badge-info"
                            }`}
                          >
                            {log.event_type}
                          </span>
                        </td>
                        <td style={{ fontWeight: 500 }}>
                          {log.username ||
                            (log.user_id
                              ? `User #${log.user_id}`
                              : "Anonymous")}
                        </td>
                        <td>
                          {log.project_name ||
                            (log.project_id ? log.project_id.slice(0, 8) : "-")}
                        </td>
                        <td
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: "11px",
                            color: "var(--fg-muted)",
                          }}
                        >
                          {log.ip_address || "-"}
                        </td>
                        <td
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: "11px",
                            maxWidth: "300px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {JSON.stringify(log.details)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {activeTab === "backups" && <AdminBackupsPanel projects={projects} />}
      </main>

      {/* =========================================================================
          MODAL 1: USER INSPECTOR DRAWER / MODAL
          ========================================================================= */}
      {inspectingUser && (
        <div className="admin-modal-overlay" role="dialog" aria-modal="true">
          <div className="admin-drawer-card">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                borderBottom: "1px solid var(--glass-border-subtle)",
                paddingBottom: "14px",
              }}
            >
              <div
                style={{ display: "flex", alignItems: "center", gap: "12px" }}
              >
                <div
                  style={{
                    width: "40px",
                    height: "40px",
                    borderRadius: "10px",
                    background: "rgba(137, 180, 250, 0.15)",
                    color: "#89b4fa",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <IconUsers size={20} />
                </div>
                <div>
                  <h3
                    style={{
                      margin: 0,
                      fontSize: "17px",
                      fontWeight: 600,
                      color: "var(--fg-primary)",
                    }}
                  >
                    User Inspector: {inspectingUser.user.username}
                  </h3>
                  <p
                    style={{
                      margin: "2px 0 0 0",
                      fontSize: "12px",
                      color: "var(--fg-muted)",
                    }}
                  >
                    User ID #{inspectingUser.user.id} • Registered{" "}
                    {new Date(inspectingUser.user.created_at).toLocaleString()}
                  </p>
                </div>
              </div>

              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  className="glass-btn glass-btn-secondary"
                  onClick={() => openEditModal(inspectingUser.user)}
                  style={{ fontSize: "12px", padding: "5px 10px" }}
                >
                  <IconEdit size={12} />
                  <span>Edit</span>
                </button>
                <button
                  className="glass-btn glass-btn-secondary"
                  onClick={() => openResetPasswordModal(inspectingUser.user)}
                  style={{ fontSize: "12px", padding: "5px 10px" }}
                >
                  <span>Reset Pass</span>
                </button>
                <button
                  className="glass-btn glass-btn-ghost"
                  onClick={() => setInspectingUser(null)}
                  style={{ fontSize: "12px" }}
                >
                  ✕ Close
                </button>
              </div>
            </div>

            {/* User Quotas & Resource Metrics */}
            <div
              className="admin-cards-grid"
              style={{ gridTemplateColumns: "repeat(4, 1fr)" }}
            >
              <div className="admin-card" style={{ padding: "12px" }}>
                <div className="admin-card-header" style={{ fontSize: "10px" }}>
                  Projects
                </div>
                <div className="admin-card-value" style={{ fontSize: "20px" }}>
                  {inspectingUser.counts.projectCount}
                </div>
              </div>
              <div className="admin-card" style={{ padding: "12px" }}>
                <div className="admin-card-header" style={{ fontSize: "10px" }}>
                  Executions
                </div>
                <div className="admin-card-value" style={{ fontSize: "20px" }}>
                  {inspectingUser.counts.executionCount}
                </div>
              </div>
              <div className="admin-card" style={{ padding: "12px" }}>
                <div className="admin-card-header" style={{ fontSize: "10px" }}>
                  Snapshots
                </div>
                <div className="admin-card-value" style={{ fontSize: "20px" }}>
                  {inspectingUser.counts.snapshotCount}
                </div>
              </div>
              <div className="admin-card" style={{ padding: "12px" }}>
                <div className="admin-card-header" style={{ fontSize: "10px" }}>
                  Active Containers
                </div>
                <div
                  className="admin-card-value"
                  style={{ fontSize: "20px", color: "#a6e3a1" }}
                >
                  {inspectingUser.counts.activeSandboxesCount}
                </div>
              </div>
            </div>

            {/* User Workspaces */}
            <div className="admin-drawer-section">
              <h4>
                <IconLayers size={14} color="#89b4fa" />
                <span>Workspaces ({inspectingUser.projects.length})</span>
              </h4>
              {inspectingUser.projects.length === 0 ? (
                <span style={{ fontSize: "12px", color: "var(--fg-muted)" }}>
                  No projects created yet.
                </span>
              ) : (
                <div style={{ maxHeight: "160px", overflowY: "auto" }}>
                  <table className="admin-table" style={{ fontSize: "12px" }}>
                    <thead>
                      <tr>
                        <th>Workspace Name</th>
                        <th>Language</th>
                        <th>Created</th>
                        <th>Last Modified</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inspectingUser.projects.map((p) => (
                        <tr key={p.id}>
                          <td style={{ fontWeight: 600 }}>{p.name}</td>
                          <td style={{ textTransform: "capitalize" }}>
                            {p.language}
                          </td>
                          <td>{new Date(p.created_at).toLocaleDateString()}</td>
                          <td>{new Date(p.updated_at).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Recent Executions */}
            <div className="admin-drawer-section">
              <h4>
                <IconCode size={14} color="#f9e2af" />
                <span>
                  Recent Execution History (
                  {inspectingUser.recentExecutions.length})
                </span>
              </h4>
              {inspectingUser.recentExecutions.length === 0 ? (
                <span style={{ fontSize: "12px", color: "var(--fg-muted)" }}>
                  No executions recorded.
                </span>
              ) : (
                <div style={{ maxHeight: "160px", overflowY: "auto" }}>
                  <table className="admin-table" style={{ fontSize: "12px" }}>
                    <thead>
                      <tr>
                        <th>Workspace</th>
                        <th>Language</th>
                        <th>Status</th>
                        <th>Duration</th>
                        <th>Timestamp</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inspectingUser.recentExecutions.map((r) => (
                        <tr key={r.id}>
                          <td>{r.project_name || r.project_id.slice(0, 8)}</td>
                          <td>{r.language}</td>
                          <td>
                            <span
                              className={`glass-badge ${r.status === "success" ? "glass-badge-success" : "glass-badge-warning"}`}
                            >
                              {r.status.toUpperCase()}
                            </span>
                          </td>
                          <td style={{ fontFamily: "var(--font-mono)" }}>
                            {r.duration_ms}ms
                          </td>
                          <td style={{ color: "var(--fg-muted)" }}>
                            {new Date(r.created_at).toLocaleTimeString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Recent Audit Events */}
            <div className="admin-drawer-section">
              <h4>
                <IconShield size={14} color="#f38ba8" />
                <span>
                  Audit Journal Entries for User (
                  {inspectingUser.recentAuditLogs.length})
                </span>
              </h4>
              {inspectingUser.recentAuditLogs.length === 0 ? (
                <span style={{ fontSize: "12px", color: "var(--fg-muted)" }}>
                  No audit events logged for this user.
                </span>
              ) : (
                <div style={{ maxHeight: "160px", overflowY: "auto" }}>
                  <table className="admin-table" style={{ fontSize: "12px" }}>
                    <thead>
                      <tr>
                        <th>Timestamp</th>
                        <th>Event</th>
                        <th>IP Address</th>
                        <th>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inspectingUser.recentAuditLogs.map((l) => (
                        <tr key={l.id}>
                          <td style={{ color: "var(--fg-muted)" }}>
                            {new Date(l.created_at).toLocaleTimeString()}
                          </td>
                          <td>
                            <span className="glass-badge glass-badge-info">
                              {l.event_type}
                            </span>
                          </td>
                          <td style={{ fontFamily: "var(--font-mono)" }}>
                            {l.ip_address || "-"}
                          </td>
                          <td
                            style={{
                              fontFamily: "var(--font-mono)",
                              maxWidth: "240px",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {JSON.stringify(l.details)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          MODAL 2: EDIT USER ATTRIBUTES
          ========================================================================= */}
      {editingUser && (
        <div className="admin-modal-overlay" role="dialog" aria-modal="true">
          <div className="admin-modal-card">
            <h3
              style={{
                margin: "0 0 6px 0",
                fontSize: "16px",
                fontWeight: 600,
                color: "var(--fg-primary)",
              }}
            >
              Edit User: {editingUser.username}
            </h3>
            <p
              style={{
                margin: "0 0 16px 0",
                fontSize: "12px",
                color: "var(--fg-muted)",
              }}
            >
              Modify administrative role or identifier for User #
              {editingUser.id}
            </p>

            {editError && (
              <div
                className="glass-banner glass-banner-error"
                style={{ marginBottom: "14px", fontSize: "12px" }}
              >
                <span>{editError}</span>
              </div>
            )}

            <form
              onSubmit={handleEditSubmit}
              style={{ display: "flex", flexDirection: "column", gap: "14px" }}
            >
              <div className="glass-form-group">
                <label className="glass-label" htmlFor="edit-username">
                  Username
                </label>
                <input
                  id="edit-username"
                  type="text"
                  className="glass-input"
                  value={editUsername}
                  onChange={(e) => setEditUsername(e.target.value)}
                  pattern="^[a-zA-Z0-9_]{3,32}$"
                  required
                />
              </div>

              <div className="glass-form-group">
                <label className="glass-label" htmlFor="edit-role">
                  Role & Permissions
                </label>
                <select
                  id="edit-role"
                  className="glass-input"
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value as any)}
                >
                  <option value="user">User (Workload Plane Developer)</option>
                  <option value="admin">Admin (Control Plane Operator)</option>
                </select>
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: "10px",
                  marginTop: "10px",
                }}
              >
                <button
                  type="button"
                  className="glass-btn glass-btn-ghost"
                  onClick={() => setEditingUser(null)}
                  disabled={editLoading}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="glass-btn glass-btn-primary"
                  disabled={editLoading}
                >
                  {editLoading ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* =========================================================================
          MODAL 3: SECURE PASSWORD RESET
          ========================================================================= */}
      {resettingPasswordUser && (
        <div className="admin-modal-overlay" role="dialog" aria-modal="true">
          <div className="admin-modal-card">
            <h3
              style={{
                margin: "0 0 6px 0",
                fontSize: "16px",
                fontWeight: 600,
                color: "var(--fg-primary)",
              }}
            >
              Reset Password: {resettingPasswordUser.username}
            </h3>
            <p
              style={{
                margin: "0 0 16px 0",
                fontSize: "12px",
                color: "var(--fg-muted)",
              }}
            >
              Set a new secure password. All existing login sessions will be
              immediately invalidated.
            </p>

            {resetError && (
              <div
                className="glass-banner glass-banner-error"
                style={{ marginBottom: "14px", fontSize: "12px" }}
              >
                <span>{resetError}</span>
              </div>
            )}

            <form
              onSubmit={handleResetPasswordSubmit}
              style={{ display: "flex", flexDirection: "column", gap: "14px" }}
            >
              <div className="glass-form-group">
                <label className="glass-label" htmlFor="reset-new-password">
                  New Password (Min 8 characters)
                </label>
                <input
                  id="reset-new-password"
                  type="password"
                  className="glass-input"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="••••••••••••"
                  minLength={8}
                  required
                  autoFocus
                />
              </div>

              <div
                style={{
                  background: "rgba(249, 226, 175, 0.1)",
                  border: "1px solid rgba(249, 226, 175, 0.25)",
                  borderRadius: "8px",
                  padding: "10px",
                  fontSize: "12px",
                  color: "#f9e2af",
                }}
              >
                ⚠️ <strong>Session Invalidation:</strong> Applying this change
                will revoke all active browser session tokens for{" "}
                <strong>{resettingPasswordUser.username}</strong> immediately.
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: "10px",
                  marginTop: "10px",
                }}
              >
                <button
                  type="button"
                  className="glass-btn glass-btn-ghost"
                  onClick={() => setResettingPasswordUser(null)}
                  disabled={resetLoading}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="glass-btn glass-btn-primary"
                  disabled={resetLoading}
                  style={{ background: "#fab387", color: "#090b10" }}
                >
                  {resetLoading ? "Resetting..." : "Confirm Password Reset"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* =========================================================================
          MODAL 4: DESTRUCTIVE DELETE USER CONFIRMATION
          ========================================================================= */}
      {deletingUser && (
        <div className="admin-modal-overlay" role="dialog" aria-modal="true">
          <div
            className="admin-modal-card"
            style={{ border: "1px solid rgba(243, 139, 168, 0.4)" }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                marginBottom: "14px",
              }}
            >
              <div
                style={{
                  width: "36px",
                  height: "36px",
                  borderRadius: "10px",
                  background: "rgba(243, 139, 168, 0.15)",
                  color: "#f38ba8",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <IconAlertTriangle size={20} />
              </div>
              <div>
                <h3
                  style={{
                    margin: 0,
                    fontSize: "16px",
                    fontWeight: 600,
                    color: "var(--fg-primary)",
                  }}
                >
                  Confirm User Deletion
                </h3>
                <p
                  style={{
                    margin: 0,
                    fontSize: "12px",
                    color: "var(--fg-muted)",
                  }}
                >
                  Permanent cascade cleanup of tenant data
                </p>
              </div>
            </div>

            {deleteError && (
              <div
                className="glass-banner glass-banner-error"
                style={{ marginBottom: "14px", fontSize: "12px" }}
              >
                <span>{deleteError}</span>
              </div>
            )}

            <p
              style={{
                fontSize: "13px",
                color: "var(--fg-secondary)",
                lineHeight: 1.5,
                marginBottom: "14px",
              }}
            >
              Are you sure you want to permanently delete user{" "}
              <strong style={{ color: "#f38ba8" }}>
                {deletingUser.username}
              </strong>{" "}
              (ID #{deletingUser.id})?
            </p>

            <div
              style={{
                background: "rgba(0,0,0,0.3)",
                padding: "12px 14px",
                borderRadius: "8px",
                marginBottom: "20px",
                fontSize: "12px",
                color: "var(--fg-muted)",
                lineHeight: 1.6,
              }}
            >
              <strong>The following data will be permanently purged:</strong>
              <br />• All {deletingUser.project_count} project workspaces and
              files on disk
              <br />
              • All associated Docker sandboxes stopped & removed
              <br />
              • All snapshot tarballs and execution logs
              <br />
              • All active session tokens revoked
              <br />• Audit history will record this administrative action
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "10px",
              }}
            >
              <button
                className="glass-btn glass-btn-ghost"
                onClick={() => setDeletingUser(null)}
                disabled={deleteLoading}
              >
                Cancel
              </button>
              <button
                className="glass-btn"
                onClick={handleDeleteUserSubmit}
                disabled={deleteLoading}
                style={{
                  background: "rgba(243, 139, 168, 0.3)",
                  color: "#f38ba8",
                  border: "1px solid rgba(243, 139, 168, 0.4)",
                  fontWeight: 600,
                }}
              >
                {deleteLoading ? "Purging User..." : "Permanently Delete User"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          MODAL 5: OPERATOR SANDBOX TERMINATION CONFIRMATION
          ========================================================================= */}
      {terminatingSandbox && (
        <div className="admin-modal-overlay" role="dialog" aria-modal="true">
          <div className="admin-modal-card">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                marginBottom: "16px",
              }}
            >
              <div
                style={{
                  width: "36px",
                  height: "36px",
                  borderRadius: "10px",
                  background: "rgba(243, 139, 168, 0.15)",
                  color: "#f38ba8",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <IconAlertTriangle size={18} />
              </div>
              <div>
                <h3
                  style={{
                    margin: 0,
                    fontSize: "15px",
                    fontWeight: 600,
                    color: "var(--fg-primary)",
                  }}
                >
                  Confirm Sandbox Termination
                </h3>
                <p
                  style={{
                    margin: 0,
                    fontSize: "12px",
                    color: "var(--fg-muted)",
                  }}
                >
                  Operator-level Docker container kill & teardown
                </p>
              </div>
            </div>

            <p
              style={{
                fontSize: "13px",
                color: "var(--fg-secondary)",
                lineHeight: 1.5,
                marginBottom: "16px",
              }}
            >
              Are you sure you want to forcibly stop container{" "}
              <strong
                style={{ color: "#89b4fa", fontFamily: "var(--font-mono)" }}
              >
                {terminatingSandbox.containerId}
              </strong>{" "}
              (Workspace: <strong>{terminatingSandbox.projectName}</strong>)?
            </p>

            <div
              style={{
                background: "rgba(0,0,0,0.25)",
                padding: "10px 14px",
                borderRadius: "8px",
                marginBottom: "20px",
                fontSize: "12px",
                color: "var(--fg-muted)",
              }}
            >
              • In-flight terminal or web execution processes will be terminated
              immediately.
              <br />
              • Workspace files on disk remain safe.
              <br />• Action will be permanently recorded in the immutable audit
              journal.
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "10px",
              }}
            >
              <button
                className="glass-btn glass-btn-ghost"
                onClick={() => setTerminatingSandbox(null)}
                disabled={terminateLoading}
              >
                Cancel
              </button>
              <button
                className="glass-btn"
                onClick={handleTerminateConfirm}
                disabled={terminateLoading}
                style={{
                  background: "rgba(243, 139, 168, 0.3)",
                  color: "#f38ba8",
                  border: "1px solid rgba(243, 139, 168, 0.4)",
                  fontWeight: 600,
                }}
              >
                {terminateLoading ? "Terminating..." : "Terminate Sandbox"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
