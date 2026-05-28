import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { paths, runtime, supervisorPeers, supervisors } from "../config/env.js";
import {
  forgetMemory,
  memoryNamespaces,
  readMemory,
  rememberMemory,
  updateMemorySummary,
} from "../domain/memory.js";
import { loadPrompt } from "../domain/prompts.js";
import { createTimelineEvent } from "../domain/run-timeline.js";
import { redactSensitiveText } from "../domain/safety.js";
import { resolveCwd, requireScopedCwd } from "../domain/workspace.js";
import { peerRoutingText, writeScopedPeerConfigs } from "./mcp.js";

let timelineSequence = 0;
const MAX_PROVIDER_ERROR_CHARS = 1000;
const PROVIDER_ERROR_REDACTION_OVERLAP = 200;

function compactHistory(messages, limit = 18) {
  return messages
    .slice(-limit)
    .map((message) => {
      const speaker = message.role === "assistant" ? `assistant/${message.supervisor || "unknown"}` : message.role;
      return `${speaker.toUpperCase()}:\n${message.modelContent || message.content}`;
    })
    .join("\n\n");
}

function previewServerInstruction() {
  const networkNote = runtime.networkMode === "host"
    ? "Docker network mode is `host`: shell and host share the host network namespace, so services bound to 0.0.0.0 are directly reachable from the host/LAN without Docker port publishing. Host firewall and port conflicts still apply."
    : "`127.0.0.1` from shell commands is container-local; the user's browser can reach a service only when Docker publishes that port.";
  return [
    "RUNTIME ENVIRONMENT: You are running inside the `orch-ui` Docker image/container, not directly on the user's host OS.",
    `Paths under \`/workspace\` are Docker-mounted project folders. ${networkNote}`,
    `WEB SERVER PREVIEW: When starting any project web/dev server, bind to ${runtime.devServerHost}, not localhost or 127.0.0.1.`,
    `Use a port from the Docker-published preview ranges: ${runtime.previewPorts}.`,
    "Use the `orch-preview` helper so the server stays alive after this supervisor run exits.",
    "For static sites run `orch-preview static <mapped-port> .`; for app dev servers run `orch-preview start <mapped-port> -- <command> ... --host 0.0.0.0 --port <mapped-port>`.",
    "Do not run foreground servers such as raw `python3 -m http.server ...` or `npm run dev` as the final long-running command; they may die when the CLI session exits. Use `orch-preview` instead.",
    "`orch-preview` performs the container health check and prints the host/LAN URLs; report those URLs to the user.",
    "Do not run public tunnels or tunnel CLIs such as localtunnel, ngrok, cloudflared, serveo, bore, or `ssh -R` unless the latest user message explicitly asks for a tunnel.",
    "If a LAN browser cannot connect, diagnose Docker port mappings, host IP, and firewall; do not fall back to a tunnel.",
  ].join("\n");
}

function browserContextInstruction(context = {}) {
  const hostname = String(context.hostname || "").trim();
  const origin = String(context.origin || "").trim();
  if (!hostname && !origin) return "";
  return [
    "BROWSER CONTEXT:",
    origin ? `The user currently opened Orch UI at: ${origin}` : "",
    hostname ? `Browser host for preview URLs: ${hostname}` : "",
    "When reporting preview URLs from `orch-preview`, prefer the browser host/Tailscale/LAN host over localhost when it is non-loopback.",
  ].filter(Boolean).join("\n");
}

function browserEnv(context = {}) {
  const hostname = String(context.hostname || "").trim();
  const origin = String(context.origin || "").trim();
  const host = String(context.host || "").trim();
  const env = {};
  if (hostname) env.ORCH_BROWSER_HOST = hostname;
  if (origin) env.ORCH_BROWSER_ORIGIN = origin;
  if (host) env.ORCH_BROWSER_UI_HOST = host;
  return env;
}

function runtimeContextText(session, options = {}) {
  return [
    `ACTIVE SUPERVISOR: ${session.supervisor}`,
    `MOUNTED WORKSPACE ROOT: ${paths.workspaceRoot}`,
    `ALLOWED SESSION ROOT: ${resolveCwd(session.cwd)}`,
    `CURRENT WORKDIR: ${session.cwd || "."}`,
    `WRITE MODE: ${runtime.allowWrite ? "enabled" : "read-only/plan"}`,
    "ACCESS POLICY: Read and edit only inside ALLOWED SESSION ROOT. Do not inspect, modify, create, delete, or run commands against sibling folders under /workspace.",
    previewServerInstruction(),
    browserContextInstruction(options.browserContext),
  ].filter(Boolean).join("\n");
}

function peerRoutingForPrompt(session, options = {}) {
  if (options.enablePeerMcp === false) {
    return [
      "MCP is disabled for this nested consultation.",
      "Answer directly from the prompt and do not attempt to call other model peers or MCP tools.",
    ].join("\n");
  }
  return peerRoutingText(session.supervisor, options.mcpConfigOptions || {});
}

function formatMemoryItems(scope, payload = {}) {
  const lines = [];
  if (payload.summary) lines.push(`- ${scope} summary: ${payload.summary}`);
  for (const memory of payload.memories || []) {
    const namespace = memory.namespace || "general";
    const tags = memory.tags?.length ? ` [${memory.tags.join(", ")}]` : "";
    lines.push(`- ${scope}/${namespace}/${memory.kind || "note"}${tags}: ${memory.text}`);
  }
  return lines;
}

