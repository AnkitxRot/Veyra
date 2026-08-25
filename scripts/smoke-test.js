#!/usr/bin/env node
/**
 * Milestone 23 — Automated Production Deployment Smoke & Readiness Verification Harness
 *
 * Exercises the complete vertical stack of a running Veyra deployment:
 *   HTTP -> Liveness/Readiness -> Auth -> User Preferences -> Projects & Files ->
 *   Docker Execution -> Preview Proxy -> Workspace Export -> WebSocket -> Cleanup.
 *
 * Usage:
 *   node scripts/smoke-test.js [--url=http://localhost:3000]
 *   npm run deploy:smoke
 */

import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// CLI & URL Parsing / Security Validation
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  let targetUrl = 'http://localhost:3000';

  for (const arg of args) {
    if (arg.startsWith('--url=')) {
      targetUrl = arg.slice(6).trim();
    } else if (arg === '-h' || arg === '--help') {
      console.log(`
Veyra Production Deployment Smoke & Readiness Verification Harness

Usage:
  node scripts/smoke-test.js [options]
  npm run deploy:smoke

Options:
  --url=<url>     Target Veyra instance URL (default: http://localhost:3000)
  --help, -h      Show this help message
`);
      process.exit(0);
    }
  }

  // Security Validation: target URL format
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (err) {
    console.error(`[FATAL] Invalid target URL "${targetUrl}": ${err.message}`);
    process.exit(1);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.error(`[FATAL] Unsupported protocol "${parsed.protocol}". URL must be http:// or https://`);
    process.exit(1);
  }

  if (parsed.username || parsed.password) {
    console.error('[FATAL] Target URL must not contain embedded user credentials.');
    process.exit(1);
  }

  const cleanOrigin = parsed.origin;
  const wsOrigin = cleanOrigin.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');

  return { httpBase: cleanOrigin, wsBase: wsOrigin };
}

// ---------------------------------------------------------------------------
// WebSocket Transport Helper (Node built-in or ws module)
// ---------------------------------------------------------------------------

async function getWebSocketClient() {
  try {
    const wsMod = await import('ws');
    return wsMod.default || wsMod.WebSocket || wsMod;
  } catch {
    if (typeof globalThis.WebSocket !== 'undefined') {
      return globalThis.WebSocket;
    }
    throw new Error('No WebSocket client available (neither "ws" package nor global WebSocket)');
  }
}

// ---------------------------------------------------------------------------
// PKZIP Archive Parser Helper (Pure zero-dependency)
// ---------------------------------------------------------------------------

function inspectZipBuffer(buffer) {
  if (buffer.length < 22) {
    return { valid: false, error: 'Buffer too small to be a valid ZIP archive' };
  }

  // Check standard PKZIP local header signature 0x04034b50 ("PK\x03\x04")
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
    return { valid: false, error: 'Invalid ZIP magic header signature' };
  }

  const entries = [];
  let offset = 0;

  while (offset + 30 <= buffer.length) {
    const sig = buffer.readUInt32LE(offset);
    if (sig === 0x04034b50) {
      // Local file header
      const fileNameLen = buffer.readUInt16LE(offset + 26);
      const extraLen = buffer.readUInt16LE(offset + 28);
      const compSize = buffer.readUInt32LE(offset + 18);
      const fileName = buffer.toString('utf8', offset + 30, offset + 30 + fileNameLen);
      entries.push(fileName);
      offset += 30 + fileNameLen + extraLen + compSize;
    } else if (sig === 0x02014b50) {
      // Central directory header
      const fileNameLen = buffer.readUInt16LE(offset + 28);
      const extraLen = buffer.readUInt16LE(offset + 30);
      const commentLen = buffer.readUInt16LE(offset + 32);
      const fileName = buffer.toString('utf8', offset + 46, offset + 46 + fileNameLen);
      if (!entries.includes(fileName)) entries.push(fileName);
      offset += 46 + fileNameLen + extraLen + commentLen;
    } else {
      break;
    }
  }

  return { valid: true, entries };
}

// ---------------------------------------------------------------------------
// Smoke Test Runner
// ---------------------------------------------------------------------------

