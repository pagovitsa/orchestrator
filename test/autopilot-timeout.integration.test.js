import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("autopilot decision endpoint decides deterministically without a model call, and recovers from run failures", async () => {
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
    process.env.ORCH_AUTOPILOT_DECISION_TIMEOUT_MS = "0";
    process.env.ORCH_AUTOPILOT_SERVER_LOOP_MS = "0";
    process.env.ORCH_AUTOPILOT_RETRY_ATTEMPTS = "1";
    process.env.DEEPSEEK_API_KEY = "test-key";

    const { sendJson } = await import(new URL("src/http/response.js", rootUrl));
    const { handleApi } = await import(new URL("src/http/routes.js", rootUrl));
    const { loadSession, saveSession } = await import(new URL("src/domain/sessions.js", rootUrl));

    // The deterministic autopilot pacer must never consult a model to decide the next step. Any
    // fetch during a decision is a regression, so fail loudly instead of silently mocking one.
    let modelFetchCalled = false;
    globalThis.fetch = async () => {
      modelFetchCalled = true;
      throw new Error("autopilot decision must not call any model");
    };

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
        supervisor: "codex",
        cwd: "project-a",
        messages: [{ role: "assistant", supervisor: "codex", content: "Phase complete.", at: "2026-01-01T00:00:00.000Z" }],
        autopilotEnabled: true,
        autopilotState: { state: "created" },
      };
      await saveSession(session);
      const autopilotUrl = baseUrl + "/api/sessions/" + session.id + "/autopilot";

      // Normal turn: keep the session alive and hand the next step to the supervisor, no model call.
      const decided = await postJson(autopilotUrl);
      const afterDecide = await loadSession(session.id);
      assert.equal(modelFetchCalled, false);
      assert.equal(decided.status, 200);
      assert.equal(decided.body.decision.action, "message");
      assert.equal(decided.body.decision.kind, "continue");
      assert.equal(afterDecide.autopilotEnabled, true);
      assert.equal(afterDecide.autopilotState.state, "completed");
      assert.equal(afterDecide.autopilotHistory.length, 1);
      assert.equal(afterDecide.autopilotFeed.length, 1);

      // Pause and restart still flow through the workflow state machine.
      const paused = await patchJson(baseUrl + "/api/sessions/" + session.id, { autopilotEnabled: false });
      assert.equal(paused.status, 200);
      assert.equal(paused.body.session.autopilotEnabled, false);
      assert.equal(paused.body.session.autopilotState.state, "paused");

      const restarted = await patchJson(baseUrl + "/api/sessions/" + session.id, { autopilotEnabled: true });
      assert.equal(restarted.status, 200);
      assert.equal(restarted.body.session.autopilotEnabled, true);
      assert.equal(restarted.body.session.autopilotState.state, "created");

      // A failed run is nudged with a recovery step (1/3), still without any model call.
      const restartedSession = await loadSession(session.id);
      restartedSession.messages.push({
        role: "assistant",
        supervisor: "codex",
        content: "Error: model crashed",
        error: true,
        at: "2026-01-01T00:01:00.000Z",
      });
      await saveSession(restartedSession);

      const recovered = await postJson(autopilotUrl);
      const afterRecover = await loadSession(session.id);
      assert.equal(modelFetchCalled, false);
      assert.equal(recovered.status, 200);
      assert.equal(recovered.body.decision.action, "message");
      assert.match(recovered.body.decision.reason, /1\/3/);
      assert.equal(afterRecover.autopilotEnabled, true);
      assert.equal(afterRecover.autopilotState.state, "completed");

      // A second consecutive failure still recovers (2/3).
      const failed2Session = await loadSession(session.id);
      failed2Session.messages.push({
        role: "assistant",
        supervisor: "codex",
        content: "Error: second failure",
        error: true,
        at: "2026-01-01T00:02:00.000Z",
      });
      await saveSession(failed2Session);
      const recovered2 = await postJson(autopilotUrl);
      assert.equal(modelFetchCalled, false);
      assert.equal(recovered2.status, 200);
      assert.equal(recovered2.body.decision.action, "message");
      assert.match(recovered2.body.decision.reason, /2\/3/);

      // The third consecutive failure hits the hard safety stop through the endpoint.
      const failed3Session = await loadSession(session.id);
      failed3Session.messages.push({
        role: "assistant",
        supervisor: "codex",
        content: "Error: third failure",
        error: true,
        at: "2026-01-01T00:03:00.000Z",
      });
      await saveSession(failed3Session);
      const stopped = await postJson(autopilotUrl);
      const afterStop = await loadSession(session.id);
      assert.equal(modelFetchCalled, false);
      assert.equal(stopped.status, 200);
      assert.equal(stopped.body.decision.action, "stop");
      assert.match(stopped.body.decision.reason, /Three consecutive/);
      assert.equal(afterStop.autopilotEnabled, false);
      assert.equal(afterStop.autopilotState.state, "stopped");
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

test("server-side autopilot loop advances projects without a browser scheduler or planner model", async () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { mkdir, mkdtemp, rm } from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "orch-server-autopilot-workspace-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orch-server-autopilot-data-"));
    const rootUrl = pathToFileURL(process.cwd() + path.sep).href;
    const originalFetch = globalThis.fetch;

    process.env.ORCH_WORKSPACE_ROOT = workspaceRoot;
    process.env.ORCH_DATA_DIR = dataDir;
    process.env.ORCH_DEFAULT_SUPERVISOR = "deepseek";
    process.env.ORCH_GIT_INIT_PROJECTS = "0";
    process.env.ORCH_AUTOPILOT_DECISION_TIMEOUT_MS = "0";
    process.env.ORCH_AUTOPILOT_SERVER_LOOP_MS = "20";
    process.env.ORCH_AUTOPILOT_RETRY_ATTEMPTS = "1";
    process.env.DEEPSEEK_API_KEY = "test-key";

    // The deterministic decision makes no model call, so every fetch here is the DeepSeek supervisor
    // running the follow-up step the autopilot handed back to it.
    let supervisorCalls = 0;
    globalThis.fetch = async () => {
      supervisorCalls += 1;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Server loop ran without a browser." } }],
        usage: { total_tokens: 7 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const { saveSession, loadSession } = await import(new URL("src/domain/sessions.js", rootUrl));
    const { startAutopilotServerLoop, stopAutopilotServerLoop } = await import(new URL("src/http/routes.js", rootUrl));

    try {
      await mkdir(path.join(workspaceRoot, "project-a"), { recursive: true });
      const session = {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        supervisor: "deepseek",
        cwd: "project-a",
        messages: [{ role: "assistant", supervisor: "deepseek", content: "Previous phase complete.", at: "2026-01-01T00:00:00.000Z" }],
        autopilotEnabled: true,
        autopilotState: { state: "completed" },
      };
      await saveSession(session);
      startAutopilotServerLoop();

      let loaded = session;
      for (let i = 0; i < 80; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        loaded = await loadSession(session.id);
        if ((loaded.messages || []).some((message) => /Server loop ran without a browser/.test(String(message.content || "")))) break;
      }

      assert.equal(supervisorCalls >= 1, true);
      assert.equal(loaded.autopilotEnabled, true);
      // The supervisor's follow-up answer landed without a browser tab driving it.
      assert.equal((loaded.messages || []).some((message) => /Server loop ran without a browser/.test(String(message.content || ""))), true);
      // The autopilot-authored user turn handed the next-step choice back to the supervisor.
      assert.equal((loaded.messages || []).some((message) => (
        message.role === "user" && /identify the next safest concrete phase/i.test(String(message.content || ""))
      )), true);
      console.log(JSON.stringify({ ok: true }));
    } finally {
      stopAutopilotServerLoop();
      globalThis.fetch = originalFetch;
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
