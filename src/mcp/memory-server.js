#!/usr/bin/env node
import readline from "node:readline";
import {
  forgetMemory,
  readMemory,
  rememberMemory,
  updateMemorySummary,
} from "../domain/memory.js";

const files = {
  globalFile: process.env.ORCH_MEMORY_GLOBAL_FILE || "/data/orch-memory/user.json",
  projectFile: process.env.ORCH_MEMORY_PROJECT_FILE || ".remember/orchestrator-memory.json",
};

const tools = [
  {
    name: "memory_read",
    description: "Read durable user/global and/or current-project memory. Call at the start of a task.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["all", "user", "project"], default: "all" },
        query: { type: "string", description: "Optional search query to filter memory." },
        limit: { type: "number", description: "Maximum memories per scope, default 25." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_search",
    description: "Search durable memory across user/global and/or current-project scopes.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms." },
        scope: { type: "string", enum: ["all", "user", "project"], default: "all" },
        limit: { type: "number", description: "Maximum memories per scope, default 25." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_remember",
    description: "Store a durable fact/preference/decision. Use scope=user for facts like the user's name.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["user", "project"] },
        kind: { type: "string", enum: ["fact", "preference", "decision", "summary", "note"], default: "note" },
        text: { type: "string", description: "Plain-language memory. Never store secrets." },
        tags: { type: "array", items: { type: "string" }, description: "Optional short tags." },
        source: { type: "string", description: "Optional source note, e.g. user-stated." },
      },
      required: ["scope", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_forget",
    description: "Forget a memory by id or exact text. Never use broad deletion.",
    inputSchema: {
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
  {
    name: "memory_update_summary",
    description: "Replace the durable summary for user/global or current-project memory.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["user", "project"] },
        summary: { type: "string", description: "Concise summary. Never store secrets." },
      },
      required: ["scope", "summary"],
      additionalProperties: false,
    },
  },
];

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, payload) {
  write({ jsonrpc: "2.0", id, result: payload });
}

function error(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function textResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

async function callTool(name, args) {
  if (name === "memory_read") return readMemory(files, args);
  if (name === "memory_search") return readMemory(files, args);
  if (name === "memory_remember") return rememberMemory(files, args);
  if (name === "memory_forget") return forgetMemory(files, args);
  if (name === "memory_update_summary") return updateMemorySummary(files, args);
  throw Object.assign(new Error(`Unknown tool: ${name}`), { status: 404 });
}

async function handle(message) {
  if (!message || typeof message !== "object") return;
  const { id, method, params = {} } = message;
  if (!id && method?.startsWith("notifications/")) return;
  try {
    if (method === "initialize") {
      result(id, {
        protocolVersion: params.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "orch-memory", version: "0.1.0" },
      });
      return;
    }
    if (method === "ping") {
      result(id, {});
      return;
    }
    if (method === "tools/list") {
      result(id, { tools });
      return;
    }
    if (method === "tools/call") {
      const payload = await callTool(params.name, params.arguments || {});
      result(id, textResult(payload));
      return;
    }
    error(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    result(id, { ...textResult(err.message || String(err)), isError: true });
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
input.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const message = JSON.parse(line);
    queue = queue
      .then(() => handle(message))
      .catch((err) => error(message.id ?? null, -32603, err.message || String(err)));
  } catch (err) {
    error(null, -32700, `Parse error: ${err.message}`);
  }
});
