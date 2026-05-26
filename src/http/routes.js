import { runtime, paths, supervisorPeers, supervisors } from "../config/env.js";
import {
  buildModelContent,
  publicAttachmentMetadata,
  saveAttachments,
} from "../domain/attachments.js";
import {
  applySessionPatch,
  createSession,
  listSessions,
  loadSession,
  saveSession,
} from "../domain/sessions.js";
import { listPrompts, savePrompts } from "../domain/prompts.js";
import {
  connectionStatus,
  disconnectConnection,
  getConnectionJob,
  requireConnectedSupervisor,
  sendConnectionJobInput,
  startConnection,
} from "../domain/connections.js";
import { deleteProject, ensureProject, listProjects, requireScopedCwd, resolveCwd } from "../domain/workspace.js";
import { runSupervisor } from "../supervisors/runner.js";
import { readBody, sendJson, writeStreamEvent } from "./response.js";

const activeRuns = new Map();

function runStopReason(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return "Stopped by user";
}

function activeRunForProject(project) {
  for (const run of activeRuns.values()) {
    if (run.cwd === project) return run;
  }
  return null;
}

function registerActiveRun(id, session, abortController, mode) {
  if (activeRuns.has(id)) {
    throw Object.assign(new Error("This project already has a running model. Stop it before sending another message."), { status: 409 });
  }
  activeRuns.set(id, {
    id,
    mode,
    supervisor: session.supervisor,
    cwd: session.cwd || ".",
    startedAt: new Date().toISOString(),
    abortController,
  });
}

function clearActiveRun(id, abortController) {
  const active = activeRuns.get(id);
  if (active?.abortController === abortController) activeRuns.delete(id);
}

function promptSessionWithoutCurrentUser(session) {
  return { ...session, messages: (session.messages || []).slice(0, -1) };
}

async function appendUserMessage(session, body) {
  const content = String(body.content || "").trim();
  const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
  if (!content && !hasAttachments) {
    throw Object.assign(new Error("Message content or attachment is required"), { status: 400 });
  }
  applySessionPatch(session, body, { allowIdentityChange: false });
  requireScopedCwd(session.cwd);

  session.messages ||= [];
  const attachments = await saveAttachments(session, body.attachments);
  const modelContent = buildModelContent(content, attachments);
  const publicAttachments = publicAttachmentMetadata(attachments);
  const displayContent = content || (publicAttachments.length ? "Attached files" : "");
  session.messages.push({
    role: "user",
    content: displayContent,
    modelContent,
    attachments: publicAttachments,
    at: new Date().toISOString(),
  });
  await saveSession(session);
  return modelContent;
}

