import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { paths, runtime, supervisors } from "../config/env.js";

const DEEPSEEK_BALANCE_TTL_MS = 60_000;
const PROBE_OUTPUT_LIMIT = 5000;
const GEMINI_CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com/v1internal";
const CLAUDE_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
let usageLock = Promise.resolve();
let deepSeekBalanceCache = { at: 0, promise: null, result: null };
let usagePollTimer = null;
let usagePollInFlight = null;
const usageProbeInFlight = new Map();
const usageProbeVersions = new Map();
let geminiOAuthConfigCache = null;

const cliProbeConfigs = {
  claude: {
    kind: "claude-oauth-usage",
    displayCommand: "/usage",
    timeoutMs: 15_000,
  },
  codex: {
    kind: "codex-app-server",
    displayCommand: "/status",
    timeoutMs: 20_000,
  },
  gemini: {
    kind: "gemini-code-assist-quota",
    displayCommand: "/stats model",
    timeoutMs: 20_000,
  },
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function defaultModelUsage(id) {
  return {
    id,
    totalRuns: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    active: false,
    activeRunTokens: 0,
    activeRunCostUsd: 0,
    lastStartedAt: "",
    lastFinishedAt: "",
    lastError: "",
    lastKnownPercent: null,
    lastKnownLabel: "",
    lastKnownAt: "",
    currentPercent: null,
    weeklyPercent: null,
    sonnetWeeklyPercent: null,
    lastTokens: null,
    lastCostUsd: null,
    lastProbeAt: "",
    lastProbeError: "",
    lastProbeOutput: "",
    lastProbeCommand: "",
    balanceAvailable: null,
    balanceLabel: "",
    balanceCurrency: "",
    balanceTotal: "",
    balanceGranted: "",
    balanceToppedUp: "",
    balanceUpdatedAt: "",
    balanceError: "",
    balanceObservedMax: null,
    balanceRemaining: null,
    balanceSpent: null,
    balanceUsagePercent: null,
    days: {},
  };
}

function normalizeStore(raw = {}) {
  const models = raw.models && typeof raw.models === "object" ? raw.models : {};
  for (const id of Object.keys(supervisors)) {
    models[id] = { ...defaultModelUsage(id), ...(models[id] || {}) };
    models[id].days = models[id].days && typeof models[id].days === "object" ? models[id].days : {};
    for (const day of Object.keys(models[id].days)) {
      models[id].days[day] = normalizeDay(models[id].days[day]);
    }
  }
  return { schemaVersion: 1, models };
}

function usageFilePath() {
  return path.join(paths.dataDir, "usage.json");
}

async function readStore() {
  try {
    return normalizeStore(JSON.parse(await readFile(usageFilePath(), "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return normalizeStore();
    throw error;
  }
}

async function writeStore(store) {
  const file = usageFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  const tempPath = path.join(path.dirname(file), `${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(tempPath, file);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function withUsageLock(task) {
  const run = usageLock.catch(() => {}).then(task);
  usageLock = run.catch(() => {});
  return run;
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasAuthFile(dir, names) {
  for (const name of names) {
    if (await pathExists(path.join(dir, name))) return true;
  }
  return false;
}

function normalizeDay(day = {}) {
  return {
    runs: Number.isFinite(day.runs) ? day.runs : 0,
    tokens: Number.isFinite(day.tokens) ? day.tokens : 0,
    costUsd: Number.isFinite(day.costUsd) ? day.costUsd : 0,
  };
}

function daily(model) {
  const key = todayKey();
  model.days[key] = normalizeDay(model.days[key]);
  return model.days[key];
}

function clampPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function addUsageDeltas(model, { tokens = null, costUsd = null } = {}) {
  const day = daily(model);
  const tokenValue = numberOrNull(tokens);
  if (tokenValue !== null) {
    const rounded = Math.max(0, Math.round(tokenValue));
    const previous = numberOrNull(model.activeRunTokens) ?? 0;
    const delta = Math.max(0, rounded - previous);
    model.activeRunTokens = Math.max(previous, rounded);
    model.lastTokens = rounded;
    model.totalTokens = Math.max(0, Math.round(numberOrNull(model.totalTokens) ?? 0) + delta);
    day.tokens = Math.max(0, Math.round(numberOrNull(day.tokens) ?? 0) + delta);
  }

  const costValue = numberOrNull(costUsd);
  if (costValue !== null) {
    const clean = Math.max(0, costValue);
    const previous = numberOrNull(model.activeRunCostUsd) ?? 0;
    const delta = Math.max(0, clean - previous);
    model.activeRunCostUsd = Math.max(previous, clean);
    model.lastCostUsd = clean;
    model.totalCostUsd = Math.max(0, (numberOrNull(model.totalCostUsd) ?? 0) + delta);
    day.costUsd = Math.max(0, (numberOrNull(day.costUsd) ?? 0) + delta);
  }
}

function addDeepSeekBalanceCost(model, spent) {
  const spentValue = numberOrNull(spent);
  if (spentValue === null) return;
  const previousSpent = numberOrNull(model.balanceSpent) ?? 0;
  const delta = Math.max(0, spentValue - previousSpent);
  if (!delta) return;
  const day = daily(model);
  model.totalCostUsd = Math.max(0, (numberOrNull(model.totalCostUsd) ?? 0) + delta);
  day.costUsd = Math.max(0, (numberOrNull(day.costUsd) ?? 0) + delta);
}

function stripAnsi(text) {
  return String(text || "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[PX^_].*?\u001B\\/gs, "")
    .replace(/\u001B[78=>]/g, "");
}

function redactProbeText(text) {
  return stripAnsi(text)
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "sk-...redacted")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ...redacted")
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)(["':=\s]+)[^\s"',}]+/gi, "$1$2...redacted")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, PROBE_OUTPUT_LIMIT);
}

function probeEnv(extra = {}) {
  const env = {
    ...process.env,
    TERM: process.env.TERM || "xterm-256color",
    COLUMNS: "100",
    LINES: "32",
  };
  for (const key of ["DEEPSEEK_API_KEY", "CUSTOM_API_KEY", "ORCH_AUTH_PASSWORD"]) delete env[key];
  return { ...env, ...extra };
}

function bestStatusLine(output) {
  const lines = String(output || "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /usage|limit|remaining|reset|quota|plan|subscription|balance|rate|tokens?/i.test(line)) ||
    lines.find((line) => !line.startsWith("/") && line.length > 8) ||
    "";
}

function usagePercentLabel(line) {
  if (/current|session|today|daily/i.test(line)) return "current";
  if (/week|weekly|7d|seven day/i.test(line)) return "weekly";
  return "other";
}

function usagePercentFromLine(value, line) {
  const percent = clampPercent(value);
  if (percent === null) return null;
  const reportsRemaining = /\b(remain(?:ing)?|left|available|unused|free)\b/i.test(line) &&
    !/\b(usage|used|spent|consumed)\b/i.test(line);
  return reportsRemaining ? 100 - percent : percent;
}

export function parseUsageProbeOutput(output) {
  const clean = redactProbeText(output);
  const percentages = [];
  for (const line of clean.split("\n")) {
    if (!/usage|limit|remaining|reset|quota|capacity|rate|current|session|today|daily|week|weekly|7d/i.test(line)) continue;
    for (const match of line.matchAll(/\b(\d{1,3})\s*%/g)) {
      const percent = usagePercentFromLine(match[1], line);
      if (percent === null) continue;
      percentages.push({ percent, label: usagePercentLabel(line), line });
    }
  }
  const maxFor = (label) => percentages
    .filter((item) => item.label === label)
    .reduce((max, item) => max === null ? item.percent : Math.max(max, item.percent), null);
  const current = maxFor("current");
  const weekly = maxFor("weekly");
  const percent = percentages.reduce((max, item) => max === null ? item.percent : Math.max(max, item.percent), null);
  const tokenMatch = clean.match(/tokens?\s+(?:used\s*)?[:=]?\s*([0-9][0-9,]*)/i) ||
    clean.match(/([0-9][0-9,]*)\s+tokens?\b/i);
  return {
    output: clean,
    percent,
    currentPercent: current,
    weeklyPercent: weekly,
    tokens: tokenMatch ? Number(tokenMatch[1].replace(/,/g, "")) : null,
    label: percentages.find((item) => item.percent === percent)?.line || bestStatusLine(clean),
  };
}

function maxPercent(...values) {
  return values.reduce((max, value) => {
    const percent = clampPercent(value);
    if (percent === null) return max;
    return max === null ? percent : Math.max(max, percent);
  }, null);
}

function isoResetLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function claudeUsageWindowLabel(label, window) {
  const percent = clampPercent(window?.utilization);
  if (percent === null) return "";
  const reset = isoResetLabel(window?.resets_at);
  return `${label} ${percent}%${reset ? ` reset ${reset}` : ""}`;
}

export function parseClaudeUsagePayload(payload = {}) {
  const currentPercent = clampPercent(payload.five_hour?.utilization);
  const weeklyPercent = clampPercent(payload.seven_day?.utilization);
  const sonnetWeeklyPercent = clampPercent(payload.seven_day_sonnet?.utilization);
  const percent = maxPercent(currentPercent, weeklyPercent, sonnetWeeklyPercent);
  const parts = [
    claudeUsageWindowLabel("5h", payload.five_hour),
    claudeUsageWindowLabel("7d", payload.seven_day),
    claudeUsageWindowLabel("sonnet", payload.seven_day_sonnet),
  ].filter(Boolean);
  const extra = payload.extra_usage;
  if (extra && typeof extra === "object" && extra.is_enabled) {
    const used = numberOrNull(extra.used_credits);
    const limit = numberOrNull(extra.monthly_limit);
    const currency = String(extra.currency || "").trim();
    if (used !== null && limit !== null) {
      parts.push(`usage credits ${currency ? `${currency} ` : ""}${used}/${limit}`);
    } else {
      parts.push("usage credits enabled");
    }
  }
  const output = parts.length ? parts.join("\n") : "Claude usage endpoint returned no limits";
  return {
    output,
    percent,
    currentPercent,
    weeklyPercent,
    sonnetWeeklyPercent,
    label: parts.length ? `Claude usage: ${parts.join(" · ")}` : "Claude usage unavailable",
  };
}

function unixResetLabel(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  return new Date(number * 1000).toISOString();
}

function rateLimitWindowLabel(label, window) {
  const percent = clampPercent(window?.usedPercent);
  if (percent === null) return "";
  const minutes = Number(window?.windowDurationMins);
  const duration = Number.isFinite(minutes) && minutes > 0
    ? minutes >= 60 * 24 ? `${Math.round(minutes / (60 * 24))}d` : `${Math.round(minutes / 60)}h`
    : label;
  const reset = unixResetLabel(window?.resetsAt);
  return `${duration} ${percent}%${reset ? ` reset ${reset}` : ""}`;
}

function codexSnapshotSignal(snapshot = {}) {
  const currentPercent = clampPercent(snapshot.primary?.usedPercent);
  const weeklyPercent = clampPercent(snapshot.secondary?.usedPercent);
  const percent = maxPercent(currentPercent, weeklyPercent);
  if (percent === null) return null;
  const labelParts = [
    snapshot.limitName || snapshot.limitId || "codex",
    snapshot.planType ? `plan ${snapshot.planType}` : "",
    rateLimitWindowLabel("current", snapshot.primary),
    rateLimitWindowLabel("week", snapshot.secondary),
  ].filter(Boolean);
  return {
    percent,
    currentPercent,
    weeklyPercent,
    label: `Codex rate limits: ${labelParts.join(" · ")}`,
    output: labelParts.join("\n"),
  };
}

export function parseCodexRateLimitPayload(payload = {}) {
  const snapshots = Object.values(payload.rateLimitsByLimitId || {}).filter(Boolean);
  if (payload.rateLimits) snapshots.push(payload.rateLimits);
  const signals = snapshots.map(codexSnapshotSignal).filter(Boolean);
  if (!signals.length) {
    return {
      percent: null,
      currentPercent: null,
      weeklyPercent: null,
      label: "Codex rate limits unavailable",
      output: "Codex app-server returned no rate limit buckets",
    };
  }
  return signals.reduce((best, signal) => signal.percent > best.percent ? signal : best);
}

function geminiBucketSignal(bucket = {}) {
  const remainingFraction = Number(bucket.remainingFraction);
  const remainingAmount = numberOrNull(bucket.remainingAmount);
  if (!Number.isFinite(remainingFraction)) return null;
  const percent = clampPercent((1 - remainingFraction) * 100);
  if (percent === null) return null;
  const reset = bucket.resetTime ? new Date(bucket.resetTime).toISOString() : "";
  const remainingText = remainingAmount !== null
    ? `${remainingAmount} left`
    : `${Math.max(0, Math.round(remainingFraction * 100))}% left`;
  return {
    percent,
    currentPercent: percent,
    weeklyPercent: null,
    label: `${bucket.modelId || "Gemini model"} ${percent}% used (${remainingText})${reset ? ` reset ${reset}` : ""}`,
    output: [
      `model ${bucket.modelId || "unknown"}`,
      `used ${percent}%`,
      remainingText,
      reset ? `reset ${reset}` : "",
    ].filter(Boolean).join("\n"),
  };
}

export function parseGeminiQuotaPayload(payload = {}, loadInfo = {}) {
  const buckets = Array.isArray(payload.buckets) ? payload.buckets : [];
  const signals = buckets.map(geminiBucketSignal).filter(Boolean);
  if (!signals.length) {
    return {
      percent: null,
      currentPercent: null,
      weeklyPercent: null,
      label: "Gemini quota unavailable",
      output: "Gemini Code Assist returned no quota buckets",
    };
  }
  const best = signals.reduce((max, signal) => signal.percent > max.percent ? signal : max);
  const tier = loadInfo?.paidTier?.name || loadInfo?.currentTier?.name || "";
  return {
    ...best,
    label: `Gemini quota: ${best.label}${tier ? ` · ${tier}` : ""}`,
  };
}

function moneyLabel(balanceInfo) {
  if (!balanceInfo) return "";
  const currency = String(balanceInfo.currency || "").trim();
  const total = String(balanceInfo.total_balance || "").trim();
  if (!currency || !total) return "";
  return `${currency} ${total}`;
}

function normalizeDeepSeekBalance(payload) {
  const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
  const preferred = infos.find((item) => item?.currency === "USD") || infos[0] || null;
  return {
    mode: "balance",
    balanceAvailable: Boolean(payload?.is_available),
    balanceLabel: moneyLabel(preferred),
    balanceCurrency: preferred?.currency || "",
    balanceTotal: preferred?.total_balance || "",
    balanceGranted: preferred?.granted_balance || "",
    balanceToppedUp: preferred?.topped_up_balance || "",
    balanceUpdatedAt: new Date().toISOString(),
    balanceError: "",
  };
}

export function calculateBalanceUsage(previousObservedMax, currentRemaining) {
  const remaining = numberOrNull(currentRemaining);
  const previousMax = numberOrNull(previousObservedMax);
  const observedMax = remaining === null
    ? previousMax
    : previousMax === null ? remaining : Math.max(previousMax, remaining);
  const spent = remaining !== null && observedMax !== null ? Math.max(0, observedMax - remaining) : null;
  const usagePercent = spent !== null && observedMax !== null && observedMax > 0
    ? clampPercent((spent / observedMax) * 100)
    : null;
  return { observedMax, remaining, spent, usagePercent };
}

async function fetchDeepSeekBalance() {
  if (!runtime.deepseekApiKey) {
    return {
      mode: "unknown",
      clearBalance: true,
      balanceAvailable: null,
      balanceLabel: "",
      balanceCurrency: "",
      balanceTotal: "",
      balanceGranted: "",
      balanceToppedUp: "",
      balanceUpdatedAt: new Date().toISOString(),
      balanceError: "DeepSeek API key not connected; skipping usage probe",
    };
  }
  const now = Date.now();
  if (deepSeekBalanceCache.result && now - deepSeekBalanceCache.at < DEEPSEEK_BALANCE_TTL_MS) {
    return deepSeekBalanceCache.result;
  }
  if (deepSeekBalanceCache.promise) return deepSeekBalanceCache.promise;
  deepSeekBalanceCache.promise = (async () => {
    try {
      const response = await fetch("https://api.deepseek.com/user/balance", {
        headers: { authorization: `Bearer ${runtime.deepseekApiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`DeepSeek balance HTTP ${response.status}`);
      const result = normalizeDeepSeekBalance(await response.json());
      deepSeekBalanceCache = { at: Date.now(), promise: null, result };
      return result;
    } catch (error) {
      const result = {
        mode: "unknown",
        balanceAvailable: false,
        balanceLabel: "",
        balanceCurrency: "",
        balanceTotal: "",
        balanceGranted: "",
        balanceToppedUp: "",
        balanceUpdatedAt: new Date().toISOString(),
        balanceError: error.message || String(error),
      };
      deepSeekBalanceCache = { at: Date.now(), promise: null, result };
      return result;
    }
  })();
  return deepSeekBalanceCache.promise;
}

function runShellProbe({ command, timeoutMs = 15_000, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: paths.workspaceRoot,
      env: probeEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const append = (chunk) => {
      output = `${output}${chunk.toString("utf8")}`;
      if (output.length > PROBE_OUTPUT_LIMIT * 4) output = output.slice(-PROBE_OUTPUT_LIMIT * 4);
    };
    const finish = (error = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ...parseUsageProbeOutput(output), error });
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
      finish("usage probe timed out");
    }, timeoutMs);
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.stdin.on("error", () => {});
    if (child.stdin.writable) child.stdin.end();
    child.on("error", (error) => finish(error.message || String(error)));
    child.on("close", (code) => finish(code ? `usage probe exited ${code}` : ""));
  });
}