export function formatMemoryContext(memory = {}) {
  const lines = [
    ...formatMemoryItems("user", memory.user),
    ...formatMemoryItems("project", memory.project),
  ].filter(Boolean);
  return lines.length
    ? `DURABLE MEMORY:\n${lines.slice(0, 24).join("\n")}`
    : "DURABLE MEMORY:\n(no stored memories found)";
}

function uniqueMemories(memories = []) {
  const seen = new Set();
  return memories.filter((memory) => {
    const key = memory.id || `${memory.scope}:${memory.namespace}:${memory.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadMemoryContext(session, query = "") {
  try {
    const files = memoryFilesForSession(session);
    const all = await readMemory(files, { scope: "all", limit: 10 });
    const queried = String(query || "").trim()
      ? await readMemory(files, { scope: "all", query, limit: 6 })
      : {};
    return formatMemoryContext({
      user: {
        summary: all.user?.summary || queried.user?.summary || "",
        memories: uniqueMemories([...(queried.user?.memories || []), ...(all.user?.memories || [])]),
      },
      project: {
        summary: all.project?.summary || queried.project?.summary || "",
        memories: uniqueMemories([...(queried.project?.memories || []), ...(all.project?.memories || [])]),
      },
    });
  } catch (error) {
    return `DURABLE MEMORY:\n(memory unavailable: ${compactTraceText(error.message || String(error), 220)})`;
  }
}

function buildCliPrompt(session, userContent, systemPrompt, options = {}) {
  const history = compactHistory(session.messages || []);
  const sections = [];
  if (options.includeSystemPrompt !== false) {
    sections.push("SYSTEM PROMPT:", systemPrompt, "");
  }
  sections.push(
    runtimeContextText(session, options),
    "",
    "PEER MODEL ROUTING:",
    peerRoutingForPrompt(session, options),
    "",
    options.memoryContext || "DURABLE MEMORY:\n(not loaded)",
    "",
    history ? `SESSION HISTORY:\n${history}\n` : "SESSION HISTORY:\n(empty)\n",
    "NEW USER MESSAGE:",
    userContent,
  );
  return sections.join("\n");
}

function emitTrace(options, content, stream = "trace") {
  if (!content) return;
  options.onTrace?.({ stream, content: content.endsWith("\n") ? content : `${content}\n` });
}

function nextTimelineId(prefix) {
  timelineSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${timelineSequence}`;
}

function emitTimeline(options, event) {
  options.onTask?.(createTimelineEvent(event));
}

function emitUsage(options, usage) {
  options.onUsage?.(usage);
}

function redactTraceText(value) {
  return String(value || "")
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "sk-...redacted")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ...redacted");
}

function compactTraceText(value, limit = 220) {
  const clean = redactTraceText(value).replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 3)}...`;
}

function hidePromptPayload(text) {
  const value = redactTraceText(text);
  const marker = "\nuser\nSYSTEM PROMPT:";
  const start = value.indexOf(marker);
  if (start < 0) return value;
  const before = value.slice(0, start);
  const rest = value.slice(start + marker.length);
  const resume = rest.search(/\n(?=(?:\d{4}-\d\d-\d\dT|ERROR:|codex\b|exec\b|mcp:))/i);
  const after = resume >= 0 ? rest.slice(resume) : "";
  return `${before}\nuser\n[prompt payload hidden]${after}`;
}

function formatCommand(command, args) {
  const hiddenValueFlags = new Set(["--system-prompt", "--prompt"]);
  const visible = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    visible.push(arg);
    if (hiddenValueFlags.has(arg) && index + 1 < args.length) {
      visible.push("<hidden>");
      index += 1;
      continue;
    }
  }
  return [command, ...visible].map((part) => {
    const text = compactTraceText(part, 120);
    return /[\s"'`]/.test(text) ? JSON.stringify(text) : text;
  }).join(" ");
}

function tracePeerSetup(session, scoped, options) {
  emitTrace(options, `[${session.supervisor}] workspace: ${scoped.scopedCwd}`);
  emitTimeline(options, {
    id: nextTimelineId("setup"),
    kind: "model",
    status: "info",
    title: `${session.supervisor} workspace`,
    detail: scoped.scopedCwd,
  });
  if (options.enablePeerMcp === false) {
    emitTrace(options, `[${session.supervisor}] MCP disabled for this nested call`);
    emitTimeline(options, {
      id: nextTimelineId("peers"),
      kind: "tool",
      status: "info",
      title: "MCP disabled",
      detail: "Nested consultation is running without peer or shared MCP servers.",
    });
    return;
  }
  const configOptions = options.mcpConfigOptions || {};
  const peerServers = configOptions.includePeerServers === false
    ? []
    : (supervisorPeers[session.supervisor] || []).map((peer) => `pal-${peer}`);
  const sharedTools = configOptions.includeSharedTools === false ? [] : runtime.enabledTools;
  const attached = [...peerServers, ...sharedTools];
  emitTrace(options, `[${session.supervisor}] MCP attached: ${attached.join(", ") || "(none)"}`);
  emitTimeline(options, {
    id: nextTimelineId("peers"),
    kind: "tool",
    status: "info",
    title: peerServers.length ? "MCP attached" : "Shared MCP attached",
    detail: attached.join(", ") || "(none)",
  });
}

