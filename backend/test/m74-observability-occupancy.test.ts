import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { isDockerRunning } from "../src/tools.js";
import { makeTestConfig, makeWorkspace } from "./helpers.js";
import { SandboxManager } from "../src/execution/sandbox.js";
import { getObservabilitySnapshot } from "../src/observability.js";

type Occ = { liveClients: number; distinctUsers: number };

describe.skipIf(!isDockerRunning())(
  "M74 — observability: container sharing + room occupancy",
  () => {
    const created: Array<{ mgr: SandboxManager; projectId: string }> = [];

    afterAll(async () => {
      for (const { mgr, projectId } of created) {
        await mgr.stopProjectSandbox(projectId).catch(() => {});
      }
    });

    it("reports container count, multi-user containers, and aggregate occupancy", async () => {
      const cfg = makeTestConfig();
      const occ = new Map<string, Occ>();
      const mgr = new SandboxManager();
      mgr.setRoomOccupancyProvider(
        (pid) => occ.get(pid) ?? { liveClients: 0, distinctUsers: 0 },
      );

      const pidSolo = `m74obs-solo-${randomUUID()}`;
      const pidMulti = `m74obs-multi-${randomUUID()}`;
      await mgr.ensureProjectSandbox(pidSolo, cfg, makeWorkspace(cfg), 1);
      await mgr.ensureProjectSandbox(pidMulti, cfg, makeWorkspace(cfg), 2);
      created.push({ mgr, projectId: pidSolo }, { mgr, projectId: pidMulti });

      // One single-user container, one container serving two distinct users.
      occ.set(pidSolo, { liveClients: 1, distinctUsers: 1 });
      occ.set(pidMulti, { liveClients: 3, distinctUsers: 2 });

      const m = mgr.getRoomOccupancyMetrics();
      expect(m.containers).toBe(2);
      expect(m.containersWithMultipleUsers).toBe(1);
      expect(m.provisionedContainerRoomOccupancy).toEqual({
        totalLiveClients: 4,
        totalDistinctUsers: 3,
      });

      // Surfaces verbatim through the observability snapshot.
      const snap = getObservabilitySnapshot({
        activeConnectionCount: () => 0,
        getActiveRoomCount: () => 0,
        getActiveSandboxCount: () => mgr.getActiveSandboxCount(),
        getTotalCollabBroadcastSends: () => 0,
        getSandboxRoomOccupancyMetrics: () => mgr.getRoomOccupancyMetrics(),
      });
      expect(snap.containers).toBe(2);
      expect(snap.containersWithMultipleUsers).toBe(1);
      expect(snap.provisionedContainerRoomOccupancy).toEqual({
        totalLiveClients: 4,
        totalDistinctUsers: 3,
      });

      // A container whose room drops to a single user stops counting as shared.
      occ.set(pidMulti, { liveClients: 1, distinctUsers: 1 });
      expect(mgr.getRoomOccupancyMetrics().containersWithMultipleUsers).toBe(0);
    });

    it("reports zeros when no occupancy-metrics dep is provided", () => {
      const snap = getObservabilitySnapshot({
        activeConnectionCount: () => 0,
        getActiveRoomCount: () => 0,
        getActiveSandboxCount: () => 0,
        getTotalCollabBroadcastSends: () => 0,
      });
      expect(snap.containers).toBe(0);
      expect(snap.containersWithMultipleUsers).toBe(0);
      expect(snap.provisionedContainerRoomOccupancy).toEqual({
        totalLiveClients: 0,
        totalDistinctUsers: 0,
      });
    });

    it("counts no shared containers and zero occupancy with no provider registered", async () => {
      const cfg = makeTestConfig();
      const mgr = new SandboxManager(); // no setRoomOccupancyProvider
      const projectId = `m74obs-noprov-${randomUUID()}`;
      await mgr.ensureProjectSandbox(projectId, cfg, makeWorkspace(cfg), 1);
      created.push({ mgr, projectId });

      const m = mgr.getRoomOccupancyMetrics();
      expect(m.containers).toBe(1);
      expect(m.containersWithMultipleUsers).toBe(0);
      expect(m.provisionedContainerRoomOccupancy).toEqual({
        totalLiveClients: 0,
        totalDistinctUsers: 0,
      });
    });
  },
);