async function readClaudeOauthCredentials() {
  const file = path.join(paths.homeDir, ".claude", ".credentials.json");
  const credentials = JSON.parse(await readFile(file, "utf8"));
  const oauth = credentials.claudeAiOauth && typeof credentials.claudeAiOauth === "object"
    ? credentials.claudeAiOauth
    : {};
  if (!oauth.accessToken) throw new Error("Claude OAuth token is missing; reconnect Claude CLI");
  return oauth;
}

async function probeClaudeOauthUsage({ timeoutMs = 15_000 } = {}) {
  const oauth = await readClaudeOauthCredentials();
  const response = await fetch(CLAUDE_USAGE_ENDPOINT, {
    headers: {
      authorization: `Bearer ${oauth.accessToken}`,
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("Claude OAuth token cannot read usage; reconnect Claude CLI");
  }
  if (!response.ok) throw new Error(`Claude usage HTTP ${response.status}`);
  return parseClaudeUsagePayload(await response.json());
}

function runCodexAppServerProbe({ timeoutMs = 20_000 }) {
  return new Promise((resolve) => {
    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      cwd: paths.workspaceRoot,
      env: probeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let stdoutBuffer = "";
    let settled = false;
    const append = (chunk) => {
      output = `${output}${chunk.toString("utf8")}`;
      if (output.length > PROBE_OUTPUT_LIMIT * 4) output = output.slice(-PROBE_OUTPUT_LIMIT * 4);
    };
    const finish = (signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        ...signal,
        output: signal.output || redactProbeText(output),
        error: signal.error || "",
      });
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
    };
    const timeout = setTimeout(() => {
      finish({
        ...parseUsageProbeOutput(output),
        error: "Codex app-server rate limit probe timed out",
      });
    }, timeoutMs);
    const handleLine = (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id !== 2) return;
      if (message.error) {
        finish({
          ...parseUsageProbeOutput(output),
          error: message.error.message || "Codex app-server rate limit probe failed",
        });
        return;
      }
      finish(parseCodexRateLimitPayload(message.result || {}));
    };

    child.stdout.on("data", (chunk) => {
      append(chunk);
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) handleLine(line);
    });
    child.stderr.on("data", append);
    child.stdin.on("error", () => {});
    child.on("error", (error) => finish({ error: error.message || String(error) }));
    child.on("close", (code) => {
      if (settled) return;
      if (stdoutBuffer) handleLine(stdoutBuffer);
      finish({
        ...parseUsageProbeOutput(output),
        error: code ? `Codex app-server rate limit probe exited ${code}` : "Codex app-server closed before returning rate limits",
      });
    });
    const messages = [
      { id: 1, method: "initialize", params: { clientInfo: { name: "orch-ui", version: "0" }, capabilities: { experimentalApi: true } } },
      { method: "initialized" },
      { id: 2, method: "account/rateLimits/read" },
    ];
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

async function readGeminiOauthCredentials() {
  const file = path.join(paths.homeDir, ".gemini", "oauth_creds.json");
  const credentials = JSON.parse(await readFile(file, "utf8"));
  return { file, credentials };
}

async function geminiOauthClientConfig() {
  if (geminiOAuthConfigCache) return geminiOAuthConfigCache;
  if (process.env.GEMINI_OAUTH_CLIENT_ID && process.env.GEMINI_OAUTH_CLIENT_SECRET) {
    geminiOAuthConfigCache = {
      clientId: process.env.GEMINI_OAUTH_CLIENT_ID,
      clientSecret: process.env.GEMINI_OAUTH_CLIENT_SECRET,
    };
    return geminiOAuthConfigCache;
  }

  const bundleDir = process.env.GEMINI_CLI_BUNDLE_DIR ||
    "/usr/local/lib/node_modules/@google/gemini-cli/bundle";
  const files = await readdir(bundleDir);
  for (const file of files) {
    if (!file.endsWith(".js")) continue;
    const source = await readFile(path.join(bundleDir, file), "utf8");
    const clientId = source.match(/\bOAUTH_CLIENT_ID\s*=\s*"([^"]+)"/)?.[1];
    const clientSecret = source.match(/\bOAUTH_CLIENT_SECRET\s*=\s*"([^"]+)"/)?.[1];
    if (clientId && clientSecret) {
      geminiOAuthConfigCache = { clientId, clientSecret };
      return geminiOAuthConfigCache;
    }
  }
  throw new Error("Gemini OAuth client config not found; set GEMINI_OAUTH_CLIENT_ID and GEMINI_OAUTH_CLIENT_SECRET");
}