function createStderrTraceFilter(command, options) {
  let buffer = "";
  let pendingUserLine = false;
  let hidingPromptPayload = false;

  const emitLine = (line) => {
    const clean = redactTraceText(line).trimEnd();
    if (!clean) return;
    emitTrace(options, `[stderr] ${clean}`, "stderr");
  };

  const isCodexEventLine = (line) => /^(codex|exec|mcp:|apply_patch|error|warning|diff)\b/i.test(line.trim());

  const processLine = (line) => {
    const clean = line.trimEnd();

    if (pendingUserLine) {
      pendingUserLine = false;
      if (clean === "SYSTEM PROMPT:") {
        hidingPromptPayload = true;
        emitTrace(options, "[stderr] [prompt payload hidden]", "stderr");
        return;
      }
      emitLine("user");
    }

    if (!hidingPromptPayload && command === "codex" && clean === "user") {
      pendingUserLine = true;
      return;
    }

    if (hidingPromptPayload) {
      if (isCodexEventLine(clean)) {
        hidingPromptPayload = false;
        processLine(clean);
      }
      return;
    }

    emitLine(line);
  };

  return {
    push(text) {
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    },
    flush() {
      if (pendingUserLine) {
        emitLine("user");
        pendingUserLine = false;
      }
      if (buffer) processLine(buffer);
      buffer = "";
    },
  };
}

function sanitizedProcessEnv(extra = {}) {
  const env = {
    ...process.env,
    HOME: paths.homeDir,
    CODEX_HOME: paths.codexHome,
    HOST: runtime.devServerHost,
    BIND_HOST: runtime.devServerHost,
    VITE_HOST: runtime.devServerHost,
  };
  for (const key of ["DEEPSEEK_API_KEY", "CUSTOM_API_KEY", "ORCH_AUTH_PASSWORD"]) delete env[key];
  return { ...env, ...extra };
}

// stdout/stderr are captured only for non-streaming callers and for the final error report. Long
// supervisor runs can emit megabytes of NDJSON; keeping only the tail bounds memory while still
// preserving enough context for failure diagnostics.
const RUN_BUFFER_LIMIT = 64 * 1024;
function appendCapped(current, text) {
  const combined = current + text;
  return combined.length > RUN_BUFFER_LIMIT
    ? combined.slice(combined.length - RUN_BUFFER_LIMIT)
    : combined;
}

function runCommand(command, args, { cwd, input, env = {}, onOutput, onTrace, onTask, stdoutHandler, signal, browserContext }) {
  return new Promise((resolve) => {
    const traceOptions = { onTrace };
    const timelineOptions = { onTask };
    const stderrTrace = createStderrTraceFilter(command, traceOptions);
    const taskId = nextTimelineId("cmd");
    const commandText = formatCommand(command, args);
    const startedAt = Date.now();
    emitTrace(traceOptions, `$ ${commandText}`);
    emitTrace(traceOptions, `[cwd] ${cwd}`);
    emitTimeline(timelineOptions, {
      id: taskId,
      kind: "command",
      status: "running",
      title: commandText,
      detail: `[cwd] ${cwd}\n`,
      meta: { cwd, command },
    });
    const child = spawn(command, args, {
      cwd,
      env: sanitizedProcessEnv({ ...browserEnv(browserContext), ...env }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stdinError = "";
    // ORCH_TIMEOUT_MS <= 0 means no auto-timeout (long multi-round runs); the user can always stop manually.
    const timer = runtime.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          emitTrace(traceOptions, `[timeout] command exceeded ${runtime.timeoutMs}ms; terminating`);
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5000).unref();
        }, runtime.timeoutMs)
      : null;
    const abort = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    };
    if (signal) signal.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      // Skip buffering when the caller is streaming via stdoutHandler — it already owns the data
      // and we only need the buffer for the non-streaming cliResult() fallback.
      if (!stdoutHandler) stdout = appendCapped(stdout, text);
      if (stdoutHandler) stdoutHandler(text);
      else onOutput?.({ stream: "stdout", content: text });
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr = appendCapped(stderr, text);
      stderrTrace.push(text);
    });
    child.stdin.on("error", (error) => {
      stdinError = error.message || String(error);
      stderr = `${stderr}\nstdin: ${stdinError}`.trim();
      emitTrace(traceOptions, `[stdin error] ${stdinError}`, "stderr");
      child.kill("SIGTERM");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      stderrTrace.flush();
      if (signal) signal.removeEventListener("abort", abort);
      emitTrace(traceOptions, `[spawn error] ${error.message}`);
      emitTimeline(timelineOptions, {
        id: taskId,
        kind: "command",
        status: "failed",
        title: commandText,
        detail: [`[cwd] ${cwd}`, `[spawn error] ${error.message}`].join("\n"),
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        meta: { cwd, command },
      });
      resolve({ ok: false, stdout, stderr: `${stderr}\n${error.message}`.trim(), code: -1, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      stderrTrace.flush();
      if (signal) signal.removeEventListener("abort", abort);
      emitTrace(traceOptions, `[exit] code=${code}${timedOut ? " timed out" : ""}`);
      const ok = code === 0 && !timedOut && !stdinError;
      emitTimeline(timelineOptions, {
        id: taskId,
        kind: "command",
        status: ok ? "completed" : "failed",
        title: commandText,
        detail: [
          `[cwd] ${cwd}`,
          `[exit] code=${code}${timedOut ? " timed out" : ""}`,
          stdinError ? `[stdin error] ${stdinError}` : "",
        ].filter(Boolean).join("\n"),
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        meta: { cwd, command, exitCode: code },
      });
      resolve({ ok: code === 0 && !timedOut && !stdinError, stdout, stderr, code, timedOut });
    });
    try {
      child.stdin.end(input);
    } catch (error) {
      stdinError = error.message || String(error);
      stderr = `${stderr}\nstdin: ${stdinError}`.trim();
      emitTrace(traceOptions, `[stdin error] ${stdinError}`, "stderr");
      child.kill("SIGTERM");
    }
  });
}

