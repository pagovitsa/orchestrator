import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runtime, supervisors } from "../config/env.js";
import { redactSensitiveStrings } from "./safety.js";
import { requireScopedCwd, resolveCwd, listProjects } from "./workspace.js";
import { summarizeAutopilotFeed } from "./autopilot.js";
import { normalizeWorkflowStatus, transitionWorkflowStatus } from "./workflow-state.js";

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

async function writeRememberSession(cwd, saved, targetSession = null) {
  const filePath = rememberPathForCwd(cwd);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, JSON.stringify(saved, null, 2), "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  if (targetSession) Object.assign(targetSession, saved);
  return saved;
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

function sessionLockKey(cwd) {
  // resolveCwd canonicalises the cwd against the workspace root so aliases like "project-a" and
  // "./project-a" hash to the same lock key. Falling back to the raw input keeps test fixtures
  // that pre-set paths.workspaceRoot from blowing up on validation.
  try { return resolveCwd(cwd || "."); } catch { return cwd || "."; }
}

async function withSessionLock(cwd, task) {
  const key = sessionLockKey(cwd);
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
  const autopilotEnabled = session.autopilotEnabled === true;
  let autopilotState = normalizeWorkflowStatus(
    session.autopilotState,
    autopilotEnabled ? "created" : "paused",
  );
  const autopilotHistory = Array.isArray(session.autopilotHistory) ? redactSensitiveStrings(session.autopilotHistory).slice(-50) : [];
  return {
    id: /^[a-f0-9-]{36}$/.test(session.id || "") ? session.id : randomUUID(),
    schemaVersion: 1,
    title: project,
    project,
    supervisor: supervisors[session.supervisor] ? session.supervisor : runtime.defaultSupervisor,
    cwd,
    createdAt: session.createdAt || new Date().toISOString(),
    updatedAt: session.updatedAt || session.createdAt || new Date().toISOString(),
    messages: Array.isArray(session.messages) ? session.messages.map((message) => redactSensitiveStrings(message)) : [],
    autopilotHistory,
    autopilotFeed: summarizeAutopilotFeed(autopilotHistory),
    autopilotEnabled,
    autopilotState,
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

// Internal save that assumes the caller already holds withSessionLock(cwd). Used by saveSession
// and by createSession to avoid re-entrant lock acquisition (which would deadlock the chain).
async function saveSessionLocked(session) {
  const cwd = session.cwd || ".";
  if (!Array.isArray(session.messages)) {
    throw Object.assign(new Error("session.messages must be an array"), { status: 400 });
  }
  const existing = await readRememberFile(cwd);
  const normalized = normalizeProjectSession(session, cwd);
  const saved = {
    ...normalized,
    id: existing?.id || normalized.id,
    createdAt: existing?.createdAt || normalized.createdAt,
    messages: normalized.messages,
    updatedAt: new Date().toISOString(),
  };
  saved.project = projectLabel(cwd);
  saved.title = saved.project;

  await writeRememberSession(cwd, saved, session);
  return session;
}

export async function saveSession(session) {
  return withSessionLock(session.cwd, () => saveSessionLocked(session));
}

export async function updateSessionForCwd(cwd, updater) {
  return withSessionLock(cwd, async () => {
    const existing = await readRememberFile(cwd);
    if (!existing) throw Object.assign(new Error("Project conversation not found"), { status: 404 });
    const updated = await updater(existing) || existing;
    if (!Array.isArray(updated.messages)) {
      throw Object.assign(new Error("session.messages must be an array"), { status: 400 });
    }
    const normalized = normalizeProjectSession(updated, cwd);
    const saved = {
      ...normalized,
      id: existing.id,
      createdAt: existing.createdAt || normalized.createdAt,
      messages: normalized.messages,
      updatedAt: new Date().toISOString(),
    };
    saved.project = projectLabel(cwd);
    saved.title = saved.project;
    await writeRememberSession(cwd, saved, updated);
    return saved;
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
        autopilotEnabled: session.autopilotEnabled === true,
        autopilotState: session.autopilotState,
        autopilotFeed: summarizeAutopilotFeed(session.autopilotHistory),
      });
    } catch {
      // Ignore malformed remember files so one project cannot break the UI.
    }
  }
  return sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function clearStaleAutopilotRuns(reason = "Cleared after server restart") {
  const cleared = [];
  for (const cwd of await listRememberedProjectCwds()) {
    await withSessionLock(cwd, async () => {
      let raw;
      try {
        raw = JSON.parse(await readFile(rememberPathForCwd(cwd), "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      if (String(raw.autopilotState?.state || "").toLowerCase() !== "running") return;
      const now = new Date().toISOString();
      if (raw.autopilotEnabled === true) {
        raw.messages = Array.isArray(raw.messages) ? raw.messages : [];
        raw.messages.push({
          role: "assistant",
          supervisor: supervisors[raw.supervisor] ? raw.supervisor : runtime.defaultSupervisor,
          content: `${reason}: previous Autopilot run was interrupted before returning a final answer.`,
          at: now,
          stopped: true,
        });
      }
      raw.autopilotState = {
        state: raw.autopilotEnabled === true ? "created" : "paused",
        updatedAt: now,
        reason,
      };
      const saved = normalizeProjectSession(raw, cwd);
      await writeRememberSession(cwd, { ...saved, updatedAt: new Date().toISOString() });
      cleared.push(cwd);
    });
  }
  return cleared;
}

async function listRememberedProjectCwds() {
  const projects = await listProjects();
  const cwds = runtime.allowWorkspaceRoot ? [".", ...projects] : projects;
  return cwds;
}

export async function createSession(body = {}) {
  const supervisor = supervisors[body.supervisor] ? body.supervisor : runtime.defaultSupervisor;
  const cwd = body.cwd || ".";
  requireScopedCwd(cwd);

  // Serialize concurrent creates for the same cwd so two parallel POSTs do not each see a
  // missing file, mint distinct UUIDs, and race their writes — leaving one caller holding a
  // session id that has already been overwritten on disk.
  return withSessionLock(cwd, async () => {
    const now = new Date().toISOString();
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
      autopilotEnabled: false,
      autopilotState: { state: "created", updatedAt: now, reason: "" },
    };

    session.supervisor = supervisor;
    session.cwd = cwd;
    session.project = projectLabel(cwd);
    session.title = session.project;
    return saveSessionLocked(session);
  });
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
  if (body.autopilotEnabled !== undefined) {
    const enabled = body.autopilotEnabled === true;
    session.autopilotEnabled = enabled;
    session.autopilotState = transitionWorkflowStatus(
      session.autopilotState,
      enabled ? "created" : "paused",
      enabled ? "Autopilot enabled" : "Autopilot paused",
    );
  }
  return session;
}