async function geminiAccessToken() {
  const { file, credentials } = await readGeminiOauthCredentials();
  const expiresAt = Number(credentials.expiry_date || 0);
  if (credentials.access_token && expiresAt > Date.now() + 60_000) return credentials.access_token;
  if (!credentials.refresh_token) throw new Error("Gemini OAuth refresh token is missing; reconnect Gemini CLI");
  const oauthClient = await geminiOauthClientConfig();

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: oauthClient.clientId,
      client_secret: oauthClient.clientSecret,
      refresh_token: credentials.refresh_token,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Gemini OAuth refresh HTTP ${response.status}`);
  const refreshed = await response.json();
  if (!refreshed.access_token) throw new Error("Gemini OAuth refresh returned no access token");
  const next = {
    ...credentials,
    access_token: refreshed.access_token,
    token_type: refreshed.token_type || credentials.token_type || "Bearer",
    expiry_date: Date.now() + Math.max(0, Number(refreshed.expires_in || 0)) * 1000,
  };
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next.access_token;
}

async function postGeminiCodeAssist(method, body, accessToken) {
  const response = await fetch(`${GEMINI_CODE_ASSIST_ENDPOINT}:${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Gemini Code Assist ${method} HTTP ${response.status}`);
  return response.json();
}

async function probeGeminiCodeAssistQuota() {
  const token = await geminiAccessToken();
  const loadInfo = await postGeminiCodeAssist("loadCodeAssist", {
    metadata: {
      ideType: "IDE_UNSPECIFIED",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  }, token);
  const project = loadInfo.cloudaicompanionProject || process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
  if (!project) throw new Error("Gemini Code Assist project is missing");
  const quota = await postGeminiCodeAssist("retrieveUserQuota", { project }, token);
  return parseGeminiQuotaPayload(quota, loadInfo);
}

async function usageAuthError(supervisor, config) {
  try {
    if (config.kind === "claude-oauth-usage") {
      await readClaudeOauthCredentials();
      return "";
    }
    if (config.kind === "gemini-code-assist-quota") {
      const { credentials } = await readGeminiOauthCredentials();
      return credentials.access_token || credentials.refresh_token
        ? ""
        : "Gemini auth not connected; skipping usage probe";
    }
    if (config.kind === "codex-app-server") {
      if (process.env.OPENAI_API_KEY || process.env.CODEX_ACCESS_TOKEN) return "";
      const connected = await hasAuthFile(path.join(paths.homeDir, ".codex"), [
        "auth.json",
        "credentials.json",
        "session.json",
      ]);
      return connected ? "" : "Codex auth not connected; skipping usage probe";
    }
    return "";
  } catch {
    return `${supervisors[supervisor]?.label || supervisor} auth not connected; skipping usage probe`;
  }
}

export async function recordRunStart(supervisor) {
  if (!supervisors[supervisor]) return;
  return withUsageLock(async () => {
    const store = await readStore();
    const model = store.models[supervisor];
    model.totalRuns += 1;
    model.active = true;
    model.activeRunTokens = 0;
    model.activeRunCostUsd = 0;
    model.lastStartedAt = new Date().toISOString();
    model.lastError = "";
    daily(model).runs += 1;
    await writeStore(store);
  });
}

export async function recordRunEnd(supervisor, { error = "", stopped = false } = {}) {
  if (!supervisors[supervisor]) return;
  return withUsageLock(async () => {
    const store = await readStore();
    const model = store.models[supervisor];
    model.active = false;
    model.activeRunTokens = 0;
    model.activeRunCostUsd = 0;
    model.lastFinishedAt = new Date().toISOString();
    model.lastError = stopped ? "Stopped" : String(error || "");
    await writeStore(store);
  });
}

export async function recordUsageSignal(supervisor, signal = {}) {
  if (!supervisors[supervisor]) return;
  return withUsageLock(async () => {
    const store = await readStore();
    const model = store.models[supervisor];
    const percent = clampPercent(signal.percent);
    const currentPercent = clampPercent(signal.currentPercent);
    const weeklyPercent = clampPercent(signal.weeklyPercent);
    const sonnetWeeklyPercent = clampPercent(signal.sonnetWeeklyPercent);
    const tokens = numberOrNull(signal.tokens);
    const costUsd = numberOrNull(signal.costUsd);
    if ((tokens !== null || costUsd !== null) && !model.active) return;
    if (percent !== null) {
      model.lastKnownPercent = percent;
      model.lastKnownLabel = String(signal.label || signal.type || "provider signal");
      model.lastKnownAt = new Date().toISOString();
    }
    if (currentPercent !== null) model.currentPercent = currentPercent;
    if (weeklyPercent !== null) model.weeklyPercent = weeklyPercent;
    if (sonnetWeeklyPercent !== null) model.sonnetWeeklyPercent = sonnetWeeklyPercent;
    addUsageDeltas(model, { tokens, costUsd });
    await writeStore(store);
  });
}

async function recordProbeResult(supervisor, signal = {}) {
  if (!supervisors[supervisor]) return;
  if (signal.probeVersion && signal.probeVersion !== usageProbeVersions.get(supervisor)) return;
  return withUsageLock(async () => {
    const store = await readStore();
    const model = store.models[supervisor];
    const percent = clampPercent(signal.percent);
    const currentPercent = clampPercent(signal.currentPercent);
    const weeklyPercent = clampPercent(signal.weeklyPercent);
    const sonnetWeeklyPercent = clampPercent(signal.sonnetWeeklyPercent);
    const tokens = numberOrNull(signal.tokens);
    const now = new Date().toISOString();

    model.lastProbeAt = now;
    model.lastProbeError = String(signal.error || "");
    model.lastProbeOutput = String(signal.output || "").slice(0, PROBE_OUTPUT_LIMIT);
    model.lastProbeCommand = String(signal.command || "");

    if (percent !== null) {
      model.lastKnownPercent = percent;
      model.lastKnownLabel = String(signal.label || signal.type || "provider status");
      model.lastKnownAt = now;
      model.currentPercent = currentPercent;
      model.weeklyPercent = weeklyPercent;
      model.sonnetWeeklyPercent = sonnetWeeklyPercent;
    } else if (!signal.error || signal.clearKnown) {
      model.lastKnownPercent = null;
      model.lastKnownLabel = "";
      model.lastKnownAt = "";
      model.currentPercent = null;
      model.weeklyPercent = null;
      model.sonnetWeeklyPercent = null;
    }
    if (tokens !== null) model.lastTokens = Math.max(0, Math.round(tokens));

    if (signal.mode === "balance") {
      const { observedMax, remaining, spent, usagePercent } = calculateBalanceUsage(
        model.balanceObservedMax,
        signal.balanceTotal,
      );
      addDeepSeekBalanceCost(model, spent);

      model.balanceAvailable = Boolean(signal.balanceAvailable);
      model.balanceLabel = String(signal.balanceLabel || "");
      model.balanceCurrency = String(signal.balanceCurrency || "");
      model.balanceTotal = String(signal.balanceTotal || "");
      model.balanceGranted = String(signal.balanceGranted || "");
      model.balanceToppedUp = String(signal.balanceToppedUp || "");
      model.balanceUpdatedAt = signal.balanceUpdatedAt || now;
      model.balanceError = "";
      model.balanceObservedMax = observedMax;
      model.balanceRemaining = remaining;
      model.balanceSpent = spent;
      model.balanceUsagePercent = usagePercent;
    } else if (supervisor === "deepseek" && signal.clearBalance) {
      model.balanceAvailable = null;
      model.balanceLabel = "";
      model.balanceCurrency = "";
      model.balanceTotal = "";
      model.balanceGranted = "";
      model.balanceToppedUp = "";
      model.balanceUpdatedAt = "";
      model.balanceObservedMax = null;
      model.balanceRemaining = null;
      model.balanceSpent = null;
      model.balanceUsagePercent = null;
      model.balanceError = String(signal.balanceError || "");
    } else if (supervisor === "deepseek" && signal.balanceError) {
      model.balanceError = String(signal.balanceError || "");
      model.balanceUpdatedAt = signal.balanceUpdatedAt || now;
    }
    await writeStore(store);
  });
}

async function modelActive(supervisor) {
  const store = await readStore();
  return Boolean(store.models[supervisor]?.active);
}

async function probeCliUsage(supervisor, config, { probeVersion } = {}) {
  if (await modelActive(supervisor)) return;
  const command = config.displayCommand || config.command;
  const authError = await usageAuthError(supervisor, config);
  if (authError) {
    await recordProbeResult(supervisor, {
      probeVersion,
      percent: null,
      currentPercent: null,
      weeklyPercent: null,
      output: "",
      label: "",
      error: authError,
      clearKnown: true,
      command,
    });
    return;
  }
  let result;
  try {
    result = config.kind === "codex-app-server"
      ? await runCodexAppServerProbe(config)
      : config.kind === "claude-oauth-usage"
        ? await probeClaudeOauthUsage(config)
        : config.kind === "gemini-code-assist-quota"
          ? await probeGeminiCodeAssistQuota(config)
          : await runShellProbe(config);
  } catch (error) {
    result = {
      percent: null,
      currentPercent: null,
      weeklyPercent: null,
      output: "",
      label: "",
      error: error.message || String(error),
    };
  }
  await recordProbeResult(supervisor, {
    ...result,
    probeVersion,
    command,
  });
}

async function probeDeepSeekUsage({ probeVersion } = {}) {
  const balance = await fetchDeepSeekBalance();
  if (!balance) return;
  await recordProbeResult("deepseek", {
    ...balance,
    probeVersion,
    command: "GET /user/balance",
    label: balance.balanceLabel ? `DeepSeek balance ${balance.balanceLabel}` : "DeepSeek balance",
    output: balance.balanceError || `${balance.balanceAvailable ? "available" : "unavailable"} ${balance.balanceLabel || ""}`.trim(),
    error: balance.balanceError || "",
  });
}

export async function refreshUsageSnapshots() {
  if (usagePollInFlight) return usagePollInFlight;
  usagePollInFlight = (async () => {
    const tasks = [...Object.keys(cliProbeConfigs), "deepseek"].map((supervisor) => refreshUsageSnapshot(supervisor));
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === "rejected") console.error("[usage] probe failed:", result.reason?.message || result.reason);
    }
  })();
  try {
    await usagePollInFlight;
  } finally {
    usagePollInFlight = null;
  }
}

export function refreshUsageSnapshot(supervisor, { force = false } = {}) {
  if (!supervisors[supervisor]) return Promise.resolve();
  if (!force && usageProbeInFlight.has(supervisor)) return usageProbeInFlight.get(supervisor);
  const probeVersion = (usageProbeVersions.get(supervisor) || 0) + 1;
  usageProbeVersions.set(supervisor, probeVersion);

  const probe = async () => {
    if (supervisor === "deepseek") {
      await probeDeepSeekUsage({ probeVersion });
      return;
    }
    const config = cliProbeConfigs[supervisor];
    if (config) await probeCliUsage(supervisor, config, { probeVersion });
  };
  const run = probe().finally(() => usageProbeInFlight.delete(supervisor));
  usageProbeInFlight.set(supervisor, run);
  return run;
}

export function startUsagePolling() {
  if (usagePollTimer || runtime.usagePollIntervalMs <= 0) return;
  const run = () => {
    refreshUsageSnapshots().catch((error) => {
      console.error("[usage] refresh failed:", error.message || error);
    });
  };
  setTimeout(run, 5000).unref();
  usagePollTimer = setInterval(run, runtime.usagePollIntervalMs);
  usagePollTimer.unref();
  console.log(`[usage] background probes every ${runtime.usagePollIntervalMs}ms`);
}

export async function listUsage() {
  const store = await readStore();
  const today = todayKey();
  return Object.keys(supervisors).map((id) => {
    const model = store.models[id] || defaultModelUsage(id);
    const runsToday = model.days?.[today]?.runs || 0;
    const hasKnownPercent = Number.isFinite(model.lastKnownPercent);
    const hasBalance = model.balanceAvailable !== null && model.balanceUpdatedAt;
    const balanceUsagePercent = Number.isFinite(model.balanceUsagePercent) ? model.balanceUsagePercent : null;
    const todayUsage = normalizeDay(model.days?.[today]);
    const totalCostUsd = Number.isFinite(model.totalCostUsd) ? model.totalCostUsd : 0;
    const budgetWarning = runtime.budgetWarningUsd > 0 && totalCostUsd >= runtime.budgetWarningUsd;
    return {
      id,
      label: supervisors[id].label,
      percent: hasKnownPercent ? model.lastKnownPercent : hasBalance ? balanceUsagePercent : null,
      mode: hasKnownPercent ? "provider" : hasBalance ? "balance" : "unknown",
      active: Boolean(model.active),
      runsToday,
      totalRuns: model.totalRuns || 0,
      tokensToday: todayUsage.tokens,
      totalTokens: Number.isFinite(model.totalTokens) ? model.totalTokens : 0,
      costTodayUsd: todayUsage.costUsd,
      totalCostUsd,
      budgetWarning,
      budgetWarningUsd: runtime.budgetWarningUsd > 0 ? runtime.budgetWarningUsd : null,
      lastStartedAt: model.lastStartedAt || "",
      lastFinishedAt: model.lastFinishedAt || "",
      lastError: model.lastError || "",
      lastKnownLabel: model.lastKnownLabel || "",
      lastKnownAt: model.lastKnownAt || "",
      currentPercent: Number.isFinite(model.currentPercent) ? model.currentPercent : null,
      weeklyPercent: Number.isFinite(model.weeklyPercent) ? model.weeklyPercent : null,
      sonnetWeeklyPercent: Number.isFinite(model.sonnetWeeklyPercent) ? model.sonnetWeeklyPercent : null,
      lastTokens: Number.isFinite(model.lastTokens) && model.lastTokens > 0 ? model.lastTokens : null,
      lastCostUsd: Number.isFinite(model.lastCostUsd) ? model.lastCostUsd : null,
      lastProbeAt: model.lastProbeAt || "",
      lastProbeError: model.lastProbeError || "",
      lastProbeOutput: model.lastProbeOutput || "",
      lastProbeCommand: model.lastProbeCommand || "",
      balanceAvailable: model.balanceAvailable,
      balanceLabel: model.balanceLabel || "",
      balanceCurrency: model.balanceCurrency || "",
      balanceTotal: model.balanceTotal || "",
      balanceGranted: model.balanceGranted || "",
      balanceToppedUp: model.balanceToppedUp || "",
      balanceUpdatedAt: model.balanceUpdatedAt || "",
      balanceError: model.balanceError || "",
      balanceObservedMax: Number.isFinite(model.balanceObservedMax) ? model.balanceObservedMax : null,
      balanceRemaining: Number.isFinite(model.balanceRemaining) ? model.balanceRemaining : null,
      balanceSpent: Number.isFinite(model.balanceSpent) ? model.balanceSpent : null,
      balanceUsagePercent,
    };
  });
}

export function summarizeUsageBudget(usage) {
  const totalCostUsd = usage.reduce((total, item) => total + (numberOrNull(item.totalCostUsd) ?? 0), 0);
  const todayCostUsd = usage.reduce((total, item) => total + (numberOrNull(item.costTodayUsd) ?? 0), 0);
  const warningUsd = runtime.budgetWarningUsd > 0 ? runtime.budgetWarningUsd : null;
  return {
    totalCostUsd,
    todayCostUsd,
    warningUsd,
    warning: warningUsd !== null && totalCostUsd >= warningUsd,
  };
}

export async function usageSnapshot() {
  const usage = await listUsage();
  return { usage, budget: summarizeUsageBudget(usage) };
}
