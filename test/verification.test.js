import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { checksFromEnv, runHttpSmokeChecks, writeSmokeReport } from "../src/scripts/smoke-report.js";
import { readBody } from "../src/http/response.js";
import { runtime } from "../src/config/env.js";
import { Agent, request } from "node:http";

const execFileAsync = promisify(execFile);

function startMockServer(handler) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test("checksFromEnv preserves defaults when env is empty", () => {
  const defaults = checksFromEnv("");
  assert.deepEqual(defaults.map((check) => check.path), ["/", "/api/config", "/app.js", "/client-helpers.js", "/styles.css"]);

  const custom = checksFromEnv(" / , api/config ");
  assert.deepEqual(custom.map((check) => check.path), ["/", "/api/config"]);
  assert.equal(custom[1].expectJson, true);
});

test("recent public config options stay documented", async () => {
  const [readme, envExample] = await Promise.all([
    readFile(path.resolve("README.md"), "utf8"),
    readFile(path.resolve(".env.example"), "utf8"),
  ]);
  const publicOptions = [
    "ORCH_AUTOPILOT_IDLE_TIMEOUT_MS",
    "ORCH_AUTOPILOT_IDLE_WARNING_MS",
    "ORCH_AUTOPILOT_DECISION_TIMEOUT_MS",
    "ORCH_AUTOPILOT_RETRY_ATTEMPTS",
    "ORCH_AUTOPILOT_RETRY_BACKOFF_MS",
    "ORCH_AUTOPILOT_FEED_LIMIT",
    "ORCH_AUTOPILOT_SERVER_LOOP_MS",
    "ORCH_BUDGET_WARNING_USD",
    "ORCH_USAGE_POLL_INTERVAL_MS",
    "ORCH_UPLOAD_INLINE_CHARS",
    "ORCH_UPLOAD_MAX_BYTES",
    "ORCH_DOCKER_SOCKET",
    "ORCH_DOCKER_HOST",
  ];

  for (const option of publicOptions) {
    assert.match(readme, new RegExp(`\\b${option}\\b`), `${option} missing from README.md`);
    assert.match(envExample, new RegExp(`\\b${option}\\b`), `${option} missing from .env.example`);
  }
});

test("Docker supervisor access stays wired into image and compose", async () => {
  const [dockerfile, compose, entrypoint] = await Promise.all([
    readFile(path.resolve("Dockerfile"), "utf8"),
    readFile(path.resolve("docker-compose.yml"), "utf8"),
    readFile(path.resolve("docker-entrypoint.sh"), "utf8"),
  ]);

  assert.match(dockerfile, /\bdocker-ce-cli\b/);
  assert.match(dockerfile, /\bdocker-compose-plugin\b/);
  assert.match(compose, /DOCKER_HOST/);
  assert.match(compose, /\/var\/run\/docker\.sock/);
  assert.match(entrypoint, /usermod -aG "\$docker_group" node/);
});

test("autopilot decision timeout follows idle timeout unless explicitly set", async () => {
  const script = [
    "import { runtime } from './src/config/env.js';",
    "console.log(JSON.stringify({ idle: runtime.autopilotIdleTimeoutMs, decision: runtime.autopilotDecisionTimeoutMs }));",
  ].join("");

  const baseEnv = {
    ...process.env,
    ORCH_DATA_DIR: await mkdtemp(path.join(os.tmpdir(), "orch-env-")),
    ORCH_AUTOPILOT_IDLE_TIMEOUT_MS: "1234",
  };
  delete baseEnv.ORCH_AUTOPILOT_DECISION_TIMEOUT_MS;

  try {
    const inherited = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], { env: baseEnv });
    assert.deepEqual(JSON.parse(inherited.stdout), { idle: 1234, decision: 1234 });

    const disabled = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      env: { ...baseEnv, ORCH_AUTOPILOT_DECISION_TIMEOUT_MS: "0" },
    });
    assert.deepEqual(JSON.parse(disabled.stdout), { idle: 1234, decision: 0 });
  } finally {
    await rm(baseEnv.ORCH_DATA_DIR, { recursive: true, force: true });
  }
});

