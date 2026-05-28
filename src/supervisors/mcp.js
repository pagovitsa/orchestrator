import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { disabledTools, paths, runtime, supervisorPeers, supervisors } from "../config/env.js";
import { tomlArray, tomlString } from "../utils/format.js";
import { githubSupervisorEnvSync } from "../domain/github.js";
import { requireScopedCwd } from "../domain/workspace.js";

const sharedToolCatalog = {
  serena: {
    group: "code-intel",
    namespace: "repo",
    label: "Serena code intelligence",
    description: "Project-aware code navigation and editing context.",
  },
  context7: {
    group: "docs",
    namespace: "docs",
    label: "Context7 docs",
    description: "Current library and framework documentation lookup.",
  },
  memory: {
    group: "memory",
    namespace: "memory",
    label: "Orch memory",
    description: "Durable user/global and project memory tools.",
  },
  playwright: {
    group: "browser",
    namespace: "browser",
    label: "Playwright browser",
    description: "Browser automation for UI verification.",
  },
  github: {
    group: "github",
    namespace: "github",
    label: "GitHub MCP",
    description: "Repos, issues, PRs, file ops, search — gated on a saved Personal Access Token.",
  },
};

export function mcpToolCatalog(supervisor, options = {}) {
  const peers = options.includePeerServers === false ? [] : (supervisorPeers[supervisor] || []).map((peer) => ({
    name: `pal-${peer}`,
    group: "peer-model",
    namespace: "pal",
    enabled: true,
    label: supervisors[peer]?.label || peer,
    description: `Peer delegate for ${peer}.`,
  }));
  const shared = options.includeSharedTools === false ? [] : Object.entries(sharedToolCatalog).map(([name, entry]) => ({
    name,
    ...entry,
    enabled: runtime.enabledTools.includes(name),
  }));
  return [...peers, ...shared];
}

function toolCatalogText(supervisor, options = {}) {
  const enabled = mcpToolCatalog(supervisor, options).filter((tool) => tool.enabled);
  const groups = new Map();
  for (const tool of enabled) {
    const names = groups.get(tool.group) || [];
    names.push(tool.name);
    groups.set(tool.group, names);
  }
  if (!groups.size) return "MCP tool groups enabled: (none).";
  return `MCP tool groups enabled: ${[...groups.entries()].map(([group, names]) => `${group}=${names.join(",")}`).join("; ")}.`;
}

export function peerRoutingText(supervisor, options = {}) {
  const peers = supervisorPeers[supervisor] || [];
  const palPeers = peers.map((peer) => `pal-${peer}`).join(", ") || "(none)";
  const cliPeers = peers.filter((peer) => peer !== "deepseek").join(", ") || "(none)";
  const peerLines = options.includePeerServers === false ? [
    `Peer delegates for ${supervisor} are disabled for this nested run.`,
    "Do not call model peers from this nested run; use only the prompt, shell, and enabled shared tools.",
  ] : [
    `Available peer delegates for ${supervisor}: ${peers.join(", ") || "(none)"}.`,
    `PAL MCP servers exposed to this supervisor: ${palPeers}.`,
    cliPeers === "(none)"
      ? "No CLI peer is exposed through clink for this supervisor."
      : `Use the matching PAL clink server for CLI peers only: ${cliPeers}.`,
    peers.includes("deepseek")
      ? "Use pal-deepseek chat/listmodels for DeepSeek V4 Pro API. The default model is deepseek-v4-pro."
      : "Do not call DeepSeek as a peer from this session.",
  ];
  return [
    ...peerLines,
    toolCatalogText(supervisor, options),
    "Do not delegate back to the active supervisor.",
  ].join("\n");
}

