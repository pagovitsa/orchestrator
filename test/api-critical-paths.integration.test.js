import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("session creation API accepts connected providers and persists one conversation per project", async () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import { request } from "node:http";
    import { mkdir, mkdtemp, rm } from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "orch-api-workspace-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orch-api-data-"));
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "orch-api-home-"));
    const rootUrl = pathToFileURL(process.cwd() + path.sep).href;
    let server;

    process.env.ORCH_WORKSPACE_ROOT = workspaceRoot;
    process.env.ORCH_DATA_DIR = dataDir;
    process.env.HOME = homeDir;
    process.env.ORCH_DEFAULT_SUPERVISOR = "deepseek";
    process.env.ORCH_GIT_INIT_PROJECTS = "0";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";

    const { sendJson } = await import(new URL("src/http/response.js", rootUrl));
    const { handleApi } = await import(new URL("src/http/routes.js", rootUrl));
    const { listSessions, loadSession } = await import(new URL("src/domain/sessions.js", rootUrl));

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

    try {
      const baseUrl = await startApiServer();
      const providers = ["claude", "codex", "gemini", "deepseek"];
      const created = [];
      for (const supervisor of providers) {
        const cwd = "project-" + supervisor;
        await mkdir(path.join(workspaceRoot, cwd), { recursive: true });
        const response = await jsonRequest("POST", baseUrl + "/api/sessions", { supervisor, cwd });
        assert.equal(response.status, 201, supervisor + " should create a session");
        assert.equal(response.body.session.supervisor, supervisor);
        assert.equal(response.body.session.cwd, cwd);
        assert.equal(response.body.session.messages.length, 0);
        created.push(response.body.session);
      }

      const sessions = await listSessions();
      assert.equal(sessions.length, providers.length);
      assert.deepEqual(new Set(sessions.map((session) => session.cwd)), new Set(providers.map((id) => "project-" + id)));
      assert.equal(new Set(sessions.map((session) => session.id)).size, providers.length);

      for (const session of created) {
        const loaded = await loadSession(session.id);
        assert.equal(loaded.supervisor, session.supervisor);
        assert.equal(loaded.cwd, session.cwd);
      }
      console.log(JSON.stringify({ ok: true }));
    } finally {
      if (server) await new Promise((done) => server.close(done));
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  `;

  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    timeout: 15000,
  });
  assert.deepEqual(JSON.parse(stdout), { ok: true });
});

test("message API persists uploaded files and sends attachment context to provider", async () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import { request } from "node:http";
    import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "orch-upload-workspace-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orch-upload-data-"));
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "orch-upload-home-"));
    const rootUrl = pathToFileURL(process.cwd() + path.sep).href;
    let server;
    const originalFetch = globalThis.fetch;
    const deepseekRequests = [];

    process.env.ORCH_WORKSPACE_ROOT = workspaceRoot;
    process.env.ORCH_DATA_DIR = dataDir;
    process.env.HOME = homeDir;
    process.env.ORCH_DEFAULT_SUPERVISOR = "deepseek";
    process.env.ORCH_GIT_INIT_PROJECTS = "0";
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";

    globalThis.fetch = async (url, options = {}) => {
      const target = String(url || "");
      if (target.includes("api.deepseek.com")) {
        deepseekRequests.push(JSON.parse(String(options.body || "{}")));
        return new Response(JSON.stringify({
          choices: [{ message: { content: "Processed uploaded files." } }],
          usage: { total_tokens: 42 },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

    const { sendJson } = await import(new URL("src/http/response.js", rootUrl));
    const { handleApi } = await import(new URL("src/http/routes.js", rootUrl));
    const { loadSession } = await import(new URL("src/domain/sessions.js", rootUrl));

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

    try {
      const baseUrl = await startApiServer();
      await mkdir(path.join(workspaceRoot, "project-upload"), { recursive: true });
      const created = await jsonRequest("POST", baseUrl + "/api/sessions", {
        supervisor: "deepseek",
        cwd: "project-upload",
      });
      assert.equal(created.status, 201);
      const sessionId = created.body.session.id;

      const textAttachment = "alpha\nbeta\n";
      const binaryAttachment = Buffer.from([0, 1, 2, 3, 4, 5]);
      const posted = await jsonRequest("POST", baseUrl + "/api/sessions/" + sessionId + "/messages", {
        content: "Please inspect these uploads.",
        attachments: [
          {
            name: "../notes alpha.txt",
            type: "text/plain",
            dataBase64: Buffer.from(textAttachment).toString("base64"),
          },
          {
            name: "snapshot.bin",
            type: "application/octet-stream",
            dataBase64: binaryAttachment.toString("base64"),
          },
        ],
      });

      assert.equal(posted.status, 200);
      assert.equal(posted.body.message.content, "Processed uploaded files.");
      const loaded = await loadSession(sessionId);
      assert.equal(loaded.messages.length, 2);
      const userMessage = loaded.messages[0];
      assert.equal(userMessage.content, "Please inspect these uploads.");
      assert.equal(userMessage.attachments.length, 2);
      assert.equal(userMessage.attachments[0].name, "../notes alpha.txt");
      assert.match(userMessage.attachments[0].storedName, /notes alpha\.txt$/);
      assert.equal(userMessage.attachments[0].inlineText, undefined);
      assert.equal(userMessage.attachments[0].inlineTruncated, undefined);
      assert.equal(userMessage.attachments[1].inlineText, undefined);
      assert.equal(userMessage.attachments[1].size, binaryAttachment.length);
      assert.match(userMessage.modelContent, /ATTACHED FILES:/);
      assert.match(userMessage.modelContent, /inline_preview:/);
      assert.match(userMessage.modelContent, /alpha\nbeta/);
      assert.match(userMessage.modelContent, /snapshot\.bin/);

      for (const attachment of userMessage.attachments) {
        const workspacePrefix = path.join("project-upload", ".orch-ui", "uploads", sessionId) + path.sep;
        assert.equal(path.isAbsolute(attachment.path), true);
        assert.equal(attachment.path.startsWith(path.join(workspaceRoot, "project-upload", ".orch-ui", "uploads", sessionId) + path.sep), true);
        assert.equal(attachment.workspacePath.startsWith(workspacePrefix), true);
        await access(attachment.path);
      }
      assert.equal(await readFile(userMessage.attachments[0].path, "utf8"), textAttachment);

      assert.equal(deepseekRequests.length, 1);
      const sentMessages = deepseekRequests[0].messages || [];
      const sentPrompt = sentMessages.map((message) => message.content || "").join("\n");
      assert.match(sentPrompt, /Please inspect these uploads\./);
      assert.match(sentPrompt, /ATTACHED FILES:/);
      assert.match(sentPrompt, /notes alpha\.txt/);
      assert.match(sentPrompt, /workspace_relative_path: project-upload\/\.orch-ui\/uploads\//);
      assert.match(sentPrompt, /alpha\nbeta/);
      console.log(JSON.stringify({ ok: true }));
    } finally {
      globalThis.fetch = originalFetch;
      if (server) await new Promise((done) => server.close(done));
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  `;

  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    timeout: 15000,
  });
  assert.deepEqual(JSON.parse(stdout), { ok: true });
});

