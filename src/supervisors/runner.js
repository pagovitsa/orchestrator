import { spawn } from "node:child_process";
import { paths, runtime, supervisors } from "../config/env.js";
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

function runCommand(command, args, { cwd, input, env = {}, onOutput, signal }) {
  return new Promise((resolve) => {
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
      onOutput?.({ stream: "stdout", content: text });
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      onOutput?.({ stream: "stderr", content: text });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abort);
      resolve({ ok: false, stdout, stderr: `${stderr}\n${error.message}`.trim(), code: -1, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abort);
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

async function callClaude(session, prompt, options = {}) {
  const scoped = options.enablePeerMcp === false
    ? { scopedCwd: requireScopedCwd(session.cwd), claudeConfigPath: null }
    : await writeScopedPeerConfigs(session);
  const args = ["--print", "--output-format", "text", "--system-prompt", await loadPrompt(session.supervisor)];
  if (options.enablePeerMcp !== false) args.push("--mcp-config", scoped.claudeConfigPath, "--strict-mcp-config");
  if (process.env.CLAUDE_MODEL) args.push("--model", process.env.CLAUDE_MODEL);
  if (runtime.allowWrite) args.push("--dangerously-skip-permissions", "--permission-mode", "bypassPermissions");
  else args.push("--permission-mode", "plan");
  args.push("-");
  const result = await runCommand("claude", args, { cwd: scoped.scopedCwd, input: prompt, ...options });
  return cliResult(result);
}

async function callCodex(session, prompt, options = {}) {
  const scoped = options.enablePeerMcp === false
    ? { scopedCwd: requireScopedCwd(session.cwd), codexProfile: null }
    : await writeScopedPeerConfigs(session);
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
        options.onOutput?.({
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
      options.onOutput?.({ stream: "stdout", content: `\n[${toolName}] running peer delegate...\n` });
      const result = await runDeepSeekPeerTool(session, toolName, prompt);
      options.onOutput?.({ stream: "stdout", content: `[${toolName}] completed.\n` });
      toolMessages.push({ role: "tool", tool_call_id: toolCall.id, content: result.slice(0, 30000) });
    }
  }
  throw new Error("DeepSeek peer tool loop reached its step limit");
}

async function runDeepSeekPeerTool(session, toolName, prompt) {
  const peer = toolName.replace(/^ask_/, "");
  if (!["claude", "codex", "gemini"].includes(peer)) throw new Error(`Unknown DeepSeek peer tool: ${toolName}`);
  const peerSession = { ...session, supervisor: peer, messages: [], cwd: session.cwd || "." };
  const systemPrompt = await loadPrompt(peerSession.supervisor);
  const peerPrompt = buildCliPrompt(peerSession, prompt, systemPrompt);
  const options = { enablePeerMcp: false, enablePeerTools: false };
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