function basePalEnv(scopedCwd) {
  return {
    PATH: runtime.pathEnv,
    CUSTOM_API_URL: "https://api.deepseek.com/v1",
    CUSTOM_MODELS_CONFIG_PATH: paths.deepseekModelsFile,
    DEFAULT_MODEL: "deepseek-v4-pro",
    LOG_LEVEL: "INFO",
    ...(scopedCwd ? { ORCH_SCOPE_ROOT: scopedCwd } : {}),
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function peerServerConfig(peer, cwd, { scoped = true } = {}) {
  const env = basePalEnv(scoped ? cwd : "");
  if (peer === "deepseek") {
    env.DISABLED_TOOLS = disabledTools.deepseekPeer;
    env.ORCH_DEEPSEEK_KEY_FILE = path.join(paths.secretsDir, "deepseek-api-key");
    return {
      command: "bash",
      args: [
        "-lc",
        `CUSTOM_API_KEY="$(cat "$ORCH_DEEPSEEK_KEY_FILE" 2>/dev/null || true)"; export CUSTOM_API_KEY; exec python3 ${shellQuote(paths.palServerFile)}`,
      ],
      cwd,
      env,
    };
  } else {
    env.GEMINI_CLI_TRUST_WORKSPACE = "true";
    env.DISABLED_TOOLS = disabledTools.cliPeer;
    env.CLINK_ALLOWED_CLIENTS = peer;
  }
  return {
    command: "python3",
    args: [paths.palServerFile],
    cwd,
    env,
  };
}

export function mcpServersFor(supervisor, cwd, options = {}) {
  if (options.includePeerServers === false) return {};
  return Object.fromEntries((supervisorPeers[supervisor] || []).map((peer) => [`pal-${peer}`, peerServerConfig(peer, cwd, options)]));
}

function serenaContext(supervisor) {
  if (supervisor === "claude") return "claude-code";
  if (supervisor === "gemini") return "ide";
  return "codex";
}

function playwrightArgs() {
  const args = [];
  if (runtime.playwrightExecutablePath) args.push("--executable-path", runtime.playwrightExecutablePath);
  if (runtime.playwrightHeadless) args.push("--headless");
  if (runtime.playwrightNoSandbox) args.push("--no-sandbox");
  return args;
}

// Shared 3rd-party tool MCP servers (pre-installed + pinned in the image), gated by
// runtime.enabledTools. Kept separate from PAL peers: lower trust, network-reaching.
// Only injected into per-session scoped configs (not startup/auth configs), scoped to scopedCwd.
export function sharedToolServers(scopedCwd, supervisor) {
  const env = { PATH: runtime.pathEnv };
  const available = {
    serena: {
      command: "serena",
      args: ["start-mcp-server", "--project-from-cwd", "--context", serenaContext(supervisor)],
      cwd: scopedCwd,
      env,
    },
    context7: {
      command: "context7-mcp",
      args: ["--transport", "stdio"],
      cwd: scopedCwd,
      env,
    },
    memory: {
      command: "node",
      args: [path.join(paths.appRoot, "src", "mcp", "memory-server.js")],
      cwd: scopedCwd,
      env: {
        ...env,
        ORCH_MEMORY_GLOBAL_FILE: path.join(paths.dataDir, "orch-memory", "user.json"),
        ORCH_MEMORY_PROJECT_FILE: path.join(scopedCwd, ".remember", "orchestrator-memory.json"),
      },
    },
    playwright: {
      command: "playwright-mcp",
      args: playwrightArgs(),
      cwd: scopedCwd,
      env,
    },
  };
  // The official GitHub MCP server (`@modelcontextprotocol/server-github`) reads its credential
  // from `GITHUB_PERSONAL_ACCESS_TOKEN`. Map our stored token onto that env var and gate the
  // whole server on token presence — without it the child crashes on startup which would
  // surface as a noisy supervisor trace.
  const githubEnv = githubSupervisorEnvSync();
  if (githubEnv.GITHUB_TOKEN) {
    available.github = {
      command: "mcp-server-github",
      args: [],
      cwd: scopedCwd,
      env: { ...env, GITHUB_PERSONAL_ACCESS_TOKEN: githubEnv.GITHUB_TOKEN },
    };
  }
  return Object.fromEntries(
    runtime.enabledTools.filter((tool) => available[tool]).map((tool) => [tool, available[tool]]),
  );
}

export function codexProfileName(session) {
  return `orch-pal-${session.id}`;
}

export async function writeCodexProfile(filePath, servers, heading = "Generated by orch-ui for a scoped supervisor session.") {
  const lines = [`# ${heading}`, ""];
  for (const [name, server] of Object.entries(servers)) {
    lines.push(
      `[mcp_servers.${tomlString(name)}]`,
      `command = ${tomlString(server.command)}`,
      `args = ${tomlArray(server.args)}`,
      `cwd = ${tomlString(server.cwd)}`,
      "startup_timeout_sec = 120",
      "tool_timeout_sec = 7200",
      `[mcp_servers.${tomlString(name)}.env]`,
    );
    for (const [key, value] of Object.entries(server.env)) lines.push(`${key} = ${tomlString(value)}`);
    lines.push("");
  }
  await writeFile(filePath, lines.join("\n"), "utf8");
}

export async function writeScopedPeerConfigs(session, options = {}) {
  const scopedCwd = requireScopedCwd(session.cwd);
  const dir = path.join(paths.mcpConfigDir, "sessions", session.id);
  await mkdir(dir, { recursive: true });

  const servers = {
    ...(options.includePeerServers === false ? {} : mcpServersFor(session.supervisor, scopedCwd)),
    ...(options.includeSharedTools === false ? {} : sharedToolServers(scopedCwd, session.supervisor)),
  };
  const claudeConfigPath = path.join(dir, "claude.json");
  const geminiConfigPath = path.join(dir, "gemini-system-settings.json");
  const codexProfile = codexProfileName(session);
  const codexProfilePath = path.join(paths.codexHome, `${codexProfile}.config.toml`);

  // Gemini merges system settings with user/project servers; mcp.allowed restricts to ours,
  // and a per-server timeout covers MCP cold starts.
  const geminiServers = Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [name, { ...server, timeout: 60000 }]),
  );

  await mkdir(path.dirname(codexProfilePath), { recursive: true });
  await writeFile(claudeConfigPath, JSON.stringify({ mcpServers: servers }, null, 2), "utf8");
  await writeFile(
    geminiConfigPath,
    JSON.stringify({ mcpServers: geminiServers, mcp: { allowed: Object.keys(servers) } }, null, 2),
    "utf8",
  );
  await writeCodexProfile(codexProfilePath, servers);

  return { scopedCwd, claudeConfigPath, geminiConfigPath, codexProfile };
}

