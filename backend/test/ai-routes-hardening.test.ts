import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";

describe("M97 — AI verification routes hardening", () => {
  let api: TestApi;
  let ownerToken: string;
  let viewerToken: string;
  let projectId: string;

  beforeEach(async () => {
    api = await startTestApi(makeTestConfig());
    ownerToken = (
      await api.request("POST", "/api/auth/register", {
        body: { username: "ai_owner", password: "password123" },
      })
    ).data.token;
    viewerToken = (
      await api.request("POST", "/api/auth/register", {
        body: { username: "ai_viewer", password: "password123" },
      })
    ).data.token;
    projectId = (
      await api.request("POST", "/api/projects", {
        token: ownerToken,
        body: { name: "ai-hardening" },
      })
    ).data.project.id;
    await api.request("POST", `/api/projects/${projectId}/collaborators`, {
      token: ownerToken,
      body: { username: "ai_viewer", role: "viewer" },
    });
  });

  afterEach(async () => {
    await api.close();
  });

  it("rejects oversized verification fields instead of storing them", async () => {
    const res = await api.request("POST", `/api/projects/${projectId}/ai/verify`, {
      token: ownerToken,
      body: { skipVerification: true, explanation: "x".repeat(100_000) },
    });
    expect(res.status).toBe(400);
    const n = api.db
      .prepare("SELECT COUNT(*) AS n FROM ai_verifications WHERE project_id = ?")
      .get(projectId) as { n: number };
    expect(n.n).toBe(0);
  });

  it("rejects non-string verification fields", async () => {
    const res = await api.request("POST", `/api/projects/${projectId}/ai/verify`, {
      token: ownerToken,
      body: { skipVerification: true, filePath: { a: 1 } },
    });
    expect(res.status).toBe(400);
  });

  it("does not leak run output to viewers via the verification journal", async () => {
    api.db
      .prepare(
        `INSERT INTO ai_verifications (id, project_id, user_id, action, provider_type, model_name, file_path, explanation, status, stdout_summary, stderr_summary)
         VALUES ('v1', ?, 1, 'patch_verification', 'deterministic', 'm', 'main.py', 'e', 'passed', 'SECRET-OUT', 'SECRET-ERR')`,
      )
      .run(projectId);
    const viewer = await api.request("GET", `/api/projects/${projectId}/ai/verifications`, {
      token: viewerToken,
    });
    expect(viewer.status).toBe(200);
    expect(viewer.text).not.toContain("SECRET-OUT");
    expect(viewer.text).not.toContain("SECRET-ERR");
    const owner = await api.request("GET", `/api/projects/${projectId}/ai/verifications`, {
      token: ownerToken,
    });
    expect(owner.text).toContain("SECRET-OUT");
  });
});
