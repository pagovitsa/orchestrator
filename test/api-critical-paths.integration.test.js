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

test("tailscale setup API saves redacted Docker-sidecar state", async () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import { request } from "node:http";
    import { mkdtemp, readFile, rm } from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "orch-tail-workspace-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orch-tail-data-"));
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "orch-tail-home-"));
    const rootUrl = pathToFileURL(process.cwd() + path.sep).href;
    let server;

    process.env.ORCH_WORKSPACE_ROOT = workspaceRoot;
    process.env.ORCH_DATA_DIR = dataDir;
    process.env.HOME = homeDir;
    process.env.ORCH_GIT_INIT_PROJECTS = "0";

    const { sendJson } = await import(new URL("src/http/response.js", rootUrl));
    const { handleApi } = await import(new URL("src/http/routes.js", rootUrl));

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

    function jsonRequest(method, url, body) {
      return new Promise((resolve, reject) => {
        const target = new URL(url);
        const payload = body === undefined ? "" : JSON.stringify(body);
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
      const initial = await jsonRequest("GET", baseUrl + "/api/tailscale");
      assert.equal(initial.status, 200);
      assert.equal(initial.body.tailscale.configured, false);

      // Browser-auth path: POST takes no key. Backend writes a hostname-only setup.env, drops a
      // logout-pending sentinel so the sidecar wipes any old identity, and returns the status.
      // configured stays false until the sidecar actually registers (state=ready + fqdn).
      const saved = await jsonRequest("POST", baseUrl + "/api/tailscale", {});
      assert.equal(saved.status, 200);
      assert.equal(saved.body.tailscale.authKeyConfigured, false);
      assert.equal(saved.body.tailscale.configured, false);
      assert.equal(saved.body.tailscale.hostname, "orch-ui");
      assert.equal(saved.body.tailscale.httpsHost, "");
      assert.equal(Object.hasOwn(saved.body.tailscale, "authKey"), false);

      const setupEnv = await readFile(path.join(dataDir, "tailscale", "setup.env"), "utf8");
      assert.match(setupEnv, /ORCH_TAILSCALE_HOSTNAME='orch-ui'/);
      assert.equal(/ORCH_TAILSCALE_AUTHKEY/.test(setupEnv), false);
      assert.equal(/ORCH_TAILSCALE_HTTPS_HOST/.test(setupEnv), false);

      // Logout sentinel must have been written so the sidecar's polling loop will wipe its
      // persisted identity on the next tick.
      const sentinel = await readFile(path.join(dataDir, "tailscale", "logout-pending"), "utf8");
      assert.ok(sentinel.length > 0, "logout-pending sentinel should be present");

      // Simulate the sidecar writing the live FQDN into status.json after registration; the GET
      // endpoint should reflect it as the active httpsHost and flip configured to true.
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        path.join(dataDir, "tailscale", "status.json"),
        JSON.stringify({ state: "ready", detail: "ok", fqdn: "orch-ui.example.ts.net", updatedAt: new Date().toISOString() }),
      );
      const after = await jsonRequest("GET", baseUrl + "/api/tailscale");
      assert.equal(after.body.tailscale.configured, true);
      assert.equal(after.body.tailscale.httpsHost, "https://orch-ui.example.ts.net");
      assert.equal(after.body.tailscale.fqdn, "orch-ui.example.ts.net");
      assert.equal(Object.hasOwn(after.body.tailscale, "authKey"), false);

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

test("message API falls back when DeepSeek peer tools are unsupported", async () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import { request } from "node:http";
    import { mkdir, mkdtemp, rm } from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "orch-fallback-workspace-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orch-fallback-data-"));
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "orch-fallback-home-"));
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
        const body = JSON.parse(String(options.body || "{}"));
        deepseekRequests.push(body);
        if (Array.isArray(body.tools)) {
          return new Response(JSON.stringify({
            error: {
              message: "Function tools are not supported for this model.",
              type: "invalid_request_error",
            },
          }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: "Fallback plain response." } }],
          usage: { total_tokens: 13 },
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
      await mkdir(path.join(workspaceRoot, "project-fallback"), { recursive: true });
      const created = await jsonRequest("POST", baseUrl + "/api/sessions", {
        supervisor: "deepseek",
        cwd: "project-fallback",
      });
      assert.equal(created.status, 201);
      const sessionId = created.body.session.id;

      const posted = await jsonRequest("POST", baseUrl + "/api/sessions/" + sessionId + "/messages", {
        content: "Use whichever DeepSeek request path works.",
      });
      assert.equal(posted.status, 200);
      assert.equal(posted.body.message.content, "Fallback plain response.");
      assert.equal(posted.body.message.error, undefined);
      assert.equal(posted.body.message.stopped, undefined);

      assert.equal(deepseekRequests.length, 2);
      assert.equal(deepseekRequests[0].model, "deepseek-v4-pro");
      assert.ok(Array.isArray(deepseekRequests[0].tools));
      assert.ok(deepseekRequests[0].tools.some((tool) => tool.function?.name === "browser_check"));
      assert.equal(deepseekRequests[0].tool_choice, "auto");
      assert.equal(deepseekRequests[1].model, "deepseek-v4-pro");
      assert.equal(deepseekRequests[1].tools, undefined);
      assert.equal(deepseekRequests[1].tool_choice, undefined);
      assert.deepEqual(deepseekRequests[1].messages, deepseekRequests[0].messages);

      const loaded = await loadSession(sessionId);
      assert.equal(loaded.messages.length, 2);
      assert.equal(loaded.messages[0].role, "user");
      assert.equal(loaded.messages[0].content, "Use whichever DeepSeek request path works.");
      assert.equal(loaded.messages[1].role, "assistant");
      assert.equal(loaded.messages[1].content, "Fallback plain response.");
      assert.equal(loaded.messages[1].error, undefined);
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

