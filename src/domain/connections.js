import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths, runtime, supervisors } from "../config/env.js";
import { writeStartupPeerConfigs } from "../supervisors/mcp.js";

const MAX_OUTPUT_CHARS = 80000;
const JOB_TTL_MS = 15 * 60 * 1000;

const cliConnectors = {
  claude: {
    id: "claude",
    label: "Claude CLI",
    args: ["auth", "login", "--claudeai"],
    detail: "Uses the Claude auth volume in this app.",
  },
  codex: {
    id: "codex",
    label: "Codex CLI",
    args: ["login", "--device-auth"],
    detail: "Uses the Codex auth volume in this app.",
    links: [
      {
        label: "Open ChatGPT Security",
        url: "https://chatgpt.com/#settings/Security",
      },
    ],
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    command: "script",
    args: ["-qfec", "gemini --skip-trust", "/dev/null"],
    detail: "Uses the Gemini auth volume in this app.",
    env: { GEMINI_CLI_TRUST_WORKSPACE: "true", NO_BROWSER: "1" },
    beforeStart: writeGeminiOAuthSettings,
    successPattern: /Signed in with Google/i,
    successOutput: "Gemini login successful.",
  },
};

const jobs = new Map();

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

function setNested(object, keys, value) {
  let cursor = object;
  for (const key of keys.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== "object" || Array.isArray(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys.at(-1)] = value;
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

async function writeGeminiOAuthSettings() {
  const geminiDir = path.join(paths.homeDir, ".gemini");
  await mkdir(geminiDir, { recursive: true });
  const settingsPath = path.join(geminiDir, "settings.json");
  const settings = await readJsonFile(settingsPath);
  setNested(settings, ["security", "auth", "selectedType"], "oauth-personal");
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function runStatusCommand(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000 }, (error, stdout = "", stderr = "") => {
      resolve({ ok: !error, stdout, stderr });
    });
  });
}

async function isClaudeConnected() {
  if (process.env.ANTHROPIC_API_KEY) return true;
  const result = await runStatusCommand("claude", ["auth", "status"]);
  try {
    return Boolean(JSON.parse(result.stdout).loggedIn);
  } catch {
    return false;
  }
}

async function isCodexConnected(codexDir) {
  if (process.env.OPENAI_API_KEY || process.env.CODEX_ACCESS_TOKEN) return true;
  if (await hasAuthFile(codexDir, ["auth.json", "credentials.json", "session.json"])) return true;
  const result = await runStatusCommand("codex", ["login", "status"]);
  return result.ok && !/not logged in/i.test(`${result.stdout}\n${result.stderr}`);
}

function stripAnsi(text) {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[PX^_].*?\u001B\\/gs, "");
}

function appendJobOutput(job, stream, chunk) {
  const text = stripAnsi(chunk.toString("utf8"));
  if (!text) return;
  if (job.status !== "running") return;
  job.output = `${job.output}${text}`;
  if (job.output.length > MAX_OUTPUT_CHARS) job.output = job.output.slice(-MAX_OUTPUT_CHARS);
  job.updatedAt = new Date().toISOString();
  job.stream = stream;
  if (job.successPattern?.test(job.output)) {
    job.status = "done";
    job.exitCode = 0;
    job.output = job.successOutput || job.output;
    job.child?.stdin?.write("/quit\n");
    setTimeout(() => job.child?.kill("SIGTERM"), 1200).unref();
  }
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    connectionId: job.connectionId,
    label: job.label,
    status: job.status,
    output: job.output,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    exitCode: job.exitCode,
    error: job.error,
  };
}

function latestJobFor(connectionId) {
  let latest = null;
  for (const job of jobs.values()) {
    if (job.connectionId !== connectionId) continue;
    if (!latest || new Date(job.startedAt) > new Date(latest.startedAt)) latest = job;
  }
  return publicJob(latest);
}

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (job.status === "running") continue;
    if (now - Date.parse(job.updatedAt || job.startedAt) > JOB_TTL_MS) jobs.delete(id);
  }
}

function runningJobFor(connectionId) {
  for (const job of jobs.values()) {
    if (job.connectionId === connectionId && job.status === "running") return job;
  }
  return null;
}

function clearJobsFor(connectionId) {
  for (const [id, job] of jobs.entries()) {
    if (job.connectionId !== connectionId) continue;
    if (job.status === "running") {
      job.child?.kill("SIGTERM");
      job.status = "cancelled";
      job.updatedAt = new Date().toISOString();
    }
    jobs.delete(id);
  }
}

async function resetDirectory(dir) {
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(entries.map((entry) => rm(path.join(dir, entry.name), { recursive: true, force: true })));
}

async function saveDeepSeekKey(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) throw Object.assign(new Error("DeepSeek API key is required"), { status: 400 });
  await mkdir(paths.secretsDir, { recursive: true });
  const filePath = path.join(paths.secretsDir, "deepseek-api-key");
  await writeFile(filePath, `${key}\n`, { encoding: "utf8", mode: 0o600 });
  process.env.DEEPSEEK_API_KEY = key;
  runtime.deepseekApiKey = key;
  return {
    id: "deepseek",
    label: "DeepSeek V4 Pro",
    connected: true,
    action: "api-key",
    detail: "API key saved in this app data volume.",
  };
}

