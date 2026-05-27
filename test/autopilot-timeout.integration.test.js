import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("autopilot decision timeout aborts the API decision and persists stopped state", async () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import { request } from "node:http";
    import { mkdir, mkdtemp, rm } from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "orch-autopilot-workspace-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orch-autopilot-data-"));
    const rootUrl = pathToFileURL(process.cwd() + path.sep).href;
    let server;
    const originalFetch = globalThis.fetch;

    process.env.ORCH_WORKSPACE_ROOT = workspaceRoot;
    process.env.ORCH_DATA_DIR = dataDir;
    process.env.ORCH_DEFAULT_SUPERVISOR = "codex";
    process.env.ORCH_GIT_INIT_PROJECTS = "0";
    process.env.ORCH_AUTOPILOT_DECISION_TIMEOUT_MS = "25";
    process.env.ORCH_AUTOPILOT_IDLE_WARNING_MS = "10";
    process.env.ORCH_AUTOPILOT_RETRY_ATTEMPTS = "1";
    process.env.DEEPSEEK_API_KEY = "test-key";

    const { sendJson } = await import(new URL("src/http/response.js", rootUrl));
    const { handleApi } = await import(new URL("src/http/routes.js", rootUrl));
    const { loadSession, saveSession } = await import(new URL("src/domain/sessions.js", rootUrl));

    function startApiServer() {
      server = createServer(async (req, res) => {
        try {
          const url = new URL(req.url || "/", "http://127.0.0.1");
          await handleApi(req, res, url);
        } catch (error) {
          sendJson(res, error.status || 500, { error: error.message || String(error) });
        }
      });
      return new Promise((resolve, reject) => {
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resolve("http://127.0.0.1:" + address.port);
        });
      });
    }

    function postJson(url, body = {}) {
      return new Promise((resolve, reject) => {
        const target = new URL(url);
        const payload = JSON.stringify(body);
        const req = request({
          method: "POST",
          hostname: target.hostname,
          port: target.port,
          path: target.pathname + target.search,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          },
        }, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
          });
        });
        req.on("error", reject);
        req.end(payload);
      });
    }

    let fetchAbortSeen = false;
    globalThis.fetch = async (_url, options = {}) => new Promise((_resolve, reject) => {
      const signal = options.signal;
      if (signal?.aborted) {
        fetchAbortSeen = true;
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        return;
      }
      signal?.addEventListener("abort", () => {
        fetchAbortSeen = true;
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      }, { once: true });
    });

    try {
      const baseUrl = await startApiServer();
      const session = {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        supervisor: "codex",
        cwd: "project-a",
        messages: [{ role: "assistant", supervisor: "codex", content: "Phase complete.", at: "2026-01-01T00:00:00.000Z" }],
        autopilotEnabled: true,
        autopilotState: { state: "created" },
      };
      await mkdir(path.join(workspaceRoot, "project-a"), { recursive: true });
      await saveSession(session);

      const response = await postJson(baseUrl + "/api/sessions/" + session.id + "/autopilot");
      const loaded = await loadSession(session.id);

      assert.equal(fetchAbortSeen, true);
      assert.equal(response.status, 500);
      assert.match(response.body.error, /Autopilot decision timeout/);
      assert.equal(loaded.autopilotEnabled, false);
      assert.equal(loaded.autopilotState.state, "stopped");
      assert.equal(loaded.autopilotState.reason, "Autopilot decision timeout");
      console.log(JSON.stringify({ ok: true }));
    } finally {
      globalThis.fetch = originalFetch;
      if (server) await new Promise((done) => server.close(done));
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  `;

  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    timeout: 5000,
  });
  assert.deepEqual(JSON.parse(stdout), { ok: true });
});

test("autopilot API blocks concurrent decisions, supports stop, and restarts", async () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import { request } from "node:http";
    import { mkdir, mkdtemp, rm } from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "orch-autopilot-workspace-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orch-autopilot-data-"));
    const rootUrl = pathToFileURL(process.cwd() + path.sep).href;
    let server;
    const originalFetch = globalThis.fetch;

    process.env.ORCH_WORKSPACE_ROOT = workspaceRoot;
    process.env.ORCH_DATA_DIR = dataDir;
    process.env.ORCH_DEFAULT_SUPERVISOR = "deepseek";
    process.env.ORCH_GIT_INIT_PROJECTS = "0";
    process.env.ORCH_AUTOPILOT_DECISION_TIMEOUT_MS = "0";
    process.env.ORCH_AUTOPILOT_RETRY_ATTEMPTS = "1";
    process.env.DEEPSEEK_API_KEY = "test-key";

    const { sendJson } = await import(new URL("src/http/response.js", rootUrl));
    const { handleApi } = await import(new URL("src/http/routes.js", rootUrl));
    const { loadSession, saveSession } = await import(new URL("src/domain/sessions.js", rootUrl));

    function startApiServer() {
      server = createServer(async (req, res) => {
        try {
          const url = new URL(req.url || "/", "http://127.0.0.1");
          await handleApi(req, res, url);
        } catch (error) {
          sendJson(res, error.status || 500, { error: error.message || String(error) });
        }
      });
      return new Promise((resolve, reject) => {
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resolve("http://127.0.0.1:" + address.port);
        });
      });
    }

    function jsonRequest(method, url, body = {}) {
      return new Promise((resolve, reject) => {
        const target = new URL(url);
        const payload = JSON.stringify(body);
        const req = request({
          method,
          hostname: target.hostname,
          port: target.port,
          path: target.pathname + target.search,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          },
        }, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
          });
        });
        req.on("error", reject);
        req.end(payload);
      });
    }

    const postJson = (url, body = {}) => jsonRequest("POST", url, body);
    const patchJson = (url, body = {}) => jsonRequest("PATCH", url, body);

    try {
      const baseUrl = await startApiServer();
      await mkdir(path.join(workspaceRoot, "project-a"), { recursive: true });

      const session = {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        supervisor: "deepseek",
        cwd: "project-a",
        messages: [{
          role: "assistant",
          supervisor: "deepseek",
          content: "Please confirm before deleting any backups?",
          at: "2026-01-01T00:00:00.000Z",
        }],
        autopilotEnabled: true,
        autopilotState: { state: "created" },
      };
      await saveSession(session);

      let fetchAbortSeen = false;
      let resolveFetchCalled;
      const fetchCalled = new Promise((resolve) => {
        resolveFetchCalled = resolve;
      });
      globalThis.fetch = async (_url, options = {}) => new Promise((_resolve, reject) => {
        resolveFetchCalled();
        const signal = options.signal;
        if (signal?.aborted) {
          fetchAbortSeen = true;
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => {
          fetchAbortSeen = true;
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        }, { once: true });
      });

      const autopilotUrl = baseUrl + "/api/sessions/" + session.id + "/autopilot";
      const firstDecision = postJson(autopilotUrl);
      await fetchCalled;

      const concurrent = await postJson(autopilotUrl);
      assert.equal(concurrent.status, 409);
      assert.match(concurrent.body.error, /already running/);

      const paused = await patchJson(baseUrl + "/api/sessions/" + session.id, { autopilotEnabled: false });
      assert.equal(paused.status, 200);
      assert.equal(paused.body.session.autopilotEnabled, false);
      assert.equal(paused.body.session.autopilotState.state, "paused");

      const aborted = await firstDecision;
      const afterAbort = await loadSession(session.id);
      assert.equal(fetchAbortSeen, true);
      assert.equal(aborted.status, 500);
      assert.match(aborted.body.error, /Autopilot disabled by user/);
      assert.equal(afterAbort.autopilotEnabled, false);
      assert.equal(afterAbort.autopilotState.state, "paused");
      assert.equal(afterAbort.autopilotState.reason, "Autopilot paused");

      const restarted = await patchJson(baseUrl + "/api/sessions/" + session.id, { autopilotEnabled: true });
      assert.equal(restarted.status, 200);
      assert.equal(restarted.body.session.autopilotEnabled, true);
      assert.equal(restarted.body.session.autopilotState.state, "created");

      globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              action: "stop",
              kind: "stop",
              reason: "Human approval required",
            }),
          },
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

      const stopped = await postJson(autopilotUrl);
      const afterRestart = await loadSession(session.id);
      assert.equal(stopped.status, 200);
      assert.equal(stopped.body.decision.action, "stop");
      assert.equal(stopped.body.session.autopilotEnabled, false);
      assert.equal(stopped.body.session.autopilotState.state, "stopped");
      assert.equal(afterRestart.autopilotEnabled, false);
      assert.equal(afterRestart.autopilotState.state, "stopped");
      assert.equal(afterRestart.autopilotState.reason, "Human approval required");
      assert.equal(afterRestart.autopilotHistory.length, 1);
      assert.equal(afterRestart.autopilotFeed.length, 1);
      console.log(JSON.stringify({ ok: true }));
    } finally {
      globalThis.fetch = originalFetch;
      if (server) await new Promise((done) => server.close(done));
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  `;

  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    timeout: 8000,
  });
  assert.deepEqual(JSON.parse(stdout), { ok: true });
});