test("message API redacts CLI provider failures and recovers next request", async () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import { request } from "node:http";
    import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "orch-cli-workspace-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orch-cli-data-"));
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "orch-cli-home-"));
    const binDir = await mkdtemp(path.join(os.tmpdir(), "orch-cli-bin-"));
    const stateFile = path.join(dataDir, "fake-codex-state");
    const rootUrl = pathToFileURL(process.cwd() + path.sep).href;
    let server;

    process.env.ORCH_WORKSPACE_ROOT = workspaceRoot;
    process.env.ORCH_DATA_DIR = dataDir;
    process.env.HOME = homeDir;
    process.env.ORCH_DEFAULT_SUPERVISOR = "codex";
    process.env.ORCH_GIT_INIT_PROJECTS = "0";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.ORCH_FAKE_CODEX_STATE = stateFile;
    process.env.PATH = binDir + path.delimiter + process.env.PATH;

    const fakeCodex = path.join(binDir, "codex");
    await writeFile(fakeCodex, [
      "#!/usr/bin/env node",
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'exec' && args.includes('--help')) {",
      "  console.log('Usage: codex exec --profile-v2 <profile>');",
      "  process.exit(0);",
      "}",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const stateFile = process.env.ORCH_FAKE_CODEX_STATE;",
      "  const count = existsSync(stateFile) ? Number(readFileSync(stateFile, 'utf8')) : 0;",
      "  writeFileSync(stateFile, String(count + 1));",
      "  if (count === 0) {",
      "    console.error('simulated codex failure sk-super-secret-token ' + 'x'.repeat(2000));",
      "    process.exit(1);",
      "  }",
      "  console.log('Recovered from fake codex.');",
      "});",
    ].join("\n") + "\n", "utf8");
    await chmod(fakeCodex, 0o755);

    const { sendErrorJson } = await import(new URL("src/http/response.js", rootUrl));
    const { handleApi } = await import(new URL("src/http/routes.js", rootUrl));
    const { loadSession } = await import(new URL("src/domain/sessions.js", rootUrl));
    const { usageSnapshot } = await import(new URL("src/domain/usage.js", rootUrl));

    function startApiServer() {
      server = createServer(async (req, res) => {
        try {
          const url = new URL(req.url || "/", "http://127.0.0.1");
          await handleApi(req, res, url);
        } catch (error) {
          sendErrorJson(res, error);
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
      await mkdir(path.join(workspaceRoot, "project-cli"), { recursive: true });
      const created = await jsonRequest("POST", baseUrl + "/api/sessions", {
        supervisor: "codex",
        cwd: "project-cli",
      });
      assert.equal(created.status, 201);
      const sessionId = created.body.session.id;

      const failed = await jsonRequest("POST", baseUrl + "/api/sessions/" + sessionId + "/messages", {
        content: "This request should hit a CLI failure.",
      });
      assert.equal(failed.status, 500);
      assert.match(failed.body.error, /simulated codex failure/);
      assert.doesNotMatch(failed.body.error, /sk-super-secret-token/);
      assert.ok(failed.body.error.length <= 1000);

      const afterFailure = await loadSession(sessionId);
      assert.equal(afterFailure.messages.length, 1);
      assert.equal(afterFailure.messages[0].role, "user");
      assert.equal(afterFailure.messages[0].content, "This request should hit a CLI failure.");

      const usageAfterFailure = await usageSnapshot();
      const codexUsage = usageAfterFailure.usage.find((item) => item.id === "codex");
      assert.equal(codexUsage.active, false);
      assert.match(codexUsage.lastError, /simulated codex failure/);
      assert.doesNotMatch(codexUsage.lastError, /sk-super-secret-token/);
      assert.ok(codexUsage.lastError.length <= 1000);

      const recovered = await jsonRequest("POST", baseUrl + "/api/sessions/" + sessionId + "/messages", {
        content: "This request should recover.",
      });
      assert.equal(recovered.status, 200);
      assert.equal(recovered.body.message.content, "Recovered from fake codex.");

      const loaded = await loadSession(sessionId);
      assert.equal(loaded.messages.length, 3);
      assert.equal(loaded.messages[1].role, "user");
      assert.equal(loaded.messages[2].role, "assistant");
      assert.equal(loaded.messages[2].content, "Recovered from fake codex.");
      console.log(JSON.stringify({ ok: true }));
    } finally {
      if (server) await new Promise((done) => server.close(done));
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  `;

  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    timeout: 15000,
  });
  assert.deepEqual(JSON.parse(stdout), { ok: true });
});

test("message API redacts Claude and Gemini CLI failures and recovers", async () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import { request } from "node:http";
    import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "orch-cli-peers-workspace-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orch-cli-peers-data-"));
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "orch-cli-peers-home-"));
    const binDir = await mkdtemp(path.join(os.tmpdir(), "orch-cli-peers-bin-"));
    const rootUrl = pathToFileURL(process.cwd() + path.sep).href;
    let server;

    process.env.ORCH_WORKSPACE_ROOT = workspaceRoot;
    process.env.ORCH_DATA_DIR = dataDir;
    process.env.HOME = homeDir;
    process.env.ORCH_GIT_INIT_PROJECTS = "0";
    process.env.ORCH_TIMEOUT_MS = "5000";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.PATH = binDir + path.delimiter + process.env.PATH;

    async function writeFakeCli(name, successBody) {
      const stateFile = path.join(dataDir, "fake-" + name + "-state");
      const scriptPath = path.join(binDir, name);
      await writeFile(scriptPath, [
        "#!/usr/bin/env node",
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  const stateFile = " + JSON.stringify(stateFile) + ";",
        "  const count = existsSync(stateFile) ? Number(readFileSync(stateFile, 'utf8')) : 0;",
        "  writeFileSync(stateFile, String(count + 1));",
        "  if (count === 0) {",
        "    console.error('simulated " + name + " failure sk-super-secret-token ' + 'x'.repeat(2000));",
        "    process.exit(1);",
        "  }",
        ...successBody,
        "});",
      ].join("\n") + "\n", "utf8");
      await chmod(scriptPath, 0o755);
    }

    await writeFakeCli("claude", [
      "  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Recovered from fake claude.' }] } }));",
      "  console.log(JSON.stringify({ type: 'result', result: 'Recovered from fake claude.' }));",
    ]);
    await writeFakeCli("gemini", [
      "  console.log('Recovered from fake gemini.');",
    ]);

    const { sendErrorJson } = await import(new URL("src/http/response.js", rootUrl));
    const { handleApi } = await import(new URL("src/http/routes.js", rootUrl));
    const { loadSession } = await import(new URL("src/domain/sessions.js", rootUrl));
    const { usageSnapshot } = await import(new URL("src/domain/usage.js", rootUrl));

    function startApiServer() {
      server = createServer(async (req, res) => {
        try {
          const url = new URL(req.url || "/", "http://127.0.0.1");
          await handleApi(req, res, url);
        } catch (error) {
          sendErrorJson(res, error);
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
      for (const supervisor of ["claude", "gemini"]) {
        const cwd = "project-" + supervisor + "-cli-error";
        await mkdir(path.join(workspaceRoot, cwd), { recursive: true });
        const created = await jsonRequest("POST", baseUrl + "/api/sessions", { supervisor, cwd });
        assert.equal(created.status, 201, supervisor + " session should be created");
        const sessionId = created.body.session.id;

        const failed = await jsonRequest("POST", baseUrl + "/api/sessions/" + sessionId + "/messages", {
          content: "This request should hit a " + supervisor + " CLI failure.",
        });
        assert.equal(failed.status, 500, supervisor + " failure should surface as HTTP 500");
        assert.match(failed.body.error, new RegExp("simulated " + supervisor + " failure"));
        assert.doesNotMatch(failed.body.error, /sk-super-secret-token/);
        assert.ok(failed.body.error.length <= 1000);

        const usageAfterFailure = await usageSnapshot();
        const providerUsage = usageAfterFailure.usage.find((item) => item.id === supervisor);
        assert.equal(providerUsage.active, false);
        assert.match(providerUsage.lastError, new RegExp("simulated " + supervisor + " failure"));
        assert.doesNotMatch(providerUsage.lastError, /sk-super-secret-token/);

        const afterFailure = await loadSession(sessionId);
        assert.equal(afterFailure.messages.length, 1);
        assert.equal(afterFailure.messages[0].role, "user");
        assert.equal(afterFailure.messages[0].content, "This request should hit a " + supervisor + " CLI failure.");

        const recovered = await jsonRequest("POST", baseUrl + "/api/sessions/" + sessionId + "/messages", {
          content: "This request should recover.",
        });
        assert.equal(recovered.status, 200, supervisor + " should recover after failure");
        assert.equal(recovered.body.message.content, "Recovered from fake " + supervisor + ".");

        const loaded = await loadSession(sessionId);
        assert.equal(loaded.messages.length, 3);
        assert.equal(loaded.messages[0].role, "user");
        assert.equal(loaded.messages[1].role, "user");
        assert.equal(loaded.messages[2].role, "assistant");
        assert.equal(loaded.messages[2].content, "Recovered from fake " + supervisor + ".");
      }
      console.log(JSON.stringify({ ok: true }));
    } finally {
      if (server) await new Promise((done) => server.close(done));
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  `;

  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    timeout: 20000,
  });
  assert.deepEqual(JSON.parse(stdout), { ok: true });
});