function cliResult(result) {
  const output = result.stdout.trim();
  if (result.ok && output) return output;
  const stderr = hidePromptPayload(result.stderr.trim());
  const stdout = hidePromptPayload(output);
  const details = [
    result.timedOut ? `Command timed out after ${runtime.timeoutMs}ms.` : "",
    stderr ? `stderr:\n${stderr}` : "",
    stdout ? `stdout:\n${stdout}` : "",
  ].filter(Boolean).join("\n\n");
  throw new Error(details || `Command failed with exit code ${result.code}`);
}

function palToolLabel(name = "") {
  const match = String(name).match(/^mcp__pal-([^_]+)__(.+)$/);
  if (match) return `PAL -> ${match[1]}.${match[2]}`;
  return String(name || "tool");
}

function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return "";
  const keys = Object.keys(input);
  if (!keys.length) return "";
  const priority = ["prompt", "query", "command", "cmd", "model", "role", "cli_name"];
  const selected = priority.find((key) => input[key] !== undefined) || keys[0];
  return `${selected}=${compactTraceText(JSON.stringify(input[selected]), 180)}`;
}

function summarizeToolResult(content) {
  const values = Array.isArray(content) ? content : [content];
  for (const item of values) {
    const raw = typeof item === "string" ? item : item?.text || item?.content || item?.tool_name || "";
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const body = parsed.content || parsed.error || parsed.status || raw;
      return compactTraceText(body, 220);
    } catch {
      return compactTraceText(raw, 220);
    }
  }
  return "";
}

function createClaudeStreamParser(options = {}) {
  let buffer = "";
  let answer = "";
  let resultText = "";
  const tools = new Map();

  const traceToolResult = (toolUseId, content) => {
    const tool = tools.get(toolUseId) || {};
    const name = tool.name || toolUseId || "tool";
    const summary = summarizeToolResult(content);
    emitTrace(options, `[result] ${palToolLabel(name)} ${summary}`.trim());
    emitTimeline(options, {
      id: `tool-${toolUseId}`,
      kind: "tool",
      status: "completed",
      title: palToolLabel(name),
      detail: summary,
      endedAt: new Date().toISOString(),
      durationMs: tool.startedAt ? Date.now() - tool.startedAt : undefined,
      meta: { tool: name },
    });
  };

  const handleEvent = (event) => {
    if (event.type === "system" && event.subtype === "init") {
      emitTrace(options, `[claude] init model=${event.model || "unknown"} cwd=${event.cwd || ""}`);
      if (event.mcp_servers?.length) {
        const servers = event.mcp_servers.map((server) => `${server.name}:${server.status}`).join(", ");
        emitTrace(options, `[claude] MCP servers: ${servers}`);
      }
      return;
    }

    if (event.type === "rate_limit_event" && event.rate_limit_info) {
      const info = event.rate_limit_info;
      const used = Number.isFinite(info.utilization) ? `${Math.round(info.utilization * 100)}%` : info.status;
      emitUsage(options, {
        type: "rate_limit",
        percent: Number.isFinite(info.utilization) ? info.utilization * 100 : undefined,
        label: info.rateLimitType || info.status || "Claude rate limit",
      });
      emitTrace(options, `[claude] rate limit ${info.rateLimitType || ""}: ${used}`.trim());
      return;
    }

    if (event.type === "assistant" && event.message?.content) {
      for (const part of event.message.content) {
        if (part.type === "text" && part.text) {
          answer += part.text;
          options.onOutput?.({ stream: "stdout", content: part.text });
        }
        if (part.type === "tool_use") {
          tools.set(part.id, { name: part.name, startedAt: Date.now() });
          const input = summarizeToolInput(part.input);
          emitTrace(options, `[tool] ${palToolLabel(part.name)}${input ? ` ${input}` : ""}`);
          emitTimeline(options, {
            id: `tool-${part.id}`,
            kind: "tool",
            status: "running",
            title: palToolLabel(part.name),
            detail: input,
            meta: { tool: part.name },
          });
        }
      }
      return;
    }

    if (event.type === "user" && event.message?.content) {
      for (const part of event.message.content) {
        if (part.type === "tool_result") traceToolResult(part.tool_use_id, part.content);
      }
      return;
    }

    if (event.type === "result") {
      resultText = event.result || "";
      const seconds = Number.isFinite(event.duration_ms) ? `${Math.round(event.duration_ms / 100) / 10}s` : "";
      const turns = Number.isFinite(event.num_turns) ? `turns=${event.num_turns}` : "";
      const cost = Number.isFinite(event.total_cost_usd) ? `cost=$${event.total_cost_usd.toFixed(4)}` : "";
      emitUsage(options, {
        type: "cost",
        costUsd: Number.isFinite(event.total_cost_usd) ? event.total_cost_usd : undefined,
      });
      emitTrace(options, `[claude] completed ${[seconds, turns, cost].filter(Boolean).join(" ")}`.trim());
    }
  };

  return {
    push(text) {
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch (error) {
          emitTrace(options, `[claude-json] ${compactTraceText(line, 180)}`);
        }
      }
    },
    flush() {
      if (!buffer.trim()) return;
      try {
        handleEvent(JSON.parse(buffer));
      } catch {
        emitTrace(options, `[claude-json] ${compactTraceText(buffer, 180)}`);
      }
      buffer = "";
    },
    answer() {
      return (answer || resultText).trim();
    },
  };
}