async function clearGeneratedPeerConfigs() {
  await rm(path.join(paths.mcpConfigDir, "sessions"), { recursive: true, force: true });
  const codexDir = paths.codexHome;
  const entries = await readdir(codexDir).catch(() => []);
  await Promise.all(entries
    .filter((name) => name.startsWith("orch-pal-") && name.endsWith(".config.toml"))
    .map((name) => rm(path.join(codexDir, name), { force: true })));
}

export async function writeStartupPeerConfigs() {
  await mkdir(path.join(paths.homeDir, ".claude"), { recursive: true });
  await mkdir(paths.codexHome, { recursive: true });
  await mkdir(path.join(paths.homeDir, ".gemini"), { recursive: true });
  await mkdir(paths.mcpConfigDir, { recursive: true });
  await clearGeneratedPeerConfigs();

  const globalCwd = paths.palServerRoot;
  const cliSupervisors = Object.keys(supervisors).filter((supervisor) => supervisor !== "deepseek");

  for (const supervisor of cliSupervisors) {
    const servers = mcpServersFor(supervisor, globalCwd, { scoped: false });
    if (supervisor === "claude") {
      const config = JSON.stringify({ mcpServers: servers }, null, 2);
      await writeFile(path.join(paths.mcpConfigDir, "claude.json"), config, "utf8");
      await writeFile(path.join(paths.homeDir, ".claude.json"), config, "utf8");
    }
    if (supervisor === "codex") {
      await writeCodexProfile(
        path.join(paths.codexHome, "orch-pal-codex.config.toml"),
        servers,
        "Generated by orch-ui. Do not edit; it is rewritten on container startup.",
      );
    }
    if (supervisor === "gemini") {
      await writeFile(
        path.join(paths.mcpConfigDir, "gemini-system-settings.json"),
        JSON.stringify({ mcpServers: servers }, null, 2),
        "utf8",
      );
    }
  }
}