async function handleStreamMessage(req, res, id) {
  const session = await loadSession(id);
  const abortController = new AbortController();
  let completed = false;
  let clientClosed = false;
  registerActiveRun(id, session, abortController, "stream");

  const body = await readBody(req).catch((error) => {
    clearActiveRun(id, abortController);
    throw error;
  });
  const modelContent = await appendUserMessage(session, body).catch((error) => {
    clearActiveRun(id, abortController);
    throw error;
  });

  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  writeStreamEvent(res, { type: "session", session });

  res.on("close", () => {
    if (completed) return;
    clientClosed = true;
    abortController.abort();
  });

  let transcript = "";
  const onOutput = ({ stream, content }) => {
    transcript += content;
    writeStreamEvent(res, { type: "chunk", stream, content });
  };
  const onTrace = ({ stream = "trace", content }) => {
    writeStreamEvent(res, { type: "trace", stream, content, at: new Date().toISOString() });
  };

  try {
    const answer = await runSupervisor(promptSessionWithoutCurrentUser(session), modelContent, {
      onOutput,
      onTrace,
      signal: abortController.signal,
    });
    session.messages.push({
      role: "assistant",
      supervisor: session.supervisor,
      content: answer || transcript.trim() || "(empty response)",
      at: new Date().toISOString(),
    });
    await saveSession(session);
    writeStreamEvent(res, { type: "done", session, message: session.messages.at(-1) });
  } catch (error) {
    if (clientClosed && abortController.signal.aborted) return;
    const stopped = abortController.signal.aborted;
    const details = stopped ? runStopReason(abortController.signal) : (error.message || String(error));
    session.messages.push({
      role: "assistant",
      supervisor: session.supervisor,
      content: stopped
        ? [transcript.trim(), details].filter(Boolean).join("\n\n")
        : [transcript.trim(), `Error: ${details}`].filter(Boolean).join("\n\n"),
      at: new Date().toISOString(),
      error: !stopped,
      stopped,
    });
    await saveSession(session);
    writeStreamEvent(res, { type: stopped ? "stopped" : "error", error: details, session, message: session.messages.at(-1) });
  } finally {
    completed = true;
    clearActiveRun(id, abortController);
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}

async function handleJsonMessage(req, res, id) {
  const abortController = new AbortController();
  let completed = false;
  res.on("close", () => {
    if (!completed) abortController.abort();
  });
  const session = await loadSession(id);
  registerActiveRun(id, session, abortController, "json");
  try {
    const modelContent = await appendUserMessage(session, await readBody(req));
    const answer = await runSupervisor(promptSessionWithoutCurrentUser(session), modelContent, { signal: abortController.signal });
    session.messages.push({
      role: "assistant",
      supervisor: session.supervisor,
      content: answer || "(empty response)",
      at: new Date().toISOString(),
    });
    await saveSession(session);
    completed = true;
    return sendJson(res, 200, { session, message: session.messages.at(-1) });
  } catch (error) {
    if (!abortController.signal.aborted) throw error;
    session.messages.push({
      role: "assistant",
      supervisor: session.supervisor,
      content: runStopReason(abortController.signal),
      at: new Date().toISOString(),
      stopped: true,
    });
    await saveSession(session);
    completed = true;
    return sendJson(res, 200, { session, message: session.messages.at(-1), stopped: true });
  } finally {
    clearActiveRun(id, abortController);
  }
}

export async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/config") {
    return sendJson(res, 200, {
      supervisors,
      defaultSupervisor: runtime.defaultSupervisor,
      allowWrite: runtime.allowWrite,
      workspaceRoot: paths.workspaceRoot,
      promptFile: paths.promptFile,
      supervisorPeers,
      maxUploadBytes: runtime.maxUploadBytes,
      allowWorkspaceRoot: runtime.allowWorkspaceRoot,
    });
  }
  if (req.method === "GET" && url.pathname === "/api/projects") {
    return sendJson(res, 200, { projects: await listProjects() });
  }
  if (req.method === "GET" && url.pathname === "/api/prompts") {
    return sendJson(res, 200, await listPrompts());
  }
  if (req.method === "PUT" && url.pathname === "/api/prompts") {
    return sendJson(res, 200, await savePrompts(await readBody(req)));
  }
  if (req.method === "GET" && url.pathname === "/api/connections") {
    return sendJson(res, 200, { connections: await connectionStatus() });
  }
  const connectionStartMatch = url.pathname.match(/^\/api\/connections\/([a-z0-9-]+)\/start$/);
  if (connectionStartMatch && req.method === "POST") {
    return sendJson(res, 200, await startConnection(connectionStartMatch[1], await readBody(req)));
  }
  const connectionDisconnectMatch = url.pathname.match(/^\/api\/connections\/([a-z0-9-]+)\/disconnect$/);
  if (connectionDisconnectMatch && req.method === "POST") {
    return sendJson(res, 200, await disconnectConnection(connectionDisconnectMatch[1]));
  }
  const connectionJobMatch = url.pathname.match(/^\/api\/connections\/jobs\/([a-f0-9-]{36})$/);
  if (connectionJobMatch && req.method === "GET") {
    return sendJson(res, 200, { job: getConnectionJob(connectionJobMatch[1]) });
  }
  const connectionJobInputMatch = url.pathname.match(/^\/api\/connections\/jobs\/([a-f0-9-]{36})\/input$/);
  if (connectionJobInputMatch && req.method === "POST") {
    const body = await readBody(req);
    return sendJson(res, 200, { job: sendConnectionJobInput(connectionJobInputMatch[1], body.input) });
  }
  if (req.method === "POST" && url.pathname === "/api/projects") {
    const body = await readBody(req);
    const result = await ensureProject(body.name);
    return sendJson(res, result.created ? 201 : 200, { ...result, projects: await listProjects() });
  }
  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch && req.method === "DELETE") {
    const project = decodeURIComponent(projectMatch[1]);
    const activeRun = activeRunForProject(project);
    if (activeRun) {
      throw Object.assign(new Error("Stop the running model before deleting this project"), { status: 409 });
    }
    const result = await deleteProject(project);
    return sendJson(res, 200, { ...result, projects: await listProjects(), sessions: await listSessions() });
  }
  if (req.method === "GET" && url.pathname === "/api/sessions") {
    return sendJson(res, 200, { sessions: await listSessions() });
  }
  if (req.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readBody(req);
    await requireConnectedSupervisor(body.supervisor);
    return sendJson(res, 201, { session: await createSession(body) });
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})$/);
  if (sessionMatch && req.method === "GET") {
    return sendJson(res, 200, { session: await loadSession(sessionMatch[1]) });
  }
  if (sessionMatch && req.method === "PATCH") {
    const session = applySessionPatch(await loadSession(sessionMatch[1]), await readBody(req), { allowIdentityChange: false });
    await saveSession(session);
    return sendJson(res, 200, { session });
  }
  const stopMatch = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})\/stop$/);
  if (stopMatch && req.method === "POST") {
    const activeRun = activeRuns.get(stopMatch[1]);
    if (!activeRun) return sendJson(res, 200, { stopped: false });
    activeRun.abortController.abort(new Error("Stopped by user"));
    return sendJson(res, 202, { stopped: true, run: { id: activeRun.id, supervisor: activeRun.supervisor, cwd: activeRun.cwd } });
  }

  const streamMessageMatch = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})\/messages\/stream$/);
  if (streamMessageMatch && req.method === "POST") return handleStreamMessage(req, res, streamMessageMatch[1]);

  const messageMatch = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})\/messages$/);
  if (messageMatch && req.method === "POST") return handleJsonMessage(req, res, messageMatch[1]);

  return sendJson(res, 404, { error: "Not found" });
}