test("runHttpSmokeChecks records passing HTTP and JSON checks", async () => {
  const server = await startMockServer((req, res) => {
    if (req.url === "/api/config") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ supervisors: {} }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html></html>");
  });
  try {
    const report = await runHttpSmokeChecks({
      baseUrl: server.baseUrl,
      checks: [
        { path: "/", expectContentType: "text/html" },
        { path: "/api/config", expectJson: true },
      ],
      retries: 0,
      retryDelayMs: 1,
    });

    assert.equal(report.passed, true);
    assert.equal(report.checks.length, 2);
    assert.equal(report.checks.every((check) => check.passed), true);
    assert.equal(report.authConfigured, false);
  } finally {
    await server.close();
  }
});

test("runHttpSmokeChecks fails bad status and redacts snippets", async () => {
  const server = await startMockServer((_req, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("Authorization: Bearer abcdefghijklmnop");
  });
  try {
    const report = await runHttpSmokeChecks({
      baseUrl: server.baseUrl,
      checks: [{ path: "/broken" }],
      auth: "orchestrator:secret-password",
      retries: 0,
      retryDelayMs: 1,
    });

    assert.equal(report.passed, false);
    assert.equal(report.authConfigured, true);
    assert.equal(report.checks[0].status, 500);
    assert.match(report.checks[0].errors.join("\n"), /HTTP 500/);
    assert.match(report.checks[0].snippet, /Authorization: \[redacted\]/);
    assert.doesNotMatch(JSON.stringify(report), /secret-password|abcdefghijklmnop/);
  } finally {
    await server.close();
  }
});

test("runHttpSmokeChecks redacts credential URLs and limits response bodies", async () => {
  const largeBody = `Authorization: Basic dXNlcjpwYXNzMTIz\n${"x".repeat(5000)}`;
  const server = await startMockServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(largeBody);
  });
  try {
    const base = new URL(server.baseUrl);
    base.username = "user";
    base.password = "secret-password";
    const report = await runHttpSmokeChecks({
      baseUrl: base.toString(),
      checks: [{ path: "/large" }],
      retries: 0,
      retryDelayMs: 1,
      maxBodyBytes: 32,
    });

    assert.equal(report.passed, true);
    assert.equal(report.authConfigured, true);
    assert.doesNotMatch(JSON.stringify(report), /secret-password|dXNlcjpwYXNzMTIz/);
    assert.match(report.checks[0].snippet, /Authorization: (Basic )?\[redacted\]/);
    assert.equal(report.checks[0].bodyTruncated, true);
  } finally {
    await server.close();
  }
});

test("readBody returns a 413 JSON over keep-alive while a chunked upload is in progress (no ECONNRESET)", async () => {
  const originalMax = runtime.maxPayloadBytes;
  runtime.maxPayloadBytes = 256;
  const server = createServer(async (req, res) => {
    try {
      await readBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    } catch (error) {
      const status = error?.status || 500;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message || String(error) }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const agent = new Agent({ keepAlive: true });
  try {
    const { port } = server.address();
    // Stream the body in small chunks so the server rejects mid-upload — the original regression
    // (req.destroy / for-await return) surfaced as a client-side ECONNRESET in that window.
    const responseBody = await new Promise((resolve, reject) => {
      const req = request({
        method: "POST",
        host: "127.0.0.1",
        port,
        path: "/",
        agent,
        headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
      }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", reject);
      // Push enough chunks past the 256-byte limit; the third write is what trips it.
      let writes = 0;
      const next = () => {
        if (writes >= 8) { req.end(); return; }
        writes += 1;
        req.write(Buffer.alloc(128, "x"), () => setTimeout(next, 5));
      };
      next();
    });
    assert.equal(responseBody.status, 413);
    assert.match(responseBody.body, /exceeds/);
  } finally {
    agent.destroy();
    runtime.maxPayloadBytes = originalMax;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("writeSmokeReport writes structured JSON artifact", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orch-verification-"));
  try {
    const filePath = path.join(dir, "smoke.json");
    await writeSmokeReport({ schemaVersion: 1, passed: true, checks: [] }, filePath);
    const report = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.passed, true);
    assert.deepEqual(report.checks, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
