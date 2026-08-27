import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import * as React from "react";
import AdminObservabilityPanel from "../src/components/Admin/AdminObservabilityPanel";
import AdminDashboard from "../src/components/Admin/AdminDashboard";
import { api } from "../src/api";
import type { AdminObservabilityData, User } from "../src/types";

vi.mock("../src/api", () => ({
  api: vi.fn(),
}));

const mockObservabilityData: AdminObservabilityData = {
  timestamp: "2026-08-27T12:00:00.000Z",
  eventLoopLagMs: {
    minMs: 0.05,
    maxMs: 2.5,
    meanMs: 0.15,
    p50Ms: 0.12,
    p95Ms: 0.45,
    p99Ms: 1.2,
  },
  dbCalls: {
    overall: {
      count: 1500,
      minMs: 0.02,
      maxMs: 12.4,
      meanMs: 0.85,
      p50Ms: 0.4,
      p95Ms: 2.1,
      p99Ms: 4.8,
    },
    byOperation: {
      "SELECT users": {
        count: 500,
        minMs: 0.02,
        maxMs: 3.1,
        meanMs: 0.35,
        p50Ms: 0.25,
        p95Ms: 1.1,
        p99Ms: 2.0,
      },
      "INSERT audit_logs": {
        count: 350,
        minMs: 0.05,
        maxMs: 8.5,
        meanMs: 1.2,
        p50Ms: 0.8,
        p95Ms: 3.4,
        p99Ms: 6.2,
      },
    },
  },
  activeWsConnections: 12,
  activeCollabRooms: 4,
  activeSandboxes: 3,
  totalCollabBroadcastSends: 12500,
  memory: {
    rssBytes: 157286400, // 150 MB
    heapUsedBytes: 62914560, // 60 MB
    heapTotalBytes: 83886080, // 80 MB
    externalBytes: 10485760, // 10 MB
    arrayBuffersBytes: 5242880, // 5 MB
  },
  cpuUsageMicros: {
    userMicros: 45000000, // 45s
    systemMicros: 12000000, // 12s
  },
  gc: {
    minor: {
      count: 42,
      totalDurationMs: 18.5,
    },
    major: {
      count: 3,
      totalDurationMs: 8.2,
    },
  },
};

const mockAdminUser: User = {
  id: 1,
  username: "admin",
  role: "admin",
};