async function runSmokeSuite() {
  const { httpBase, wsBase } = parseArgs();
  const runId = randomBytes(4).toString('hex');
  const smokeUsername = `smoke_${runId}`;
  const smokePassword = `P@ss_${randomBytes(8).toString('hex')}!`;
  const projectName = `smoke-project-${runId}`;

  const scenarioResults = [];
  let sessionToken = null;
  let createdProjectId = null;
  const overallStart = Date.now();

  console.log(`\n===============================================================`);
  console.log(`  Veyra Automated Production Deployment Smoke Test`);
  console.log(`===============================================================`);
  console.log(`Target URL:   ${httpBase}`);
  console.log(`Run ID:       ${runId}`);
  console.log(`Timestamp:    ${new Date().toISOString()}`);
  console.log(`---------------------------------------------------------------\n`);

  async function executeScenario(name, fn) {
    const start = Date.now();
    try {
      const details = await fn();
      const elapsed = Date.now() - start;
      scenarioResults.push({ name, status: 'PASS', elapsed, details });
      console.log(`[PASS] ${name.padEnd(35)} (${elapsed}ms)`);
      if (details) console.log(`       -> ${details}`);
      return true;
    } catch (err) {
      const elapsed = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      scenarioResults.push({ name, status: 'FAIL', elapsed, error: errorMsg });
      console.log(`[FAIL] ${name.padEnd(35)} (${elapsed}ms)`);
      console.log(`       -> ERROR: ${errorMsg}`);
      return false;
    }
  }

  // --- Scenario 1: Liveness Check ---
  let liveOk = await executeScenario('1. Liveness Check', async () => {
    const res = await fetch(`${httpBase}/api/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (!data || data.ok !== true || data.status !== 'live') {
      throw new Error(`Unexpected liveness payload: ${JSON.stringify(data)}`);
    }
    return `status=${data.status}, platform=${data.platform || 'unknown'}`;
  });

  if (!liveOk) {
    console.error('\n[FATAL] Target instance failed liveness check. Aborting remaining checks.');
    printSummary(scenarioResults, overallStart);
    process.exit(1);
  }

  // --- Scenario 2: Readiness Check ---
  let readyOk = await executeScenario('2. Readiness Check', async () => {
    const res = await fetch(`${httpBase}/api/health/ready`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 503) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const checks = data.checks || {};
    if (!checks.database) {
      throw new Error(`Database check failed: ${JSON.stringify(checks)}`);
    }
    return `status=${data.status}, database=${checks.database}, docker=${checks.docker}, runnerImage=${checks.runnerImage}`;
  });

  try {
    // --- Scenario 3: Auth & Session Token ---
    await executeScenario('3. Authentication & Session', async () => {
      const res = await fetch(`${httpBase}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: smokeUsername, password: smokePassword }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Registration failed (HTTP ${res.status}): ${body}`);
      }
      const data = await res.json();
      if (!data.token || !data.user || !data.user.id) {
        throw new Error('Registration response missing token or user object');
      }
      sessionToken = data.token;
      return `Registered smoke user ID ${data.user.id} (${data.user.username})`;
    });

    if (!sessionToken) {
      throw new Error('Cannot continue without valid session token');
    }

    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionToken}`,
      Cookie: `session_token=${sessionToken}`,
    };

    // --- Scenario 4: User Preferences Persistence ---
    await executeScenario('4. User Preferences Persistence', async () => {
      // GET defaults
      const getRes = await fetch(`${httpBase}/api/auth/preferences`, {
        headers: authHeaders,
      });
      if (!getRes.ok) throw new Error(`GET /preferences failed (HTTP ${getRes.status})`);
      const getData = await getRes.json();
      if (!getData.preferences) throw new Error('Missing preferences object');

      // PUT update
      const targetTabSize = getData.preferences.tabSize === 2 ? 4 : 2;
      const putRes = await fetch(`${httpBase}/api/auth/preferences`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ tabSize: targetTabSize, wordWrap: 'on' }),
      });
      if (!putRes.ok) throw new Error(`PUT /preferences failed (HTTP ${putRes.status})`);
      const putData = await putRes.json();
      if (putData.preferences.tabSize !== targetTabSize || putData.preferences.wordWrap !== 'on') {
        throw new Error('Preferences did not update as expected');
      }

      // Re-GET and verify persistence
      const verifyRes = await fetch(`${httpBase}/api/auth/preferences`, {
        headers: authHeaders,
      });
      const verifyData = await verifyRes.json();
      if (verifyData.preferences.tabSize !== targetTabSize) {
        throw new Error('Preferences update was not persisted in database');
      }
      return `Updated tabSize to ${targetTabSize}, wordWrap to "on"`;
    });

    // --- Scenario 5: Project Creation ---
    await executeScenario('5. Project Creation', async () => {
      const res = await fetch(`${httpBase}/api/projects`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ name: projectName, language: 'python' }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Project creation failed (HTTP ${res.status}): ${text}`);
      }
      const data = await res.json();
      if (!data.project || !data.project.id) {
        throw new Error('Missing project ID in response');
      }
      createdProjectId = data.project.id;

      // Verify listing tree
      const treeRes = await fetch(`${httpBase}/api/projects/${createdProjectId}/tree`, {
        headers: authHeaders,
      });
      if (!treeRes.ok) throw new Error(`Listing tree failed (HTTP ${treeRes.status})`);
      const treeData = await treeRes.json();
      return `Created project "${projectName}" (ID: ${createdProjectId}), tree entries: ${treeData.tree?.length || 0}`;
    });

    // --- Scenario 6: File Write and Read ---
    const expectedOutputSecret = `output_${randomBytes(6).toString('hex')}`;
    const pythonCode = `import sys\nprint("smoke-test-${expectedOutputSecret}")\n`;

    await executeScenario('6. File Write & Read Fidelity', async () => {
      // Write main.py
      const writeRes = await fetch(`${httpBase}/api/projects/${createdProjectId}/file`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ path: 'main.py', content: pythonCode }),
      });
      if (!writeRes.ok) {
        const text = await writeRes.text();
        throw new Error(`Writing main.py failed (HTTP ${writeRes.status}): ${text}`);
      }

      // Read back main.py
      const readRes = await fetch(
        `${httpBase}/api/projects/${createdProjectId}/file?path=main.py`,
        { headers: authHeaders },
      );
      if (!readRes.ok) throw new Error(`Reading main.py failed (HTTP ${readRes.status})`);
      const readData = await readRes.json();
      if (readData.content !== pythonCode) {
        throw new Error('File content read back does not match written content');
      }
      return `Written and verified main.py (${pythonCode.length} bytes)`;
    });

    // --- Scenario 7: Docker Sandbox Code Execution ---
    await executeScenario('7. Docker Sandbox Code Execution', async () => {
      const runRes = await fetch(`${httpBase}/api/projects/${createdProjectId}/run`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ language: 'python' }),
      });
      if (!runRes.ok) {
        const text = await runRes.text();
        throw new Error(`POST /run failed (HTTP ${runRes.status}): ${text}`);
      }
      const runResult = await runRes.json();

      if (runResult.type === 'missing_toolchain') {
        throw new Error(`Execution failed: ${runResult.stderr || 'Missing Docker or runner image'}`);
      }

      if (runResult.type !== 'success') {
        throw new Error(`Execution outcome: ${runResult.type}, stderr: ${runResult.stderr}`);
      }

      if (runResult.exitCode !== 0) {
        throw new Error(`Execution exit code was ${runResult.exitCode}, stderr: ${runResult.stderr}`);
      }

      if (!runResult.stdout.includes(`smoke-test-${expectedOutputSecret}`)) {
        throw new Error(`Expected stdout to contain "smoke-test-${expectedOutputSecret}", got: "${runResult.stdout}"`);
      }

      return `Executed in ${runResult.durationMs}ms (exitCode=0, stdout matched)`;
    });

    // --- Scenario 8: Preview Proxy Routing ---
    await executeScenario('8. Preview Proxy Routing', async () => {
      // 1. Verify invalid port is rejected with 400 invalid_port
      const invalidRes = await fetch(
        `${httpBase}/api/projects/${createdProjectId}/proxy/9999/`,
        { headers: authHeaders },
      );
      if (invalidRes.status !== 400) {
        throw new Error(`Expected HTTP 400 for unallowed preview port 9999, got ${invalidRes.status}`);
      }

      // 2. Verify authorized preview proxy route for allowed port 8000
      const previewRes = await fetch(
        `${httpBase}/api/projects/${createdProjectId}/proxy/8000/`,
        { headers: authHeaders },
      );

      // In a live environment without an active HTTP server listening inside the container,
      // the proxy will return 404 (port not published) or 502/504 (target unreachable).
      // Both confirm the proxy resolution logic processed the request correctly.
      if (previewRes.status === 400 || previewRes.status === 401 || previewRes.status === 403) {
        throw new Error(`Preview proxy authorization failed with HTTP ${previewRes.status}`);
      }

      return `Validated preview routing on port 8000 (status: ${previewRes.status})`;
    });

    // --- Scenario 9: Workspace PKZIP Export ---
    await executeScenario('9. Workspace PKZIP Export', async () => {
      const exportRes = await fetch(
        `${httpBase}/api/projects/${createdProjectId}/export`,
        { headers: authHeaders },
      );
      if (!exportRes.ok) {
        throw new Error(`GET /export failed (HTTP ${exportRes.status})`);
      }

      const arrayBuf = await exportRes.arrayBuffer();
      const zipBuf = Buffer.from(arrayBuf);
      const zipInspection = inspectZipBuffer(zipBuf);

      if (!zipInspection.valid) {
        throw new Error(`Exported archive is invalid: ${zipInspection.error}`);
      }

      if (!zipInspection.entries.includes('main.py')) {
        throw new Error(`Exported ZIP does not contain main.py. Entries: ${zipInspection.entries.join(', ')}`);
      }

      // Ensure excluded files are not present
      const invalidExclusions = zipInspection.entries.filter(
        (e) => e.startsWith('.git') || e.startsWith('node_modules'),
      );
      if (invalidExclusions.length > 0) {
        throw new Error(`Exported ZIP contains excluded directory entries: ${invalidExclusions.join(', ')}`);
      }

      return `Exported ${zipBuf.length} bytes, verified PKZIP header and entries: [${zipInspection.entries.join(', ')}]`;
    });

    // --- Scenario 10: WebSocket Collaboration Handshake ---
    await executeScenario('10. WebSocket Collaboration Handshake', async () => {
      const WebSocketClass = await getWebSocketClient();
      return new Promise((resolve, reject) => {
        const wsUrl = `${wsBase}/ws/collab?projectId=${createdProjectId}`;
        const ws = new WebSocketClass(wsUrl, {
          headers: { Cookie: `session_token=${sessionToken}` },
        });

        let receivedMessage = false;

        const timer = setTimeout(() => {
          try { ws.terminate?.() || ws.close?.(); } catch {}
          if (receivedMessage) {
            resolve('WebSocket handshake successful and initial room state received');
          } else {
            reject(new Error('WebSocket connection timed out after 5000ms'));
          }
        }, 5000);

        ws.on('message', (data) => {
          receivedMessage = true;
          clearTimeout(timer);
          setTimeout(() => {
            try { ws.close(); } catch {}
            const len = data.length ?? data.byteLength ?? 0;
            resolve(`WebSocket connected, received initial binary sync frame (${len} bytes)`);
          }, 100);
        });

        ws.on('error', (err) => {
          clearTimeout(timer);
          reject(new Error(`WebSocket error: ${err.message || err}`));
        });

        ws.on('unexpected-response', (_req, res) => {
          clearTimeout(timer);
          reject(new Error(`WebSocket upgrade rejected by server (HTTP ${res.statusCode})`));
        });
      });
    });

  } finally {
    // --- Scenario 11: Cleanup & Teardown ---
    await executeScenario('11. Cleanup & Teardown', async () => {
      let cleanupMessages = [];

      // 1. Delete test project if created
      if (createdProjectId && sessionToken) {
        try {
          const delRes = await fetch(`${httpBase}/api/projects/${createdProjectId}`, {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${sessionToken}`,
              Cookie: `session_token=${sessionToken}`,
            },
          });
          if (delRes.ok) {
            cleanupMessages.push(`Deleted project ${createdProjectId}`);
          }
        } catch (err) {
          cleanupMessages.push(`Project delete warning: ${err.message}`);
        }
      }

      // 2. Logout session
      if (sessionToken) {
        try {
          await fetch(`${httpBase}/api/auth/logout`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${sessionToken}`,
              Cookie: `session_token=${sessionToken}`,
            },
          });
          cleanupMessages.push('Logged out smoke session');
        } catch (err) {
          cleanupMessages.push(`Logout warning: ${err.message}`);
        }
      }

      return cleanupMessages.join(', ') || 'Nothing to clean';
    });
  }

  printSummary(scenarioResults, overallStart);

  const allPassed = scenarioResults.every((r) => r.status === 'PASS');
  process.exit(allPassed ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Summary & Metrics Formatting
// ---------------------------------------------------------------------------

function printSummary(results, startTime) {
  const totalElapsed = Date.now() - startTime;
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const slowest = [...results].sort((a, b) => b.elapsed - a.elapsed)[0];

  console.log(`\n---------------------------------------------------------------`);
  console.log(`  Smoke Suite Summary`);
  console.log(`---------------------------------------------------------------`);
  console.log(`Total Scenarios: ${results.length}`);
  console.log(`Passed:          ${passed}`);
  console.log(`Failed:          ${failed}`);
  console.log(`Total Elapsed:   ${totalElapsed}ms`);
  if (slowest) {
    console.log(`Slowest Check:   ${slowest.name} (${slowest.elapsed}ms)`);
  }
  console.log(`Result:          ${failed === 0 ? 'ALL CHECKS PASSED (DEPLOYMENT READY)' : 'FAILED'}`);
  console.log(`===============================================================\n`);
}

// Execute suite
runSmokeSuite().catch((err) => {
  console.error(`[FATAL] Uncaught error during smoke execution:`, err);
  process.exit(1);
});