async function callClaude(session, prompt, options = {}) {
  const { systemPrompt, ...runOptions } = options;
  const scoped = options.enablePeerMcp === false
    ? { scopedCwd: requireScopedCwd(session.cwd), claudeConfigPath: null }
    : await writeScopedPeerConfigs(session, options.mcpConfigOptions || {});
  tracePeerSetup(session, scoped, runOptions);
  const args = ["--print", "--output-format", "stream-json", "--verbose", "--system-prompt", systemPrompt ?? await loadPrompt(session.supervisor)];
  if (runOptions.enablePeerMcp !== false) args.push("--mcp-config", scoped.claudeConfigPath, "--strict-mcp-config");
  if (process.env.CLAUDE_MODEL) args.push("--model", process.env.CLAUDE_MODEL);
  if (runtime.allowWrite) args.push("--dangerously-skip-permissions", "--permission-mode", "bypassPermissions");
  else args.push("--permission-mode", "plan");
  args.push("-");
  const parser = createClaudeStreamParser(options);
  const result = await runCommand("claude", args, { cwd: scoped.scopedCwd, input: prompt, env: { MCP_TIMEOUT: "60000" }, stdoutHandler: parser.push.bind(parser), ...runOptions });
  parser.flush();
  // On success we only return what the parser extracted as the assistant's answer. Falling back to
  // raw stdout would surface the underlying stream-json NDJSON to the user when Claude returns an
  // empty content block — which is misleading, not informative.
  if (result.ok) return parser.answer() || "";
  return cliResult(result);
}

// The flag that loads our generated profile config file varies by codex version (older builds drop
// --profile-v2 and use --profile). Detect it once from `codex exec --help`, and cache the
// in-flight promise so two concurrent callers do not both spawn `codex exec --help`.
let codexProfileFlag = null;
let codexProfileFlagPromise = null;
function detectCodexProfileFlag() {
  if (codexProfileFlag) return Promise.resolve(codexProfileFlag);
  if (codexProfileFlagPromise) return codexProfileFlagPromise;
  codexProfileFlagPromise = new Promise((resolve) => {
    execFile("codex", ["exec", "--help"], { timeout: 5000 }, (_error, stdout = "", stderr = "") => {
      codexProfileFlag = /--profile-v2\b/.test(`${stdout}\n${stderr}`) ? "--profile-v2" : "--profile";
      resolve(codexProfileFlag);
    });
  }).finally(() => { codexProfileFlagPromise = null; });
  return codexProfileFlagPromise;
}

async function callCodex(session, prompt, options = {}) {
  const scoped = options.enablePeerMcp === false
    ? { scopedCwd: requireScopedCwd(session.cwd), codexProfile: null }
    : await writeScopedPeerConfigs(session, options.mcpConfigOptions || {});
  tracePeerSetup(session, scoped, options);
  const args = ["exec", "--skip-git-repo-check", "-C", scoped.scopedCwd];
  if (options.enablePeerMcp !== false) args.push(await detectCodexProfileFlag(), scoped.codexProfile);
  if (process.env.CODEX_MODEL) args.push("--model", process.env.CODEX_MODEL);
  if (runtime.allowWrite) args.push("--dangerously-bypass-approvals-and-sandbox");
  else args.push("--sandbox", "read-only");
  args.push("-");
  const result = await runCommand("codex", args, { cwd: scoped.scopedCwd, input: prompt, ...options });
  const tokenMatch = `${result.stderr}\n${result.stdout}`.match(/tokens used\s*[\r\n\s]+([0-9,]+)/i);
  if (tokenMatch) {
    emitUsage(options, {
      type: "tokens",
      tokens: Number(tokenMatch[1].replace(/,/g, "")),
    });
  }
  return cliResult(result);
}

async function callGemini(session, prompt, options = {}) {
  const scoped = options.enablePeerMcp === false
    ? { scopedCwd: requireScopedCwd(session.cwd), geminiConfigPath: null }
    : await writeScopedPeerConfigs(session, options.mcpConfigOptions || {});
  tracePeerSetup(session, scoped, options);
  const args = ["--skip-trust", "--output-format", "text"];
  if (process.env.GEMINI_MODEL) args.push("--model", process.env.GEMINI_MODEL);
  args.push("--approval-mode", runtime.allowWrite ? "yolo" : "plan", "--prompt", "");
  const result = await runCommand("gemini", args, {
    cwd: scoped.scopedCwd,
    input: prompt,
    env: {
      GEMINI_CLI_TRUST_WORKSPACE: "true",
      ...(options.enablePeerMcp === false ? {} : { GEMINI_CLI_SYSTEM_SETTINGS_PATH: scoped.geminiConfigPath }),
    },
    ...options,
  });
  return cliResult(result);
}

