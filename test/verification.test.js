import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checksFromEnv, runHttpSmokeChecks, writeSmokeReport } from "../src/scripts/smoke-report.js";

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
    "ORCH_AUTOPILOT_RETRY_ATTEMPTS",
    "ORCH_AUTOPILOT_RETRY_BACKOFF_MS",
    "ORCH_AUTOPILOT_FEED_LIMIT",
    "ORCH_BUDGET_WARNING_USD",
    "ORCH_USAGE_POLL_INTERVAL_MS",
    "ORCH_UPLOAD_INLINE_CHARS",
    "ORCH_UPLOAD_MAX_BYTES",
  ];

  for (const option of publicOptions) {
    assert.match(readme, new RegExp(`\\b${option}\\b`), `${option} missing from README.md`);
    assert.match(envExample, new RegExp(`\\b${option}\\b`), `${option} missing from .env.example`);
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
