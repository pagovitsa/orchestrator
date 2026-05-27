import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths, supervisors } from "../config/env.js";

const usageFile = path.join(paths.dataDir, "usage.json");
let usageLock = Promise.resolve();

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
    lastTokens: null,
    lastCostUsd: null,
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
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
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
    const tokens = Number(signal.tokens);
    const costUsd = Number(signal.costUsd);
    if (percent !== null) {
      model.lastKnownPercent = percent;
      model.lastKnownLabel = String(signal.label || signal.type || "provider signal");
      model.lastKnownAt = new Date().toISOString();
    }
    if (Number.isFinite(tokens)) model.lastTokens = Math.max(0, Math.round(tokens));
    if (Number.isFinite(costUsd)) model.lastCostUsd = costUsd;
    await writeStore(store);
  });
}

export async function listUsage() {
  const store = await readStore();
  const today = todayKey();
  return Object.keys(supervisors).map((id) => {
    const model = store.models[id] || defaultModelUsage(id);
    const runsToday = model.days?.[today]?.runs || 0;
    const hasKnownPercent = Number.isFinite(model.lastKnownPercent);
    const observedPercent = Math.min(100, runsToday * 5);
    return {
      id,
      label: supervisors[id].label,
      percent: hasKnownPercent ? model.lastKnownPercent : observedPercent,
      mode: hasKnownPercent ? "provider" : "observed",
      active: Boolean(model.active),
      runsToday,
      totalRuns: model.totalRuns || 0,
      lastStartedAt: model.lastStartedAt || "",
      lastFinishedAt: model.lastFinishedAt || "",
      lastError: model.lastError || "",
      lastKnownLabel: model.lastKnownLabel || "",
      lastKnownAt: model.lastKnownAt || "",
      lastTokens: Number.isFinite(model.lastTokens) ? model.lastTokens : null,
      lastCostUsd: Number.isFinite(model.lastCostUsd) ? model.lastCostUsd : null,
    };
  });
}