test("message API retries Gemini with the next model on quota failure", async () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import { request } from "node:http";
    import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "orch-gemini-fallback-workspace-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orch-gemini-fallback-data-"));
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "orch-gemini-fallback-home-"));
    const binDir = await mkdtemp(path.join(os.tmpdir(), "orch-gemini-fallback-bin-"));
    const rootUrl = pathToFileURL(process.cwd() + path.sep).href;
    const argsFile = path.join(dataDir, "gemini-args.log");
    let server;

    process.env.ORCH_WORKSPACE_ROOT = workspaceRoot;
    process.env.ORCH_DATA_DIR = dataDir;
    process.env.HOME = homeDir;
    process.env.ORCH_GIT_INIT_PROJECTS = "0";
    process.env.ORCH_TIMEOUT_MS = "5000";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.PATH = binDir + path.delimiter + process.env.PATH;
    delete process.env.GEMINI_MODEL;
    delete process.env.ORCH_GEMINI_MODEL_PREFERENCE;

    const geminiPath = path.join(binDir, "gemini");
    const stateFile = path.join(dataDir, "fake-gemini-state");
    await writeFile(geminiPath, [
      "#!/usr/bin/env node",
      "import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  appendFileSync(" + JSON.stringify(argsFile) + ", process.argv.slice(2).join(' ') + '\\n');",
      "  const stateFile = " + JSON.stringify(stateFile) + ";",
      "  const count = existsSync(stateFile) ? Number(readFileSync(stateFile, 'utf8')) : 0;",
      "  writeFileSync(stateFile, String(count + 1));",
      "  if (count === 0) {",
      "    console.error('quota is 100% for gemini-2.5-pro');",
      "    process.exit(1);",
      "  }",
      "  console.log('Recovered from fallback gemini.');",
      "});",
    ].join("\n") + "\n", "utf8");
    await chmod(geminiPath, 0o755);

    const { sendErrorJson } = await import(new URL("src/http/response.js", rootUrl));
    const { handleApi } = await import(new URL("src/http/routes.js", rootUrl));

    function startApiServer() {
      server = createServer(async (req, res) => {
        try {
          const url = new URL(req.url || "/", "http://127.0.0.1");
          await handleApi(req, res, url);
        } catch (error) {
          sendErrorJson(res, error);
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
      await mkdir(path.join(workspaceRoot, "project-gemini-fallback"), { recursive: true });
      const created = await jsonRequest("POST", baseUrl + "/api/sessions", {
        supervisor: "gemini",
        cwd: "project-gemini-fallback",
      });
      assert.equal(created.status, 201);

      const response = await jsonRequest("POST", baseUrl + "/api/sessions/" + created.body.session.id + "/messages", {
        content: "Use Gemini and recover after quota.",
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.message.content, "Recovered from fallback gemini.");

      const args = (await readFile(argsFile, "utf8")).trim().split("\n");
      assert.equal(args.length, 2);
      assert.match(args[0], /--model gemini-2\.5-pro/);
      assert.match(args[1], /--model gemini-3\.1-pro-preview/);
      console.log(JSON.stringify({ ok: true }));
    } finally {
      if (server) await new Promise((done) => server.close(done));
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  `;

  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    timeout: 20000,
  });
  assert.deepEqual(JSON.parse(stdout), { ok: true });
});

test("message API allows parallel projects, stops a hung provider call, and recovers", async () => {
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

      const parallelProject = await jsonRequest("POST", baseUrl + "/api/sessions/" + sessionB + "/messages", {
        content: "Concurrent same-supervisor message in another project.",
      });
      assert.equal(parallelProject.status, 200);
      assert.equal(parallelProject.body.message.content, "Recovered after stop.");

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
      assert.equal(deepseekCalls, 3);
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
