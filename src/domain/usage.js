import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { paths, runtime, supervisors } from "../config/env.js";

const usageFile = path.join(paths.dataDir, "usage.json");
const DEEPSEEK_BALANCE_TTL_MS = 60_000;
const PROBE_OUTPUT_LIMIT = 5000;
let usageLock = Promise.resolve();
let deepSeekBalanceCache = { at: 0, promise: null, result: null };
let usagePollTimer = null;
let usagePollInFlight = null;

const cliProbeConfigs = {
  claude: {
    command: "claude",
    slashCommand: "/usage",
    timeoutMs: 25_000,
  },
  codex: {
    command: "codex",
    slashCommand: "/status",
    timeoutMs: 25_000,
  },
  gemini: {
    command: "gemini --skip-trust",
    slashCommand: "/stats",
    timeoutMs: 25_000,
    env: { GEMINI_CLI_TRUST_WORKSPACE: "true", NO_BROWSER: "1" },
  },
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function defaultModelUsage(id) {
  return {
    id,
    totalRuns: 0,
    active: false,
    lastStartedAt: "",
    lastFinishedAt: "",
    lastError: "",
    lastKnownPercent: null,
    lastKnownLabel: "",
    lastKnownAt: "",
    currentPercent: null,
    weeklyPercent: null,
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
    days: {},
  };
}

function normalizeStore(raw = {}) {
  const models = raw.models && typeof raw.models === "object" ? raw.models : {};
  for (const id of Object.keys(supervisors)) {
    models[id] = { ...defaultModelUsage(id), ...(models[id] || {}) };
    models[id].days = models[id].days && typeof models[id].days === "object" ? models[id].days : {};
  }
  return { schemaVersion: 1, models };
}

async function readStore() {
  try {
    return normalizeStore(JSON.parse(await readFile(usageFile, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return normalizeStore();
    throw error;
  }
}

async function writeStore(store) {
  await mkdir(path.dirname(usageFile), { recursive: true });
  await writeFile(usageFile, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function withUsageLock(task) {
  const run = usageLock.catch(() => {}).then(task);
  usageLock = run.catch(() => {});
  return run;
}

function daily(model) {
  const key = todayKey();
  model.days[key] ||= { runs: 0 };
  return model.days[key];
}

function clampPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
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

export function parseUsageProbeOutput(output) {
  const clean = redactProbeText(output);
  const percentages = [];
  for (const line of clean.split("\n")) {
    if (!/usage|limit|remaining|reset|quota|capacity|rate|current|session|today|daily|week|weekly|7d/i.test(line)) continue;
    for (const match of line.matchAll(/\b(\d{1,3})\s*%/g)) {
      const percent = clampPercent(match[1]);
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

async function fetchDeepSeekBalance() {
  if (!runtime.deepseekApiKey) return null;
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

function runCliProbe({ command, slashCommand, timeoutMs = 25_000, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn("script", ["-qfec", command, "/dev/null"], {
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
      clearTimeout(sendSlash);
      clearTimeout(sendQuit);
      clearTimeout(closeInput);
      resolve({ ...parseUsageProbeOutput(output), error });
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
      finish("usage probe timed out");
    }, timeoutMs);
    const sendSlash = setTimeout(() => {
      if (child.stdin.writable) child.stdin.write(`${slashCommand}\n`);
    }, 3000);
    const sendQuit = setTimeout(() => {
      if (child.stdin.writable) child.stdin.write("/quit\n");
    }, 9000);
    const closeInput = setTimeout(() => {
      if (child.stdin.writable) child.stdin.end();
    }, 12_000);

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.stdin.on("error", () => {});
    child.on("error", (error) => finish(error.message || String(error)));
    child.on("close", (code) => finish(code ? `usage probe exited ${code}` : ""));
  });
}

export async function recordRunStart(supervisor) {
  if (!supervisors[supervisor]) return;
  return withUsageLock(async () => {
    const store = await readStore();
    const model = store.models[supervisor];
    model.totalRuns += 1;
    model.active = true;
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
    const tokens = Number(signal.tokens);
    const costUsd = Number(signal.costUsd);
    if (percent !== null) {
      model.lastKnownPercent = percent;
      model.lastKnownLabel = String(signal.label || signal.type || "provider signal");
      model.lastKnownAt = new Date().toISOString();
    }
    if (currentPercent !== null) model.currentPercent = currentPercent;
    if (weeklyPercent !== null) model.weeklyPercent = weeklyPercent;
    if (Number.isFinite(tokens)) model.lastTokens = Math.max(0, Math.round(tokens));
    if (Number.isFinite(costUsd)) model.lastCostUsd = costUsd;
    await writeStore(store);
  });
}

async function recordProbeResult(supervisor, signal = {}) {
  if (!supervisors[supervisor]) return;
  return withUsageLock(async () => {
    const store = await readStore();
    const model = store.models[supervisor];
    const percent = clampPercent(signal.percent);
    const currentPercent = clampPercent(signal.currentPercent);
    const weeklyPercent = clampPercent(signal.weeklyPercent);
    const tokens = Number(signal.tokens);
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
    } else {
      model.lastKnownPercent = null;
      model.lastKnownLabel = "";
      model.lastKnownAt = "";
      model.currentPercent = null;
      model.weeklyPercent = null;
    }
    if (Number.isFinite(tokens)) model.lastTokens = Math.max(0, Math.round(tokens));

    if (signal.mode === "balance") {
      model.balanceAvailable = Boolean(signal.balanceAvailable);
      model.balanceLabel = String(signal.balanceLabel || "");
      model.balanceCurrency = String(signal.balanceCurrency || "");
      model.balanceTotal = String(signal.balanceTotal || "");
      model.balanceGranted = String(signal.balanceGranted || "");
      model.balanceToppedUp = String(signal.balanceToppedUp || "");
      model.balanceUpdatedAt = signal.balanceUpdatedAt || now;
      model.balanceError = "";
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

async function probeCliUsage(supervisor, config) {
  if (await modelActive(supervisor)) return;
  const result = await runCliProbe(config);
  await recordProbeResult(supervisor, {
    ...result,
    command: config.slashCommand,
  });
}

async function probeDeepSeekUsage() {
  const balance = await fetchDeepSeekBalance();
  if (!balance) return;
  await recordProbeResult("deepseek", {
    ...balance,
    command: "GET /user/balance",
    label: balance.balanceLabel ? `DeepSeek balance ${balance.balanceLabel}` : "DeepSeek balance",
    output: balance.balanceError || `${balance.balanceAvailable ? "available" : "unavailable"} ${balance.balanceLabel || ""}`.trim(),
    error: balance.balanceError || "",
  });
}

export async function refreshUsageSnapshots() {
  if (usagePollInFlight) return usagePollInFlight;
  usagePollInFlight = (async () => {
    const tasks = [
      ...Object.entries(cliProbeConfigs).map(([supervisor, config]) => probeCliUsage(supervisor, config)),
      probeDeepSeekUsage(),
    ];
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
    return {
      id,
      label: supervisors[id].label,
      percent: hasKnownPercent ? model.lastKnownPercent : null,
      mode: hasKnownPercent ? "provider" : hasBalance ? "balance" : "unknown",
      active: Boolean(model.active),
      runsToday,
      totalRuns: model.totalRuns || 0,
      lastStartedAt: model.lastStartedAt || "",
      lastFinishedAt: model.lastFinishedAt || "",
      lastError: model.lastError || "",
      lastKnownLabel: model.lastKnownLabel || "",
      lastKnownAt: model.lastKnownAt || "",
      currentPercent: Number.isFinite(model.currentPercent) ? model.currentPercent : null,
      weeklyPercent: Number.isFinite(model.weeklyPercent) ? model.weeklyPercent : null,
      lastTokens: Number.isFinite(model.lastTokens) ? model.lastTokens : null,
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
    };
  });
}
