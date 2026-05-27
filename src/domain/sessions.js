import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runtime, supervisors } from "../config/env.js";
import { requireScopedCwd, resolveCwd, listProjects } from "./workspace.js";

const rememberDirName = ".remember";
const rememberFileName = "orchestrator-chat.json";
const sessionLocks = new Map();

export async function ensureSessionStore() {
  // Project conversations live inside each project. There is no central chat-session store.
}

export function projectLabel(cwd = ".") {
  return cwd === "." ? "workspace" : cwd;
}

export function rememberPathForCwd(cwd = ".") {
  return path.join(resolveCwd(cwd), rememberDirName, rememberFileName);
}

async function readRememberFile(cwd) {
  try {
    const session = JSON.parse(await readFile(rememberPathForCwd(cwd), "utf8"));
    return normalizeProjectSession(session, cwd);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function withSessionLock(cwd, task) {
  const key = cwd || ".";
  const previous = sessionLocks.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const marker = run.catch(() => {});
  sessionLocks.set(key, marker);
  return run.finally(() => {
    if (sessionLocks.get(key) === marker) sessionLocks.delete(key);
  });
}

function normalizeProjectSession(session, cwd) {
  const project = projectLabel(cwd);
  return {
    id: /^[a-f0-9-]{36}$/.test(session.id || "") ? session.id : randomUUID(),
    schemaVersion: 1,
    title: project,
    project,
    supervisor: supervisors[session.supervisor] ? session.supervisor : runtime.defaultSupervisor,
    cwd,
    createdAt: session.createdAt || new Date().toISOString(),
    updatedAt: session.updatedAt || session.createdAt || new Date().toISOString(),
    messages: Array.isArray(session.messages) ? session.messages : [],
    autopilotHistory: Array.isArray(session.autopilotHistory) ? session.autopilotHistory.slice(-50) : [],
  };
}

function messageKey(message) {
  return JSON.stringify({
    role: message.role,
    supervisor: message.supervisor || "",
    at: message.at || "",
    content: message.content || "",
    modelContent: message.modelContent || "",
    error: Boolean(message.error),
  });
}

function mergeMessages(existing = [], incoming = []) {
  const merged = [];
  const seen = new Set();
  for (const message of [...existing, ...incoming]) {
    const key = messageKey(message);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(message);
  }
  return merged.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
}

export async function loadSession(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) {
    throw Object.assign(new Error("Invalid conversation id"), { status: 400 });
  }

  for (const cwd of await listRememberedProjectCwds()) {
    const session = await readRememberFile(cwd);
    if (session?.id === id) return session;
  }

  throw Object.assign(new Error("Project conversation not found"), { status: 404 });
}

export async function saveSession(session) {
  return withSessionLock(session.cwd, async () => {
    const cwd = session.cwd || ".";
    const existing = await readRememberFile(cwd);
    const normalized = normalizeProjectSession(session, cwd);
    const saved = {
      ...normalized,
      id: existing?.id || normalized.id,
      createdAt: existing?.createdAt || normalized.createdAt,
      messages: mergeMessages(existing?.messages, normalized.messages),
      updatedAt: new Date().toISOString(),
    };
    saved.project = projectLabel(cwd);
    saved.title = saved.project;

    const filePath = rememberPathForCwd(cwd);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(saved, null, 2), "utf8");
    Object.assign(session, saved);
    return session;
  });
}

export async function listSessions() {
  const sessions = [];
  for (const cwd of await listRememberedProjectCwds()) {
    try {
      const session = await readRememberFile(cwd);
      if (!session) continue;
      sessions.push({
        id: session.id,
        title: session.project,
        project: session.project,
        supervisor: session.supervisor,
        cwd: session.cwd,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages?.length || 0,
        rememberPath: rememberPathForCwd(session.cwd),
      });
    } catch {
      // Ignore malformed remember files so one project cannot break the UI.
    }
  }
  return sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

async function listRememberedProjectCwds() {
  const projects = await listProjects();
  const cwds = runtime.allowWorkspaceRoot ? [".", ...projects] : projects;
  return cwds;
}

export async function createSession(body = {}) {
  const now = new Date().toISOString();
  const supervisor = supervisors[body.supervisor] ? body.supervisor : runtime.defaultSupervisor;
  const cwd = body.cwd || ".";
  requireScopedCwd(cwd);

  const existing = await readRememberFile(cwd);
  const session = existing || {
    id: randomUUID(),
    schemaVersion: 1,
    title: projectLabel(cwd),
    project: projectLabel(cwd),
    supervisor,
    cwd,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };

  session.supervisor = supervisor;
  session.cwd = cwd;
  session.project = projectLabel(cwd);
  session.title = session.project;
  await saveSession(session);
  return session;
}

export function sessionHasMessages(session) {
  return Boolean(session.messages?.length);
}

export function applySessionPatch(session, body = {}, options = {}) {
  const allowIdentityChange = options.allowIdentityChange !== false;
  const identityLocked = !allowIdentityChange || sessionHasMessages(session);

  if (body.title !== undefined) session.title = session.project || projectLabel(session.cwd);
  if (body.supervisor !== undefined) {
    if (!supervisors[body.supervisor]) throw Object.assign(new Error(`Unknown supervisor: ${body.supervisor}`), { status: 400 });
    if (body.supervisor !== session.supervisor && identityLocked) {
      throw Object.assign(new Error("Project supervisor is fixed for this chat run"), { status: 409 });
    }
    session.supervisor = body.supervisor;
  }
  if (body.cwd !== undefined) {
    resolveCwd(body.cwd);
    const nextCwd = body.cwd || ".";
    if (nextCwd !== (session.cwd || ".") && identityLocked) {
      throw Object.assign(new Error("Project workspace is fixed for this chat run"), { status: 409 });
    }
    session.cwd = nextCwd;
    session.project = projectLabel(nextCwd);
    session.title = session.project;
  }
  return session;
}
