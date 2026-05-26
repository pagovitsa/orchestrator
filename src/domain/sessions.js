import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runtime, supervisors } from "../config/env.js";
import { requireScopedCwd, resolveCwd, listProjects } from "./workspace.js";

const rememberDirName = ".remember";
const rememberFileName = "orchestrator-chat.json";

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
  };
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
  session.schemaVersion = 1;
  session.project = projectLabel(session.cwd);
  session.title = session.project;
  session.updatedAt = new Date().toISOString();

  const filePath = rememberPathForCwd(session.cwd);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(session, null, 2), "utf8");
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