async function callDeepSeek(session, userContent, systemPrompt, options = {}) {
  requireScopedCwd(session.cwd);
  if (!runtime.deepseekApiKey) {
    throw new Error("DEEPSEEK_API_KEY is not set. Add it to orch-ui/.env and recreate the container.");
  }
  emitTrace(options, `[deepseek] workspace: ${resolveCwd(session.cwd)}`);

  const messages = [
    {
      role: "system",
      content: [
        systemPrompt,
        "",
        runtimeContextText(session, options),
        "",
        options.memoryContext || await loadMemoryContext(session, userContent),
        "",
        `PEER MODEL ROUTING:\n${peerRoutingText("deepseek")}`,
      ].filter(Boolean).join("\n"),
    },
    ...(session.messages || []).slice(-20).map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.modelContent || message.content,
    })),
    { role: "user", content: userContent },
  ];

  if (options.enablePeerTools !== false) return callDeepSeekWithPeerTools(session, messages, options);
  return callDeepSeekPlain(messages, options);
}

async function callDeepSeekPlain(messages, options = {}) {
  const shouldStream = Boolean(options.onOutput);
  emitTrace(options, `[deepseek] POST /v1/chat/completions model=deepseek-v4-pro stream=${shouldStream}`);
  const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${runtime.deepseekApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      messages,
      temperature: 0.2,
      max_tokens: 8192,
      stream: shouldStream,
      ...(shouldStream ? { stream_options: { include_usage: true } } : {}),
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    const error = await providerHttpError("DeepSeek", response);
    throw error;
  }
  if (shouldStream) return readDeepSeekStream(response.body, options);
  const parsed = JSON.parse(await response.text());
  if (parsed.usage) {
    emitUsage(options, {
      type: "tokens",
      tokens: parsed.usage.total_tokens,
    });
  }
  return parsed.choices?.[0]?.message?.content?.trim() || "";
}

