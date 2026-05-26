import { spawn } from "node:child_process";
import { paths, runtime, supervisorPeers, supervisors } from "../config/env.js";
import { loadPrompt } from "../domain/prompts.js";
import { resolveCwd, requireScopedCwd } from "../domain/workspace.js";
import { peerRoutingText, writeScopedPeerConfigs } from "./mcp.js";

function compactHistory(messages, limit = 18) {
  return messages
    .slice(-limit)
    .map((message) => {
      const speaker = message.role === "assistant" ? `assistant/${message.supervisor || "unknown"}` : message.role;
      return `${speaker.toUpperCase()}:\n${message.modelContent || message.content}`;
    })
    .join("\n\n");
}

function buildCliPrompt(session, userContent, systemPrompt) {
  const history = compactHistory(session.messages || []);
  return [
    "SYSTEM PROMPT:",
    systemPrompt,
    "",
    `ACTIVE SUPERVISOR: ${session.supervisor}`,
    `MOUNTED WORKSPACE ROOT: ${paths.workspaceRoot}`,
    `ALLOWED SESSION ROOT: ${resolveCwd(session.cwd)}`,
    `CURRENT WORKDIR: ${session.cwd || "."}`,
    `WRITE MODE: ${runtime.allowWrite ? "enabled" : "read-only/plan"}`,
    "ACCESS POLICY: Read and edit only inside ALLOWED SESSION ROOT. Do not inspect, modify, create, delete, or run commands against sibling folders under /workspace.",
    "",
    "PEER MODEL ROUTING:",
    peerRoutingText(session.supervisor),
    "",
    history ? `SESSION HISTORY:\n${history}\n` : "SESSION HISTORY:\n(empty)\n",
    "NEW USER MESSAGE:",
    userContent,
  ].join("\n");
}

function emitTrace(options, content, stream = "trace") {
  if (!content) return;
  options.onTrace?.({ stream, content: content.endsWith("\n") ? content : `${content}\n` });
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
  if (options.enablePeerMcp === false) {
    emitTrace(options, `[${session.supervisor}] PAL peers disabled for this nested call`);
    return;
  }
  const peers = supervisorPeers[session.supervisor] || [];
  emitTrace(options, `[${session.supervisor}] PAL MCP attached: ${peers.map((peer) => `pal-${peer}`).join(", ") || "(none)"}`);
}

function runCommand(command, args, { cwd, input, env = {}, onOutput, onTrace, stdoutHandler, signal }) {
  return new Promise((resolve) => {
    const traceOptions = { onTrace };
    emitTrace(traceOptions, `$ ${formatCommand(command, args)}`);
    emitTrace(traceOptions, `[cwd] ${cwd}`);
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      emitTrace(traceOptions, `[timeout] command exceeded ${runtime.timeoutMs}ms; terminating`);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, runtime.timeoutMs);
    const abort = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    };
    if (signal) signal.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (stdoutHandler) stdoutHandler(text);
      else onOutput?.({ stream: "stdout", content: text });
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      emitTrace(traceOptions, `[stderr] ${text}`, "stderr");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abort);
      emitTrace(traceOptions, `[spawn error] ${error.message}`);
      resolve({ ok: false, stdout, stderr: `${stderr}\n${error.message}`.trim(), code: -1, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abort);
      emitTrace(traceOptions, `[exit] code=${code}${timedOut ? " timed out" : ""}`);
      resolve({ ok: code === 0 && !timedOut, stdout, stderr, code, timedOut });
    });
    child.stdin.end(input);
  });
}

