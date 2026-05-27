import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = path.resolve(srcRoot, "..");

function envFlag(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function envNumber(name, defaultValue) {
  const value = Number(process.env[name] || defaultValue);
  return Number.isFinite(value) ? value : defaultValue;
}

function envList(name, defaultValue = "") {
  return String(process.env[name] ?? defaultValue)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export const paths = {
  appRoot,
  srcRoot,
  publicRoot: path.join(appRoot, "public"),
  workspaceRoot: path.resolve(process.env.ORCH_WORKSPACE_ROOT || "/workspace"),
  dataDir: path.resolve(process.env.ORCH_DATA_DIR || "/data"),
  secretsDir: path.join(path.resolve(process.env.ORCH_DATA_DIR || "/data"), "secrets"),
  promptFile: process.env.ORCH_PROMPT_FILE || path.join(appRoot, "prompts", "main-orchestrator.md"),
  promptDir: process.env.ORCH_PROMPTS_DIR || path.join(path.resolve(process.env.ORCH_DATA_DIR || "/data"), "prompts"),
  mcpConfigDir: process.env.ORCH_MCP_CONFIG_DIR || "/data/orch-mcp",
  palServerFile: path.join(appRoot, "pal-mcp-server", "server.py"),
  palServerRoot: path.join(appRoot, "pal-mcp-server"),
  deepseekModelsFile: path.join(appRoot, "pal-config", "custom_models_deepseek.json"),
  homeDir: process.env.HOME || "/home/node",
};

function readSecret(name) {
  try {
    return readFileSync(path.join(paths.secretsDir, name), "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error; // fail closed: an unreadable secret must not silently disable auth
  }
}

// Like readSecret but fails closed when the file exists yet is empty (a misconfigured password must
// not silently disable auth).
function readAuthPasswordSecret() {
  let raw;
  try {
    raw = readFileSync(path.join(paths.secretsDir, "auth-password"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
  const value = raw.trim();
  if (!value) throw new Error("auth-password secret file exists but is empty");
  return value;
}

export const runtime = {
  port: envNumber("ORCH_UI_PORT", 8787),
  listenHost: process.env.ORCH_LISTEN_HOST || "::",
  defaultSupervisor: process.env.ORCH_DEFAULT_SUPERVISOR || "claude",
  allowWrite: envFlag("ORCH_ALLOW_WRITE", false),
  allowWorkspaceRoot: envFlag("ORCH_ALLOW_WORKSPACE_ROOT", false),
  timeoutMs: envNumber("ORCH_TIMEOUT_MS", 10800000), // 3h; 0 = no auto-timeout (stop manually)
  autopilotIdleTimeoutMs: envNumber("ORCH_AUTOPILOT_IDLE_TIMEOUT_MS", 900000), // 15m; 0 = disabled
  autopilotIdleWarningMs: envNumber("ORCH_AUTOPILOT_IDLE_WARNING_MS", 60000), // warn 1m before stop
  autopilotRetryAttempts: envNumber("ORCH_AUTOPILOT_RETRY_ATTEMPTS", 3),
  autopilotRetryBackoffMs: envNumber("ORCH_AUTOPILOT_RETRY_BACKOFF_MS", 2000),
  usagePollIntervalMs: envNumber("ORCH_USAGE_POLL_INTERVAL_MS", 300000), // 5m; 0 = disabled
  budgetWarningUsd: envNumber("ORCH_BUDGET_WARNING_USD", envNumber("ORCH_BUDGET_USD", 0)),
  maxUploadBytes: envNumber("ORCH_UPLOAD_MAX_BYTES", 25 * 1024 * 1024),
  maxInlineAttachmentChars: envNumber("ORCH_UPLOAD_INLINE_CHARS", 60000),
  networkMode: process.env.ORCH_NETWORK_MODE || "bridge",
  devServerHost: process.env.ORCH_DEV_SERVER_HOST || "0.0.0.0",
  previewPorts: process.env.ORCH_PREVIEW_PORTS || "3000-3020,5173-5190,8000-8020,8080-8090",
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || readSecret("deepseek-api-key"),
  pathEnv: process.env.PATH || "/home/node/.local/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin",
  authUser: process.env.ORCH_AUTH_USER || "orchestrator",
  authPassword: process.env.ORCH_AUTH_PASSWORD || readAuthPasswordSecret(),
  bindHost: process.env.ORCH_BIND_HOST || "",
  allowedHosts: envList("ORCH_ALLOWED_HOSTS"),
  enabledTools: envList("ORCH_ENABLED_TOOLS", "serena,context7,memory"),
  gitInitProjects: envFlag("ORCH_GIT_INIT_PROJECTS", true),
};

runtime.maxPayloadBytes = Math.ceil(runtime.maxUploadBytes * 1.5) + 1024 * 1024;

export const supervisors = {
  claude: {
    id: "claude",
    label: "Claude CLI",
    description: "Claude Code supervisor with the shared orchestrator prompt.",
  },
  codex: {
    id: "codex",
    label: "Codex CLI",
    description: "Codex CLI supervisor for implementation, debugging, and reviews.",
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    description: "Gemini CLI supervisor for broad context and architecture review.",
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek V4 Pro",
    description: "Direct DeepSeek API supervisor using deepseek-v4-pro.",
  },
};

if (!supervisors[runtime.defaultSupervisor]) runtime.defaultSupervisor = "claude";

export const sourcePromptFiles = {
  claude: path.join(appRoot, "prompts", "Claude.md"),
  codex: path.join(appRoot, "prompts", "Codex.md"),
  gemini: path.join(appRoot, "prompts", "Gemini.md"),
  deepseek: path.join(appRoot, "prompts", "DeepSeek.md"),
};

export const supervisorPeers = {
  claude: ["codex", "gemini", "deepseek"],
  codex: ["claude", "gemini", "deepseek"],
  gemini: ["claude", "codex", "deepseek"],
  deepseek: ["claude", "codex", "gemini"],
};

const workflowTools = [
  "thinkdeep",
  "planner",
  "consensus",
  "codereview",
  "precommit",
  "debug",
  "secaudit",
  "docgen",
  "analyze",
  "refactor",
  "tracer",
  "testgen",
  "challenge",
  "apilookup",
].join(",");

export const disabledTools = {
  cliPeer: `chat,${workflowTools}`,
  deepseekPeer: `clink,${workflowTools}`,
};