async function removeDeepSeekKey() {
  await rm(path.join(paths.secretsDir, "deepseek-api-key"), { force: true });
  process.env.DEEPSEEK_API_KEY = "";
  runtime.deepseekApiKey = "";
}

async function isGeminiConnected(geminiDir) {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) || await hasAuthFile(geminiDir, [
    "oauth_creds.json",
    "credentials.json",
    "auth.json",
  ]);
}

export async function connectionStatus() {
  pruneJobs();
  const codexDir = path.join(paths.homeDir, ".codex");
  const geminiDir = path.join(paths.homeDir, ".gemini");

  const claudeConnected = await isClaudeConnected();
  const codexConnected = await isCodexConnected(codexDir);
  const geminiConnected = await isGeminiConnected(geminiDir);

  return [
    {
      id: "claude",
      label: cliConnectors.claude.label,
      connected: claudeConnected,
      action: "login",
      detail: cliConnectors.claude.detail,
      job: latestJobFor("claude"),
    },
    {
      id: "codex",
      label: cliConnectors.codex.label,
      connected: codexConnected,
      action: "login",
      detail: cliConnectors.codex.detail,
      links: cliConnectors.codex.links,
      job: latestJobFor("codex"),
    },
    {
      id: "gemini",
      label: cliConnectors.gemini.label,
      connected: geminiConnected,
      action: "login",
      detail: cliConnectors.gemini.detail,
      job: latestJobFor("gemini"),
    },
    {
      id: "deepseek",
      label: "DeepSeek V4 Pro",
      connected: Boolean(runtime.deepseekApiKey),
      action: "api-key",
      detail: runtime.deepseekApiKey ? "API key is saved." : "API key can be saved here.",
      job: null,
    },
  ];
}

export async function requireConnectedSupervisor(id) {
  const supervisor = supervisors[id] ? id : runtime.defaultSupervisor;
  const connections = await connectionStatus();
  const connection = connections.find((item) => item.id === supervisor);
  if (!connection?.connected) {
    const label = supervisors[supervisor]?.label || supervisor;
    throw Object.assign(new Error(`${label} is not connected. Connect it before starting a chat.`), { status: 409 });
  }
  return supervisor;
}

export async function startConnection(id, body = {}) {
  if (id === "deepseek") return { connection: await saveDeepSeekKey(body.apiKey) };
  const connector = cliConnectors[id];
  if (!connector) throw Object.assign(new Error("Unknown connection"), { status: 404 });

  const existing = runningJobFor(id);
  if (existing) return { job: publicJob(existing) };

  await connector.beforeStart?.();

  const now = new Date().toISOString();
  const job = {
    id: randomUUID(),
    connectionId: id,
    label: connector.label,
    status: "running",
    output: "",
    startedAt: now,
    updatedAt: now,
    exitCode: null,
    error: "",
    successPattern: connector.successPattern,
    successOutput: connector.successOutput,
    child: null,
  };
  jobs.set(job.id, job);

  const child = spawn(connector.command || id, connector.args, {
    cwd: paths.workspaceRoot,
    env: { ...process.env, ...(connector.env || {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  job.child = child;

  child.stdout.on("data", (chunk) => appendJobOutput(job, "stdout", chunk));
  child.stderr.on("data", (chunk) => appendJobOutput(job, "stderr", chunk));
  child.on("error", (error) => {
    job.status = "failed";
    job.error = error.message;
    appendJobOutput(job, "stderr", `\n${error.message}\n`);
    job.child = null;
  });
  child.on("close", (code) => {
    job.exitCode = code;
    if (!["done", "cancelled"].includes(job.status)) job.status = code === 0 ? "done" : "failed";
    if (job.status === "done" && job.exitCode === null) job.exitCode = 0;
    job.updatedAt = new Date().toISOString();
    job.child = null;
  });

  return { job: publicJob(job) };
}

export async function disconnectConnection(id) {
  clearJobsFor(id);

  if (id === "deepseek") {
    await removeDeepSeekKey();
    return { disconnected: true, connections: await connectionStatus() };
  }
  if (!cliConnectors[id]) throw Object.assign(new Error("Unknown connection"), { status: 404 });

  const authDirs = {
    claude: path.join(paths.homeDir, ".claude"),
    codex: path.join(paths.homeDir, ".codex"),
    gemini: path.join(paths.homeDir, ".gemini"),
  };
  await resetDirectory(authDirs[id]);
  await writeStartupPeerConfigs();

  return { disconnected: true, connections: await connectionStatus() };
}

export function getConnectionJob(id) {
  const job = jobs.get(id);
  if (!job) throw Object.assign(new Error("Connection job not found"), { status: 404 });
  return publicJob(job);
}

export function sendConnectionJobInput(id, input) {
  const job = jobs.get(id);
  if (!job) throw Object.assign(new Error("Connection job not found"), { status: 404 });
  if (job.status !== "running" || !job.child?.stdin?.writable) {
    throw Object.assign(new Error("Connection job is not accepting input"), { status: 409 });
  }
  const text = String(input || "");
  if (!text) throw Object.assign(new Error("Input is required"), { status: 400 });
  job.child.stdin.write(text.endsWith("\n") ? text : `${text}\n`);
  appendJobOutput(job, "stdin", "\n[input sent]\n");
  return publicJob(job);
}