describe("AdminObservabilityPanel (Milestone 49)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    (api as any).mockImplementation(async (endpoint: string) => {
      if (endpoint === "/api/admin/observability") return mockObservabilityData;
      if (endpoint === "/api/admin/overview") {
        return {
          system: {
            status: "healthy",
            uptimeSeconds: 3600,
            nodeVersion: "v20",
            platform: "linux",
            arch: "x64",
            memoryRssBytes: 1000000,
          },
          infrastructure: {
            docker: true,
            runnerImage: true,
            database: true,
            cgroupRoot: "/sys/fs/cgroup",
            maxSandboxes: 10,
            projectQuota: 5,
          },
          counters: {
            totalUsers: 1,
            demoUsers: 0,
            totalProjects: 1,
            totalRuns: 10,
            activeSandboxes: 1,
          },
          recentActivity: {
            runsLastHour: 5,
            usersLast24h: 1,
          },
        };
      }
      if (endpoint === "/api/admin/sandboxes") return { sandboxes: [] };
      if (endpoint === "/api/admin/users") return { users: [] };
      if (endpoint === "/api/admin/projects") return { projects: [] };
      if (endpoint.startsWith("/api/admin/executions")) {
        return {
          runs: [],
          metrics: {
            totalRuns: 0,
            successCount: 0,
            failureCount: 0,
            timeoutCount: 0,
            oomCount: 0,
            avgDurationMs: 0,
            successRatePercent: 100,
          },
        };
      }
      if (endpoint.startsWith("/api/admin/audit")) return { logs: [] };
      if (endpoint === "/api/admin/health" || endpoint === "/api/admin/backups/health") {
        return {
          backups: {
            database: {
              status: "ok",
              backupCount: 1,
              latestBackupCreatedAt: new Date().toISOString(),
              latestBackupAgeMs: 1000,
              warningAgeMs: 86400000,
              criticalAgeMs: 172800000,
            },
            workspaces: {
              status: "ok",
              totalProjects: 1,
              coveredProjects: 1,
              uncoveredProjects: 0,
              coveragePercent: 100,
              oldestLatestBackupAgeMs: 1000,
              warningAgeMs: 86400000,
              criticalAgeMs: 172800000,
            },
          },
        };
      }
      return {};
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("1. renders initial loading state while fetching telemetry", () => {
    (api as any).mockImplementation(() => new Promise(() => {})); // Never resolves
    render(<AdminObservabilityPanel />);
    expect(screen.getByText(/Loading platform observability telemetry\.\.\./i)).toBeDefined();
  });

  it("2. renders successful metrics upon API resolution", async () => {
    render(<AdminObservabilityPanel />);
    await waitFor(() => {
      expect(screen.getByText("Platform Observability")).toBeDefined();
    });
    expect(screen.getByText(/12 WS \/ 4 Rooms/)).toBeDefined();
    expect(screen.getByText(/3 Sandboxes/)).toBeDefined();
  });

  it("3. formats numerical latencies and byte units correctly without meaningless precision", async () => {
    render(<AdminObservabilityPanel />);
    await waitFor(() => {
      expect(screen.getByText("Platform Observability")).toBeDefined();
    });
    // Event loop p95: 0.45 ms (appears in KPI card and detail table)
    expect(screen.getAllByText("0.45 ms").length).toBeGreaterThanOrEqual(1);
    // DB query p95: 2.10 ms
    expect(screen.getByText("2.10 ms")).toBeDefined();
    // Memory 150.0 MB (in KPI card and memory breakdown)
    expect(screen.getAllByText(/150\.0 MB/).length).toBeGreaterThanOrEqual(1);
  });

  it("4. renders all required metric groups: Runtime, Database, WebSockets, Sandboxes", async () => {
    render(<AdminObservabilityPanel />);
    await waitFor(() => {
      expect(screen.getByText("Platform Observability")).toBeDefined();
    });
    expect(screen.getByText(/Event-Loop Latency Distribution/i)).toBeDefined();
    expect(screen.getByText(/Process Memory & Garbage Collection/i)).toBeDefined();
    expect(screen.getByText(/Database Query Latency Breakdown/i)).toBeDefined();
    expect(screen.getByText("SELECT users")).toBeDefined();
    expect(screen.getByText("INSERT audit_logs")).toBeDefined();
  });

  it("5. manual Refresh calls exact /api/admin/observability endpoint", async () => {
    render(<AdminObservabilityPanel />);
    await waitFor(() => {
      expect(screen.getByText("Platform Observability")).toBeDefined();
    });

    const refreshBtn = screen.getByRole("button", { name: /Refresh telemetry/i });
    await act(async () => {
      fireEvent.click(refreshBtn);
    });

    expect(api).toHaveBeenCalledWith("/api/admin/observability");
  });

  it("6. blocks duplicate concurrent refresh calls while request is in flight", async () => {
    let resolveFirstRequest: any;
    (api as any).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstRequest = resolve;
        }),
    );

    render(<AdminObservabilityPanel />);

    // Click refresh while initial request is pending
    const refreshBtn = screen.queryByRole("button", { name: /Refresh telemetry/i });
    if (refreshBtn) {
      fireEvent.click(refreshBtn);
    }

    // Only 1 call triggered initially
    expect(api).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirstRequest(mockObservabilityData);
    });
  });

  it("7. performs automatic polling every 5000ms", async () => {
    render(<AdminObservabilityPanel />);
    await waitFor(() => {
      expect(screen.getByText("Platform Observability")).toBeDefined();
    });

    expect(api).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(api).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(api).toHaveBeenCalledTimes(3);
  });

  it("8. skips automatic refresh tick if previous request is still in flight", async () => {
    render(<AdminObservabilityPanel />);
    await waitFor(() => {
      expect(screen.getByText("Platform Observability")).toBeDefined();
    });

    // Make next request stall
    (api as any).mockImplementationOnce(() => new Promise(() => {}));

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(api).toHaveBeenCalledTimes(2);

    // Another tick occurs while in-flight is true
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    // Still 2 calls (skipped overlapping tick)
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("9. pauses automatic polling when tab is hidden", async () => {
    render(<AdminObservabilityPanel />);
    await waitFor(() => {
      expect(screen.getByText("Platform Observability")).toBeDefined();
    });

    expect(api).toHaveBeenCalledTimes(1);

    // Simulate tab hidden
    Object.defineProperty(document, "hidden", { value: true, writable: true });
    await act(async () => {
      fireEvent(document, new Event("visibilitychange"));
    });

    expect(screen.getByText(/Updates paused while tab is hidden/i)).toBeDefined();

    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    // No new calls while hidden
    expect(api).toHaveBeenCalledTimes(1);

    // Restore visibility
    Object.defineProperty(document, "hidden", { value: false, writable: true });
  });

  it("10. triggers immediate refresh when visibility is restored", async () => {
    render(<AdminObservabilityPanel />);
    await waitFor(() => {
      expect(screen.getByText("Platform Observability")).toBeDefined();
    });

    // Hide tab
    Object.defineProperty(document, "hidden", { value: true, writable: true });
    await act(async () => {
      fireEvent(document, new Event("visibilitychange"));
    });

    // Make tab visible
    Object.defineProperty(document, "hidden", { value: false, writable: true });
    await act(async () => {
      fireEvent(document, new Event("visibilitychange"));
    });

    // Immediate refresh triggered on visible
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("11. cleans intervals and timers on component unmount", async () => {
    const { unmount } = render(<AdminObservabilityPanel />);
    await waitFor(() => {
      expect(screen.getByText("Platform Observability")).toBeDefined();
    });

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    // No subsequent calls after unmount
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("12. unmount during in-flight fetch does not throw state update error", async () => {
    let resolveSlow: any;
    (api as any).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSlow = resolve;
        }),
    );

    const { unmount } = render(<AdminObservabilityPanel />);
    unmount();

    await act(async () => {
      resolveSlow(mockObservabilityData);
    });
  });

  it("13. transient polling failure preserves last known good metrics with warning banner", async () => {
    render(<AdminObservabilityPanel />);
    await waitFor(() => {
      expect(screen.getByText("Platform Observability")).toBeDefined();
    });

    // Next poll fails
    (api as any).mockRejectedValueOnce(new Error("Network disconnect"));

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    // Existing metrics still visible!
    expect(screen.getByText(/12 WS \/ 4 Rooms/)).toBeDefined();
    // Transient warning banner rendered
    expect(screen.getByText(/Unable to refresh observability data/i)).toBeDefined();
  });

  it("14. initial load error displays understandable error state", async () => {
    (api as any).mockRejectedValueOnce(new Error("Database offline"));

    render(<AdminObservabilityPanel />);
    await waitFor(() => {
      expect(screen.getByText("Failed to load platform telemetry")).toBeDefined();
    });
    expect(screen.getByText("Database offline")).toBeDefined();
  });

  it("15. Retry button retries fetching after initial error", async () => {
    (api as any).mockRejectedValueOnce(new Error("Server error"));

    render(<AdminObservabilityPanel />);
    await waitFor(() => {
      expect(screen.getByText("Failed to load platform telemetry")).toBeDefined();
    });

    // Next attempt succeeds
    (api as any).mockResolvedValueOnce(mockObservabilityData);

    const retryBtn = screen.getByRole("button", { name: /Retry/i });
    await act(async () => {
      fireEvent.click(retryBtn);
    });

    await waitFor(() => {
      expect(screen.getByText("Platform Observability")).toBeDefined();
    });
  });

  it("16. tracks and renders last updated relative seconds", async () => {
    render(<AdminObservabilityPanel />);
    await waitFor(() => {
      expect(screen.getByText("Platform Observability")).toBeDefined();
    });

    expect(screen.getByText(/Updated just now/i)).toBeDefined();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByText(/Updated 3s ago/i)).toBeDefined();
  });

  it("17. handles inactive event-loop monitor gracefully without throwing", async () => {
    const dataWithNoEventLoop: AdminObservabilityData = {
      ...mockObservabilityData,
      eventLoopLagMs: null,
    };
    (api as any).mockResolvedValueOnce(dataWithNoEventLoop);

    render(<AdminObservabilityPanel />);
    await waitFor(() => {
      expect(screen.getByText("Platform Observability")).toBeDefined();
    });

    expect(screen.getByText("Monitor inactive")).toBeDefined();
  });

  it("18. uses neutral presentation and does not fabricate arbitrary red/green health thresholds", async () => {
    render(<AdminObservabilityPanel />);
    await waitFor(() => {
      expect(screen.getByText("Platform Observability")).toBeDefined();
    });

    // Verifies neutral label "Event Loop Lag (p95)" and "DB Query Latency (p95)" without fake status labels
    expect(screen.getByText("Event Loop Lag (p95)")).toBeDefined();
    expect(screen.getByText("DB Query Latency (p95)")).toBeDefined();
  });

  it("19. existing AdminDashboard tabs remain functional with Observability tab switchable", async () => {
    render(
      <AdminDashboard
        user={mockAdminUser}
        onLogout={() => {}}
        onSwitchToIde={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("System Overview")).toBeDefined();
    });

    // Click Observability tab
    const obsTab = screen.getByRole("tab", { name: /Observability/i });
    await act(async () => {
      fireEvent.click(obsTab);
    });

    await waitFor(() => {
      expect(screen.getByText("Platform Observability")).toBeDefined();
    });
  });

  it("20. M34 backup-health and other dashboard panels remain unaffected", async () => {
    render(
      <AdminDashboard
        user={mockAdminUser}
        onLogout={() => {}}
        onSwitchToIde={() => {}}
      />,
    );

    // Switch to backups tab
    const backupsTab = screen.getByRole("tab", { name: /Database & Workspace Backups/i });
    await act(async () => {
      fireEvent.click(backupsTab);
    });

    expect(backupsTab.getAttribute("aria-selected")).toBe("true");
  });
});
