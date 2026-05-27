import { appendFile, mkdir, readFile } from "node:fs/promises";
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

export async function listHookEvents({ limit = 100, project = "", sessionId = "" } = {}) {
  const max = Math.max(1, Math.min(500, Number(limit) || 100));
  let text = "";
  try {
    text = await readFile(hookLogFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const cleanProject = cleanText(project, 120);
  const cleanSessionId = cleanText(sessionId, 80);
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = normalizeHookEvent(JSON.parse(line));
      if (cleanProject && event.project !== cleanProject) continue;
      if (cleanSessionId && event.sessionId !== cleanSessionId) continue;
      events.push(event);
    } catch {
      // Ignore malformed hook lines so one partial write cannot break diagnostics.
    }
  }
  return events.slice(-max).reverse();
}
