import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { paths } from "../config/env.js";

const hookLogFile = path.join(paths.dataDir, "hooks", "events.jsonl");

function cleanText(value, max = 600) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function normalizeHookEvent(raw = {}) {
  return {
    type: cleanText(raw.type, 80) || "event",
    at: raw.at || new Date().toISOString(),
    sessionId: cleanText(raw.sessionId, 80),
    project: cleanText(raw.project, 120),
    supervisor: cleanText(raw.supervisor, 40),
    status: cleanText(raw.status, 40),
    detail: cleanText(raw.detail, 1200),
  };
}

async function writeHookEvent(event) {
  await mkdir(path.dirname(hookLogFile), { recursive: true });
  await appendFile(hookLogFile, `${JSON.stringify(event)}\n`, "utf8");
}

export function emitHookEvent(raw = {}) {
  const event = normalizeHookEvent(raw);
  void writeHookEvent(event).catch((error) => {
    console.error("[hooks] event failed:", error.message || error);
  });
  return event;
}