test("message API returns bounded provider rate-limit errors and recovers next request", async () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import { request } from "node:http";
    import { mkdir, mkdtemp, rm } from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "orch-rate-workspace-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orch-rate-data-"));
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "orch-rate-home-"));
    const rootUrl = pathToFileURL(process.cwd() + path.sep).href;
    let server;
    const originalFetch = globalThis.fetch;
    let deepseekCalls = 0;

    process.env.ORCH_WORKSPACE_ROOT = workspaceRoot;
    process.env.ORCH_DATA_DIR = dataDir;
    process.env.HOME = homeDir;
    process.env.ORCH_DEFAULT_SUPERVISOR = "deepseek";
    process.env.ORCH_GIT_INIT_PROJECTS = "0";
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";

    globalThis.fetch = async (url) => {
      const target = String(url || "");
      if (target.includes("api.deepseek.com")) {
        deepseekCalls += 1;
        if (deepseekCalls === 1) {
          return new Response(JSON.stringify({
            error: {
              message: "rate limited sk-super-secret-token " + "x".repeat(2000),
            },
          }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: "Recovered after rate limit." } }],
          usage: { total_tokens: 9 },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

    const { sendJson } = await import(new URL("src/http/response.js", rootUrl));
    const { handleApi } = await import(new URL("src/http/routes.js", rootUrl));
    const { loadSession } = await import(new URL("src/domain/sessions.js", rootUrl));

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

    try {
      const baseUrl = await startApiServer();
      await mkdir(path.join(workspaceRoot, "project-rate"), { recursive: true });
      const created = await jsonRequest("POST", baseUrl + "/api/sessions", {
        supervisor: "deepseek",
        cwd: "project-rate",
      });
      assert.equal(created.status, 201);
      const sessionId = created.body.session.id;

      const limited = await jsonRequest("POST", baseUrl + "/api/sessions/" + sessionId + "/messages", {
        content: "First request should hit a provider limit.",
      });
      assert.equal(limited.status, 429);
      assert.match(limited.body.error, /DeepSeek API 429/);
      assert.doesNotMatch(limited.body.error, /sk-super-secret-token/);
      assert.ok(limited.body.error.length < 1100);

      const afterLimit = await loadSession(sessionId);
      assert.equal(afterLimit.messages.length, 1);
      assert.equal(afterLimit.messages[0].role, "user");
      assert.equal(afterLimit.messages[0].content, "First request should hit a provider limit.");

      const recovered = await jsonRequest("POST", baseUrl + "/api/sessions/" + sessionId + "/messages", {
        content: "Second request should recover.",
      });
      assert.equal(recovered.status, 200);
      assert.equal(recovered.body.message.content, "Recovered after rate limit.");
      const loaded = await loadSession(sessionId);
      assert.equal(loaded.messages.length, 3);
      assert.equal(loaded.messages[1].role, "user");
      assert.equal(loaded.messages[2].role, "assistant");
      assert.equal(loaded.messages[2].content, "Recovered after rate limit.");
      console.log(JSON.stringify({ ok: true }));
    } finally {
      globalThis.fetch = originalFetch;
      if (server) await new Promise((done) => server.close(done));
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  `;

  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    timeout: 15000,
  });
  assert.deepEqual(JSON.parse(stdout), { ok: true });
});

test("message API rejects concurrent runs, stops a hung provider call, and recovers", async () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import { request } from "node:http";
    import { mkdir, mkdtemp, rm } from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "orch-stop-workspace-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orch-stop-data-"));
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "orch-stop-home-"));
    const rootUrl = pathToFileURL(process.cwd() + path.sep).href;
    let server;
    const originalFetch = globalThis.fetch;
    let deepseekCalls = 0;
    let resolveFetchStarted;
    const fetchStarted = new Promise((resolve) => {
      resolveFetchStarted = resolve;
    });

    process.env.ORCH_WORKSPACE_ROOT = workspaceRoot;
    process.env.ORCH_DATA_DIR = dataDir;
    process.env.HOME = homeDir;
    process.env.ORCH_DEFAULT_SUPERVISOR = "deepseek";
    process.env.ORCH_GIT_INIT_PROJECTS = "0";
    process.env.ORCH_AUTOPILOT_IDLE_TIMEOUT_MS = "0";
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";

    globalThis.fetch = async (url, options = {}) => {
      const target = String(url || "");
      if (target.includes("api.deepseek.com")) {
        deepseekCalls += 1;
        if (deepseekCalls === 1) {
          resolveFetchStarted();
          return new Promise((resolve, reject) => {
            const abort = () => reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error("aborted"));
            if (options.signal?.aborted) {
              abort();
              return;
            }
            options.signal?.addEventListener("abort", abort, { once: true });
          });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: "Recovered after stop." } }],
          usage: { total_tokens: 11 },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

    const { sendJson } = await import(new URL("src/http/response.js", rootUrl));
    const { handleApi } = await import(new URL("src/http/routes.js", rootUrl));
    const { loadSession } = await import(new URL("src/domain/sessions.js", rootUrl));

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

    try {
      const baseUrl = await startApiServer();
      await mkdir(path.join(workspaceRoot, "project-stop-a"), { recursive: true });
      await mkdir(path.join(workspaceRoot, "project-stop-b"), { recursive: true });
      const createdA = await jsonRequest("POST", baseUrl + "/api/sessions", {
        supervisor: "deepseek",
        cwd: "project-stop-a",
      });
      const createdB = await jsonRequest("POST", baseUrl + "/api/sessions", {
        supervisor: "deepseek",
        cwd: "project-stop-b",
      });
      assert.equal(createdA.status, 201);
      assert.equal(createdB.status, 201);
      const sessionA = createdA.body.session.id;
      const sessionB = createdB.body.session.id;

      const hangingRequest = jsonRequest("POST", baseUrl + "/api/sessions/" + sessionA + "/messages", {
        content: "This request should be stopped.",
      });
      await fetchStarted;

      const sameSession = await jsonRequest("POST", baseUrl + "/api/sessions/" + sessionA + "/messages", {
        content: "Concurrent same-session message.",
      });
      assert.equal(sameSession.status, 409);
      assert.match(sameSession.body.error, /already has a running model/);

      const sameSupervisor = await jsonRequest("POST", baseUrl + "/api/sessions/" + sessionB + "/messages", {
        content: "Concurrent same-supervisor message.",
      });
      assert.equal(sameSupervisor.status, 409);
      assert.match(sameSupervisor.body.error, /already running in another project/);

      const stop = await jsonRequest("POST", baseUrl + "/api/sessions/" + sessionA + "/stop");
      assert.equal(stop.status, 202);
      assert.equal(stop.body.stopped, true);

      const stopped = await hangingRequest;
      assert.equal(stopped.status, 200);
      assert.equal(stopped.body.stopped, true);
      assert.equal(stopped.body.message.stopped, true);
      assert.equal(stopped.body.message.error, undefined);
      assert.match(stopped.body.message.content, /Stopped by user/);

      const afterStop = await loadSession(sessionA);
      assert.equal(afterStop.messages.length, 2);
      assert.equal(afterStop.messages[0].role, "user");
      assert.equal(afterStop.messages[0].content, "This request should be stopped.");
      assert.equal(afterStop.messages[1].role, "assistant");
      assert.equal(afterStop.messages[1].stopped, true);

      const stopAgain = await jsonRequest("POST", baseUrl + "/api/sessions/" + sessionA + "/stop");
      assert.equal(stopAgain.status, 200);
      assert.equal(stopAgain.body.stopped, false);

      const recovered = await jsonRequest("POST", baseUrl + "/api/sessions/" + sessionA + "/messages", {
        content: "This request should recover.",
      });
      assert.equal(recovered.status, 200);
      assert.equal(recovered.body.message.content, "Recovered after stop.");
      const loaded = await loadSession(sessionA);
      assert.equal(loaded.messages.length, 4);
      assert.equal(loaded.messages[2].role, "user");
      assert.equal(loaded.messages[3].role, "assistant");
      assert.equal(loaded.messages[3].content, "Recovered after stop.");
      assert.equal(deepseekCalls, 2);
      console.log(JSON.stringify({ ok: true }));
    } finally {
      globalThis.fetch = originalFetch;
      if (server) await new Promise((done) => server.close(done));
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  `;

  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    timeout: 15000,
  });
  assert.deepEqual(JSON.parse(stdout), { ok: true });
});