function cliResult(result) {
  const output = result.stdout.trim();
  if (result.ok && output) return output;
  const details = [
    result.timedOut ? `Command timed out after ${runtime.timeoutMs}ms.` : "",
    result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
    output ? `stdout:\n${output}` : "",
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
    const name = tools.get(toolUseId) || toolUseId || "tool";
    emitTrace(options, `[result] ${palToolLabel(name)} ${summarizeToolResult(content)}`.trim());
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
          tools.set(part.id, part.name);
          const input = summarizeToolInput(part.input);
          emitTrace(options, `[tool] ${palToolLabel(part.name)}${input ? ` ${input}` : ""}`);
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
  const scoped = options.enablePeerMcp === false
    ? { scopedCwd: requireScopedCwd(session.cwd), claudeConfigPath: null }
    : await writeScopedPeerConfigs(session);
  tracePeerSetup(session, scoped, options);
  const args = ["--print", "--output-format", "stream-json", "--verbose", "--system-prompt", await loadPrompt(session.supervisor)];
  if (options.enablePeerMcp !== false) args.push("--mcp-config", scoped.claudeConfigPath, "--strict-mcp-config");
  if (process.env.CLAUDE_MODEL) args.push("--model", process.env.CLAUDE_MODEL);
  if (runtime.allowWrite) args.push("--dangerously-skip-permissions", "--permission-mode", "bypassPermissions");
  else args.push("--permission-mode", "plan");
  args.push("-");
  const parser = createClaudeStreamParser(options);
  const result = await runCommand("claude", args, { cwd: scoped.scopedCwd, input: prompt, stdoutHandler: parser.push.bind(parser), ...options });
  parser.flush();
  if (result.ok) return parser.answer() || cliResult(result);
  return cliResult(result);
}

async function callCodex(session, prompt, options = {}) {
  const scoped = options.enablePeerMcp === false
    ? { scopedCwd: requireScopedCwd(session.cwd), codexProfile: null }
    : await writeScopedPeerConfigs(session);
  tracePeerSetup(session, scoped, options);
  const args = ["exec", "--skip-git-repo-check", "-C", scoped.scopedCwd];
  if (options.enablePeerMcp !== false) args.push("--profile-v2", scoped.codexProfile);
  if (process.env.CODEX_MODEL) args.push("--model", process.env.CODEX_MODEL);
  if (runtime.allowWrite) args.push("--dangerously-bypass-approvals-and-sandbox");
  else args.push("--sandbox", "read-only");
  args.push("-");
  const result = await runCommand("codex", args, { cwd: scoped.scopedCwd, input: prompt, ...options });
  return cliResult(result);
}

async function callGemini(session, prompt, options = {}) {
  const scoped = options.enablePeerMcp === false
    ? { scopedCwd: requireScopedCwd(session.cwd), geminiConfigPath: null }
    : await writeScopedPeerConfigs(session);
  tracePeerSetup(session, scoped, options);
  const args = ["--skip-trust", "--output-format", "text"];
  if (process.env.GEMINI_MODEL) args.push("--model", process.env.GEMINI_MODEL);
  args.push("--approval-mode", runtime.allowWrite ? "yolo" : "plan", "--prompt", prompt);
  const result = await runCommand("gemini", args, {
    cwd: scoped.scopedCwd,
    input: "",
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
    { role: "system", content: `${systemPrompt}\n\nPEER MODEL ROUTING:\n${peerRoutingText("deepseek")}` },
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
    }),
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`DeepSeek API ${response.status}: ${await response.text()}`);
  if (shouldStream) return readDeepSeekStream(response.body, options.onOutput);
  const parsed = JSON.parse(await response.text());
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

async function callDeepSeekWithPeerTools(session, messages, options = {}) {
  const toolMessages = [...messages];
  const tools = deepSeekPeerTools();
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
      throw new Error(`DeepSeek API ${response.status}: ${body}`);
    }
    const message = JSON.parse(body).choices?.[0]?.message || {};
    const toolCalls = message.tool_calls || [];
    if (!toolCalls.length) {
      const answer = message.content?.trim() || "";
      if (options.onOutput && answer) options.onOutput({ stream: "stdout", content: answer });
      return answer;
    }

    toolMessages.push(message);
    for (const toolCall of toolCalls) {
      const toolName = toolCall.function?.name || "";
      const args = JSON.parse(toolCall.function?.arguments || "{}");
      const prompt = String(args.prompt || "").trim();
      if (!prompt) throw new Error(`${toolName} requires a prompt`);
      emitTrace(options, `[deepseek] ${toolName} -> running peer delegate`);
      const result = await runDeepSeekPeerTool(session, toolName, prompt, options);
      emitTrace(options, `[deepseek] ${toolName} <- completed (${result.length} chars)`);
      toolMessages.push({ role: "tool", tool_call_id: toolCall.id, content: result.slice(0, 30000) });
    }
  }
  throw new Error("DeepSeek peer tool loop reached its step limit");
}

async function runDeepSeekPeerTool(session, toolName, prompt, parentOptions = {}) {
  const peer = toolName.replace(/^ask_/, "");
  if (!["claude", "codex", "gemini"].includes(peer)) throw new Error(`Unknown DeepSeek peer tool: ${toolName}`);
  const peerSession = { ...session, supervisor: peer, messages: [], cwd: session.cwd || "." };
  const systemPrompt = await loadPrompt(peerSession.supervisor);
  const peerPrompt = buildCliPrompt(peerSession, prompt, systemPrompt);
  const options = { enablePeerMcp: false, enablePeerTools: false, onTrace: parentOptions.onTrace };
  if (peer === "claude") return callClaude(peerSession, peerPrompt, options);
  if (peer === "codex") return callCodex(peerSession, peerPrompt, options);
  if (peer === "gemini") return callGemini(peerSession, peerPrompt, options);
  throw new Error(`Unknown peer: ${peer}`);
}

async function readDeepSeekStream(body, onOutput) {
  let answer = "";
  let buffer = "";
  const decoder = new TextDecoder();
  const reader = body.getReader();

  const processLine = (line) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const delta = JSON.parse(data).choices?.[0]?.delta?.content || "";
    if (delta) {
      answer += delta;
      onOutput({ stream: "stdout", content: delta });
    }
  };

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
  return answer.trim();
}

export async function runSupervisor(session, userContent, options = {}) {
  const supervisor = supervisors[session.supervisor] ? session.supervisor : runtime.defaultSupervisor;
  const runSession = { ...session, supervisor };
  const systemPrompt = await loadPrompt(supervisor);
  if (supervisor === "deepseek") return callDeepSeek(runSession, userContent, systemPrompt, options);
  const prompt = buildCliPrompt(runSession, userContent, systemPrompt);
  if (supervisor === "claude") return callClaude(runSession, prompt, options);
  if (supervisor === "codex") return callCodex(runSession, prompt, options);
  if (supervisor === "gemini") return callGemini(runSession, prompt, options);
  throw new Error(`Unknown supervisor: ${supervisor}`);
}