function deepSeekPeerTools() {
  return ["claude", "codex", "gemini"].map((peer) => ({
    type: "function",
    function: {
      name: `ask_${peer}`,
      description: `Ask ${supervisors[peer].label} for a focused second opinion or delegated subtask. Do not use for work the DeepSeek supervisor can answer directly.`,
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "A concise, self-contained prompt for the peer supervisor.",
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
  }));
}

function deepSeekMemoryTools() {
  return [
    {
      type: "function",
      function: {
        name: "memory_read",
        description: "Read durable user/global and/or current-project memory. Call at the start of a task.",
        parameters: {
          type: "object",
          properties: {
            scope: { type: "string", enum: ["all", "user", "project"] },
            namespace: { type: "string", enum: ["all", ...memoryNamespaces] },
            query: { type: "string" },
            limit: { type: "number" },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_search",
        description: "Search durable memory across user/global and/or current-project scopes.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            scope: { type: "string", enum: ["all", "user", "project"] },
            namespace: { type: "string", enum: ["all", ...memoryNamespaces] },
            limit: { type: "number" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_remember",
        description: "Store a durable fact/preference/decision. Use scope=user for facts like the user's name.",
        parameters: {
          type: "object",
          properties: {
            scope: { type: "string", enum: ["user", "project"] },
            kind: { type: "string", enum: ["fact", "preference", "decision", "summary", "note"] },
            namespace: { type: "string", enum: memoryNamespaces },
            text: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            source: { type: "string" },
          },
          required: ["scope", "text"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_forget",
        description: "Forget a memory by id or exact text. Never use broad deletion.",
        parameters: {
          type: "object",
          properties: {
            scope: { type: "string", enum: ["user", "project"] },
            id: { type: "string" },
            exactText: { type: "string" },
          },
          required: ["scope"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_update_summary",
        description: "Replace the durable summary for user/global or current-project memory.",
        parameters: {
          type: "object",
          properties: {
            scope: { type: "string", enum: ["user", "project"] },
            summary: { type: "string" },
          },
          required: ["scope", "summary"],
          additionalProperties: false,
        },
      },
    },
  ];
}

function deepSeekBrowserTools() {
  if (!runtime.enabledTools.includes("playwright")) return [];
  return [
    {
      type: "function",
      function: {
        name: "browser_check",
        description: "Delegate browser automation or UI verification to a CLI peer that has the Playwright browser MCP tool. Use when the task needs a real browser.",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "A concise, self-contained browser verification task, including the URL or dev-server command when known.",
            },
            peer: {
              type: "string",
              enum: ["codex", "claude", "gemini"],
              description: "The CLI peer to run the browser task. Defaults to codex.",
            },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
      },
    },
  ];
}

function deepSeekTools() {
  return [...deepSeekPeerTools(), ...deepSeekMemoryTools(), ...deepSeekBrowserTools()];
}

function memoryFilesForSession(session) {
  const scopedCwd = requireScopedCwd(session.cwd || ".");
  return {
    globalFile: path.join(paths.dataDir, "orch-memory", "user.json"),
    projectFile: path.join(scopedCwd, ".remember", "orchestrator-memory.json"),
  };
}

async function callDeepSeekWithPeerTools(session, messages, options = {}) {
  const toolMessages = [...messages];
  const tools = deepSeekTools();
  for (let step = 0; step < 4; step += 1) {
    emitTrace(options, `[deepseek] step ${step + 1}: request with peer tools`);
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtime.deepseekApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        messages: toolMessages,
        tools,
        tool_choice: "auto",
        temperature: 0.2,
        max_tokens: 8192,
      }),
      signal: options.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      if (response.status === 400 && /tool|function/i.test(body)) {
        options.onTrace?.({
          stream: "stderr",
          content: "\n[deepseek] peer tools are not supported by this model/API response; continuing without peer tools.\n",
        });
        return callDeepSeekPlain(messages, options);
      }
      throw providerHttpErrorFromBody("DeepSeek", response, body);
    }
    const parsed = JSON.parse(body);
    if (parsed.usage) {
      emitUsage(options, {
        type: "tokens",
        tokens: parsed.usage.total_tokens,
      });
    }
    const message = parsed.choices?.[0]?.message || {};
    const toolCalls = message.tool_calls || [];
    if (!toolCalls.length) {
      const answer = message.content?.trim() || "";
      if (options.onOutput && answer) options.onOutput({ stream: "stdout", content: answer });
      return answer;
    }

    toolMessages.push(message);
    for (const toolCall of toolCalls) {
      const toolName = toolCall.function?.name || "";
      let args = {};
      try {
        args = JSON.parse(toolCall.function?.arguments || "{}");
      } catch (error) {
        toolMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: `Invalid tool arguments for ${toolName}: ${error.message}`,
        });
        continue;
      }
      let result = "";
      if (toolName.startsWith("ask_")) {
        const prompt = String(args.prompt || "").trim();
        if (!prompt) throw new Error(`${toolName} requires a prompt`);
        emitTrace(options, `[deepseek] ${toolName} -> running peer delegate`);
        result = await runDeepSeekPeerTool(session, toolName, prompt, options);
        emitTrace(options, `[deepseek] ${toolName} <- completed (${result.length} chars)`);
      } else if (toolName === "browser_check") {
        const prompt = String(args.prompt || "").trim();
        if (!prompt) throw new Error("browser_check requires a prompt");
        const peer = ["codex", "claude", "gemini"].includes(args.peer) ? args.peer : "codex";
        emitTrace(options, `[deepseek] browser_check -> ${peer} with playwright`);
        result = await runDeepSeekBrowserTool(session, peer, prompt, options);
        emitTrace(options, `[deepseek] browser_check <- completed (${result.length} chars)`);
      } else if (toolName.startsWith("memory_")) {
        const taskId = nextTimelineId("memory");
        const startedAt = Date.now();
        emitTrace(options, `[deepseek] ${toolName} -> memory`);
        emitTimeline(options, {
          id: taskId,
          kind: "memory",
          status: "running",
          title: toolName,
          detail: compactTraceText(JSON.stringify(args), 600),
          meta: { tool: toolName },
        });
        try {
          result = await runDeepSeekMemoryTool(session, toolName, args);
          emitTimeline(options, {
            id: taskId,
            kind: "memory",
            status: "completed",
            title: toolName,
            detail: compactTraceText(result, 1000),
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            meta: { tool: toolName },
          });
        } catch (error) {
          result = `Memory tool error: ${error.message || String(error)}`;
          emitTimeline(options, {
            id: taskId,
            kind: "memory",
            status: "failed",
            title: toolName,
            detail: result,
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            meta: { tool: toolName },
          });
        }
        emitTrace(options, `[deepseek] ${toolName} <- memory completed`);
      } else {
        result = `Unknown tool: ${toolName}`;
      }
      toolMessages.push({ role: "tool", tool_call_id: toolCall.id, content: result.slice(0, 30000) });
    }
  }
  throw new Error("DeepSeek peer tool loop reached its step limit");
}

function providerHttpErrorFromBody(provider, response, body) {
  const status = Number(response.status || 500);
  const rawBody = String(body || "").slice(0, MAX_PROVIDER_ERROR_CHARS + PROVIDER_ERROR_REDACTION_OVERLAP);
  const safeBody = redactSensitiveText(rawBody).slice(0, MAX_PROVIDER_ERROR_CHARS);
  return Object.assign(new Error(`${provider} API ${status}: ${safeBody}`), { status });
}

async function providerHttpError(provider, response) {
  return providerHttpErrorFromBody(provider, response, await response.text());
}

async function runDeepSeekMemoryTool(session, toolName, args) {
  const files = memoryFilesForSession(session);
  let result;
  if (toolName === "memory_read" || toolName === "memory_search") result = await readMemory(files, args);
  else if (toolName === "memory_remember") result = await rememberMemory(files, args);
  else if (toolName === "memory_forget") result = await forgetMemory(files, args);
  else if (toolName === "memory_update_summary") result = await updateMemorySummary(files, args);
  else throw new Error(`Unknown DeepSeek memory tool: ${toolName}`);
  return JSON.stringify(result, null, 2);
}

async function runDeepSeekBrowserTool(session, peer, prompt, parentOptions = {}) {
  return runDeepSeekPeerTool(session, `ask_${peer}`, [
    "Use the enabled Playwright/browser MCP tools for this browser or UI verification task.",
    "Do not delegate to other model peers. Report the URL, actions, observations, failures, and any recommended fix.",
    "",
    prompt,
  ].join("\n"), parentOptions);
}

async function runDeepSeekPeerTool(session, toolName, prompt, parentOptions = {}) {
  const peer = toolName.replace(/^ask_/, "");
  if (!["claude", "codex", "gemini"].includes(peer)) throw new Error(`Unknown DeepSeek peer tool: ${toolName}`);
  const taskId = nextTimelineId("peer");
  const startedAt = Date.now();
  const peerSession = { ...session, supervisor: peer, messages: [], cwd: session.cwd || "." };
  const systemPrompt = await loadPrompt(peerSession.supervisor);
  const sharedOnlyMcp = { includePeerServers: false };
  const peerPrompt = buildCliPrompt(peerSession, prompt, systemPrompt, {
    ...parentOptions,
    enablePeerMcp: true,
    mcpConfigOptions: sharedOnlyMcp,
    includeSystemPrompt: peer !== "claude",
    memoryContext: parentOptions.memoryContext || await loadMemoryContext(peerSession, prompt),
  });
  const options = {
    enablePeerMcp: true,
    enablePeerTools: false,
    mcpConfigOptions: sharedOnlyMcp,
    onTrace: parentOptions.onTrace,
    onTask: parentOptions.onTask,
    ...(peer === "claude" ? { systemPrompt } : {}),
  };
  emitTimeline(parentOptions, {
    id: taskId,
    kind: "tool",
    status: "running",
    title: `DeepSeek -> ${peer}`,
    detail: compactTraceText(prompt, 1200),
    meta: { peer, tool: toolName },
  });
  try {
    let answer;
    if (peer === "claude") answer = await callClaude(peerSession, peerPrompt, options);
    else if (peer === "codex") answer = await callCodex(peerSession, peerPrompt, options);
    else if (peer === "gemini") answer = await callGemini(peerSession, peerPrompt, options);
    else throw new Error(`Unknown peer: ${peer}`);
    emitTimeline(parentOptions, {
      id: taskId,
      kind: "tool",
      status: "completed",
      title: `DeepSeek -> ${peer}`,
      detail: `${answer.length} chars returned`,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      meta: { peer, tool: toolName },
    });
    return answer;
  } catch (error) {
    emitTimeline(parentOptions, {
      id: taskId,
      kind: "tool",
      status: "failed",
      title: `DeepSeek -> ${peer}`,
      detail: error.message || String(error),
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      meta: { peer, tool: toolName },
    });
    throw error;
  }
}

async function readDeepSeekStream(body, options = {}) {
  let answer = "";
  let buffer = "";
  const decoder = new TextDecoder();
  const reader = body.getReader();

  const processLine = (line) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let delta = "";
    try {
      const parsed = JSON.parse(data);
      if (parsed.usage) {
        emitUsage(options, {
          type: "tokens",
          tokens: parsed.usage.total_tokens,
        });
      }
      delta = parsed.choices?.[0]?.delta?.content || "";
    } catch (error) {
      emitTrace(options, `[deepseek] ignored malformed stream line: ${error.message}`, "stderr");
      return;
    }
    if (delta) {
      answer += delta;
      options.onOutput?.({ stream: "stdout", content: delta });
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    }
    buffer += decoder.decode();
    if (buffer) processLine(buffer);
  } finally {
    // Releasing the lock on error/abort lets the body stream be cancelled and the underlying
    // socket closed instead of leaking until GC. cancel() is best-effort: it is already gone
    // when the stream completed normally.
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return answer.trim();
}

export async function runSupervisor(session, userContent, options = {}) {
  const supervisor = supervisors[session.supervisor] ? session.supervisor : runtime.defaultSupervisor;
  const runSession = { ...session, supervisor };
  const memoryContext = options.memoryContext || await loadMemoryContext(runSession, userContent);
  const taskId = nextTimelineId("supervisor");
  emitTimeline(options, {
    id: taskId,
    kind: "supervisor",
    status: "running",
    title: `${supervisor} supervisor`,
    detail: `cwd=${runSession.cwd || "."}`,
    meta: { supervisor, cwd: runSession.cwd || "." },
  });
  const startedAt = Date.now();
  try {
    const systemPrompt = await loadPrompt(supervisor);
    let answer;
    if (supervisor === "deepseek") {
      answer = await callDeepSeek(runSession, userContent, systemPrompt, { ...options, memoryContext });
    } else {
      const prompt = buildCliPrompt(runSession, userContent, systemPrompt, {
        ...options,
        memoryContext,
        includeSystemPrompt: supervisor !== "claude",
      });
      if (supervisor === "claude") answer = await callClaude(runSession, prompt, { ...options, systemPrompt });
      else if (supervisor === "codex") answer = await callCodex(runSession, prompt, options);
      else if (supervisor === "gemini") answer = await callGemini(runSession, prompt, options);
      else throw new Error(`Unknown supervisor: ${supervisor}`);
    }
    emitTimeline(options, {
      id: taskId,
      kind: "supervisor",
      status: "completed",
      title: `${supervisor} supervisor`,
      detail: `${String(answer || "").length} chars returned`,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      meta: { supervisor, cwd: runSession.cwd || "." },
    });
    return answer;
  } catch (error) {
    emitTimeline(options, {
      id: taskId,
      kind: "supervisor",
      status: options.signal?.aborted ? "stopped" : "failed",
      title: `${supervisor} supervisor`,
      detail: error.message || String(error),
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      meta: { supervisor, cwd: runSession.cwd || "." },
    });
    throw error;
  }
}
