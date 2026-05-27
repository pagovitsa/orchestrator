import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { redactSensitiveText } from "../domain/safety.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "../..");

const defaultChecks = [
  { path: "/", expectContentType: "text/html" },
  { path: "/api/config", expectJson: true },
  { path: "/app.js", expectContentType: "application/javascript" },
  { path: "/client-helpers.js", expectContentType: "application/javascript" },
  { path: "/styles.css", expectContentType: "text/css" },
];

const defaultTimeoutMs = 5000;
const defaultRetries = 2;
const defaultRetryDelayMs = 1000;
const defaultMaxBodyBytes = 1024 * 1024;

function envNumber(name, defaultValue) {
  const value = Number(process.env[name] || defaultValue);
  return Number.isFinite(value) ? value : defaultValue;
}

function normalizePath(value) {
  const input = String(value || "").trim();
  if (!input) return "/";
  return input.startsWith("/") ? input : `/${input}`;
}

export function checksFromEnv(value) {
  const paths = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!paths.length) return defaultChecks;
  return paths.map((item) => {
    const normalized = normalizePath(item);
    return {
      path: normalized,
      expectJson: normalized.startsWith("/api/"),
    };
  });
}

function basicAuthHeader(auth) {
  const value = String(auth || "");
  if (!value) return "";
  return `Basic ${Buffer.from(value).toString("base64")}`;
}

function normalizeBaseUrl(baseUrl, explicitAuth = "") {
  const url = new URL(baseUrl);
  const embeddedAuth = url.username || url.password
    ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
    : "";
  url.username = "";
  url.password = "";
  return {
    fetchBaseUrl: url.toString(),
    reportBaseUrl: url.toString(),
    auth: explicitAuth || embeddedAuth,
  };
}

function safeUrlForReport(url) {
  const copy = new URL(url);
  copy.username = copy.username ? "[redacted]" : "";
  copy.password = copy.password ? "[redacted]" : "";
  return copy.toString();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeSnippet(text, limit = 240) {
  const sample = String(text || "").slice(0, 2000);
  const compact = redactSensitiveText(sample)
    .replace(/\s+/g, " ")
    .trim();
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

async function readLimitedText(response, maxBytes = defaultMaxBodyBytes) {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    while (total <= maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, Math.max(0, remaining)));
        total = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return {
    text: new TextDecoder().decode(Buffer.concat(chunks)),
    truncated,
  };
}

function reportPath(timestamp = new Date()) {
  const stamp = timestamp.toISOString().replace(/[:.]/g, "-");
  return path.join(appRoot, "verification", `smoke-${stamp}.json`);
}

async function fetchWithTimeout(url, { headers = {}, timeoutMs = defaultTimeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function runSingleCheck(baseUrl, check, options = {}) {
  const started = Date.now();
  const url = new URL(normalizePath(check.path), baseUrl);
  const headers = {};
  const authHeader = basicAuthHeader(options.auth);
  if (authHeader) headers.authorization = authHeader;

  try {
    const response = await fetchWithTimeout(url, { headers, timeoutMs: options.timeoutMs });
    const contentType = response.headers.get("content-type") || "";
    const { text: body, truncated } = await readLimitedText(response, options.maxBodyBytes);
    const errors = [];
    if (response.status < 200 || response.status >= 400) errors.push(`HTTP ${response.status}`);
    if (check.expectContentType && !contentType.includes(check.expectContentType)) {
      errors.push(`expected content-type ${check.expectContentType}`);
    }
    if (check.expectJson) {
      try {
        JSON.parse(body);
      } catch {
        errors.push("expected valid JSON");
      }
    }
    return {
      path: check.path,
      url: url.toString(),
      status: response.status,
      contentType,
      elapsedMs: Date.now() - started,
      passed: errors.length === 0,
      errors,
      bodyTruncated: truncated,
      snippet: safeSnippet(body),
    };
  } catch (error) {
    return {
      path: check.path,
      url: url.toString(),
      status: null,
      contentType: "",
      elapsedMs: Date.now() - started,
      passed: false,
      errors: [error.message || String(error)],
      bodyTruncated: false,
      snippet: "",
    };
  }
}

export async function runHttpSmokeChecks({
  baseUrl,
  checks = defaultChecks,
  auth = "",
  timeoutMs = defaultTimeoutMs,
  retries = defaultRetries,
  retryDelayMs = defaultRetryDelayMs,
  maxBodyBytes = defaultMaxBodyBytes,
  now = new Date(),
} = {}) {
  if (!baseUrl) throw new Error("baseUrl is required");
  const normalizedBase = normalizeBaseUrl(baseUrl, auth);
  const attempts = Math.max(1, Math.floor(Number(retries) || 0) + 1);
  const report = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    baseUrl: safeUrlForReport(normalizedBase.reportBaseUrl),
    authConfigured: Boolean(normalizedBase.auth),
    passed: false,
    checks: [],
  };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const results = [];
    for (const check of checks) {
      results.push(await runSingleCheck(normalizedBase.fetchBaseUrl, check, {
        auth: normalizedBase.auth,
        timeoutMs,
        maxBodyBytes,
      }));
    }
    report.checks = results.map((result) => ({ ...result, attempt }));
    report.passed = report.checks.every((check) => check.passed);
    if (report.passed || attempt >= attempts) break;
    await wait(retryDelayMs);
  }

  return report;
}

export async function writeSmokeReport(report, filePath = reportPath()) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return filePath;
}

export async function main() {
  const baseUrl = process.env.ORCH_SMOKE_BASE_URL || "http://127.0.0.1:8787/";
  const report = await runHttpSmokeChecks({
    baseUrl,
    checks: checksFromEnv(process.env.ORCH_SMOKE_CHECKS),
    auth: process.env.ORCH_SMOKE_AUTH || "",
    timeoutMs: envNumber("ORCH_SMOKE_TIMEOUT_MS", defaultTimeoutMs),
    retries: envNumber("ORCH_SMOKE_RETRIES", defaultRetries),
    retryDelayMs: envNumber("ORCH_SMOKE_RETRY_DELAY_MS", defaultRetryDelayMs),
    maxBodyBytes: envNumber("ORCH_SMOKE_MAX_BODY_BYTES", defaultMaxBodyBytes),
  });
  const filePath = await writeSmokeReport(report);
  const passed = report.checks.filter((check) => check.passed).length;
  const summary = `${passed}/${report.checks.length} smoke checks passed. Report: ${filePath}`;
  if (!report.passed) {
    console.error(summary);
    for (const check of report.checks.filter((item) => !item.passed)) {
      console.error(`- ${check.path}: ${check.errors.join("; ")}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(summary);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
