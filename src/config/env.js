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
  } catch {
    return "";
  }
}

export const runtime = {
  port: envNumber("ORCH_UI_PORT", 8787),
  listenHost: process.env.ORCH_LISTEN_HOST || "::",
  defaultSupervisor: process.env.ORCH_DEFAULT_SUPERVISOR || "claude",
  allowWrite: envFlag("ORCH_ALLOW_WRITE", false),
  allowWorkspaceRoot: envFlag("ORCH_ALLOW_WORKSPACE_ROOT", false),
  timeoutMs: envNumber("ORCH_TIMEOUT_MS", 900000),
  maxUploadBytes: envNumber("ORCH_UPLOAD_MAX_BYTES", 25 * 1024 * 1024),
  maxInlineAttachmentChars: envNumber("ORCH_UPLOAD_INLINE_CHARS", 60000),
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || readSecret("deepseek-api-key"),
  pathEnv: process.env.PATH || "/home/node/.local/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin",
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
