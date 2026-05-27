import path from "node:path";
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
  updateSessionForCwd,
} from "../domain/sessions.js";
import { listPrompts, resetPrompts, savePrompts } from "../domain/prompts.js";
import { emitHookEvent, listHookEvents } from "../domain/hooks.js";
import { extractUserMemoriesFromText, readMemory, rememberMemory } from "../domain/memory.js";
import { mergeTimelineEvent } from "../domain/run-timeline.js";
import { redactSensitiveText } from "../domain/safety.js";
import { recordRunEnd, recordRunStart, recordUsageSignal, usageSnapshot } from "../domain/usage.js";
import { appendAutopilotHistory, autopilotMemoryArgs, clearAutopilotHistory, decideAutopilotNextWithRetry } from "../domain/autopilot.js";
import { transitionWorkflowStatus, workflowCanRun } from "../domain/workflow-state.js";
import { idleTimeoutDecision, normalizeIdleTimeoutConfig } from "../domain/idle-timeout.js";
import {
  connectionStatus,
  disconnectConnection,
  getConnectionJob,
  requireConnectedSupervisor,
  sendConnectionJobInput,
  startConnection,
} from "../domain/connections.js";
import { deleteProject, ensureProject, listProjects, requireScopedCwd, resolveCwd } from "../domain/workspace.js";
import { mcpToolCatalog } from "../supervisors/mcp.js";
import { runSupervisor } from "../supervisors/runner.js";
import { readBody, sendJson, writeStreamEvent } from "./response.js";

const activeRuns = new Map();
const activeAutopilotRuns = new Map();
const eventClients = new Set();
const idleConfig = normalizeIdleTimeoutConfig({
  timeoutMs: runtime.autopilotIdleTimeoutMs,
  warningMs: runtime.autopilotIdleWarningMs,
});
const autopilotDecisionTimeoutConfig = normalizeIdleTimeoutConfig({
  timeoutMs: runtime.autopilotDecisionTimeoutMs,
  warningMs: runtime.autopilotIdleWarningMs,
});
const autopilotRetryConfig = {
  attempts: runtime.autopilotRetryAttempts,
  backoffMs: runtime.autopilotRetryBackoffMs,
};
const idleCheckIntervalMs = idleConfig.timeoutMs > 0 ? Math.max(250, Math.min(5000, Math.floor(idleConfig.timeoutMs / 4))) : 0;
let idleCheckTimer = null;

function sendEventClient(client, event) {
  if (client.res.destroyed || client.res.writableEnded) {
    eventClients.delete(client);
    return;
  }
  try {
    client.res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {
    eventClients.delete(client);
  }
}

function broadcastRunEvent(sessionId, clientId, event) {
  const payload = { ...event, sessionId, clientId };
  for (const client of eventClients) sendEventClient(client, payload);
}

function emitRunEvent(res, sessionId, clientId, event) {
  writeStreamEvent(res, event);
  broadcastRunEvent(sessionId, clientId, event);
}

function ensureIdleChecker() {
  if (!idleCheckIntervalMs || idleCheckTimer) return;
  idleCheckTimer = setInterval(checkIdleRuns, idleCheckIntervalMs);
  idleCheckTimer.unref();
}

function subscribeEvents(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");

  const client = { res };
  eventClients.add(client);
  const heartbeat = setInterval(() => {
    if (res.destroyed || res.writableEnded) {
      clearInterval(heartbeat);
      eventClients.delete(client);
      return;
    }
    res.write(": ping\n\n");
  }, 25000);
  req.on("close", () => {
    clearInterval(heartbeat);
    eventClients.delete(client);
  });

  for (const run of activeRuns.values()) {
    if (!run.session || !run.draft) continue;
    sendEventClient(client, {
      type: "session",
      sessionId: run.id,
      clientId: run.clientId || "",
      session: run.session,
      draft: run.draft,
      replay: true,
    });
  }
}

function runStopReason(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return "Stopped by user";
}

function errorDetail(error, limit = 1000) {
  return redactSensitiveText(error?.message || String(error || "")).slice(0, limit);
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
  for (const run of activeRuns.values()) {
    if (run.supervisor === session.supervisor) {
      throw Object.assign(new Error(`${supervisors[session.supervisor]?.label || session.supervisor} is already running in another project`), { status: 409 });
    }
  }
  const run = {
    id,
    mode,
    supervisor: session.supervisor,
    cwd: session.cwd || ".",
    startedAt: new Date().toISOString(),
    source: "manual",
    lastActivityMs: Date.now(),
    idleWarningSent: false,
    idleStopped: false,
    abortController,
    clientId: "",
    session: null,
    draft: null,
  };
  activeRuns.set(id, run);
  ensureIdleChecker();
  return run;
}

function clearActiveRun(id, abortController) {
  const active = activeRuns.get(id);
  if (active?.abortController === abortController) activeRuns.delete(id);
}

function updateRunActivity(run) {
  if (!run) return;
  run.lastActivityMs = Date.now();
  run.idleWarningSent = false;
}

function checkIdleRuns() {
  const now = Date.now();
  for (const run of activeRuns.values()) {
    const decision = idleTimeoutDecision(run, now, idleConfig);
    if (decision.action === "warn") {
      run.idleWarningSent = true;
      run.warnIdle?.(decision.remainingMs);
    } else if (decision.action === "stop") {
      run.idleStopped = true;
      run.abortController.abort(new Error("Autopilot idle timeout"));
    }
  }
}

function createAutopilotDecisionTimeout(session) {
  const abortController = new AbortController();
  if (!autopilotDecisionTimeoutConfig.timeoutMs) {
    return { signal: abortController.signal, abort: (reason) => abortController.abort(reason), clear() {} };
  }
  const warningDelay = autopilotDecisionTimeoutConfig.warningMs > 0
    ? Math.max(0, autopilotDecisionTimeoutConfig.timeoutMs - autopilotDecisionTimeoutConfig.warningMs)
    : 0;
  const warningTimer = warningDelay > 0
    ? setTimeout(() => {
        broadcastRunEvent(session.id, "", {
          type: "autopilot",
          phase: "idle-warning",
          project: session.cwd,
          supervisor: session.supervisor,
          warning: `Autopilot decision timeout approaching; will stop in ${Math.ceil(autopilotDecisionTimeoutConfig.warningMs / 1000)}s`,
          at: new Date().toISOString(),
        });
      }, warningDelay)
    : null;
  const timeoutTimer = setTimeout(() => {
    abortController.abort(new Error("Autopilot decision timeout"));
  }, autopilotDecisionTimeoutConfig.timeoutMs);
  warningTimer?.unref();
  timeoutTimer.unref();
  return {
    signal: abortController.signal,
    abort: (reason) => abortController.abort(reason),
    clear() {
      if (warningTimer) clearTimeout(warningTimer);
      clearTimeout(timeoutTimer);
    },
  };
}

function captureUsage(supervisor) {
  return (signal) => {
    recordUsageSignal(supervisor, signal).catch((error) => {
      console.error(`usage signal failed for ${supervisor}:`, error.message || error);
    });
  };
}

async function safelyRecordUsage(action, task) {
  try {
    await task();
  } catch (error) {
    console.error(`usage ${action} failed:`, error.message || error);
  }
}

function promptSessionWithoutCurrentUser(session) {
  return { ...session, messages: (session.messages || []).slice(0, -1) };
}

function cleanHeaderValue(value, maxLength = 240) {
  return String(Array.isArray(value) ? value[0] : value || "")
    .replace(/[\r\n]/g, "")
    .trim()
    .slice(0, maxLength);
}

function cleanBrowserHost(value) {
  const text = cleanHeaderValue(value, 180);
  if (!/^[A-Za-z0-9.:[\]_-]+$/.test(text)) return "";
  return text.replace(/^\[|\]$/g, "");
}

function browserContextFromRequest(req, body = {}) {
  const browser = body.browser && typeof body.browser === "object" ? body.browser : {};
  const forwardedProto = cleanHeaderValue(req.headers["x-forwarded-proto"], 24).split(",")[0] || "";
  const forwardedHost = cleanHeaderValue(req.headers["x-forwarded-host"], 180).split(",")[0] || "";
  const protocol = cleanHeaderValue(browser.protocol, 24).replace(/:$/, "") ||
    forwardedProto ||
    (req.socket.encrypted ? "https" : "http");
  const hostname = cleanBrowserHost(browser.hostname) ||
    cleanBrowserHost((forwardedHost || req.headers.host || "").replace(/:\d+$/, ""));
  const host = cleanHeaderValue(browser.host, 180) || forwardedHost || cleanHeaderValue(req.headers.host, 180);
  const origin = cleanHeaderValue(browser.origin, 240) || (host ? `${protocol}://${host}` : "");
  return { protocol, hostname, host, origin };
}

async function autoRememberUserFacts(session, content) {
  const memories = extractUserMemoriesFromText(content);
  if (!memories.length) return;
  const files = {
    globalFile: path.join(paths.dataDir, "orch-memory", "user.json"),
    projectFile: path.join(requireScopedCwd(session.cwd), ".remember", "orchestrator-memory.json"),
  };
  for (const memory of memories) {
    try {
      await rememberMemory(files, memory);
    } catch (error) {
      console.error("auto memory failed:", error.message || error);
    }
  }
}

async function rememberAutopilotDecision(session, decision) {
  try {
    await rememberMemory({
      globalFile: path.join(paths.dataDir, "orch-memory", "user.json"),
      projectFile: path.join(requireScopedCwd(session.cwd), ".remember", "orchestrator-memory.json"),
    }, autopilotMemoryArgs(decision));
  } catch (error) {
    console.error("autopilot memory failed:", error.message || error);
  }
}

async function saveAutopilotDecision(session, decision) {
  return updateSessionForCwd(session.cwd, (fresh) => {
    appendAutopilotHistory(fresh, decision);
    if (decision.action === "message") {
      if (fresh.autopilotEnabled) {
        fresh.autopilotState = transitionWorkflowStatus(
          fresh.autopilotState,
          "completed",
          decision.reason || decision.kind || "",
        );
      }
      return fresh;
    }
    fresh.autopilotEnabled = false;
    fresh.autopilotState = transitionWorkflowStatus(
      fresh.autopilotState,
      "stopped",
      decision.reason || decision.kind || "",
    );
    return fresh;
  });
}

async function saveAutopilotFailure(session, error) {
  return updateSessionForCwd(session.cwd, (fresh) => {
    if (!fresh.autopilotEnabled) return fresh;
    fresh.autopilotEnabled = false;
    fresh.autopilotState = transitionWorkflowStatus(
      fresh.autopilotState,
      "failed",
      errorDetail(error),
    );
    return fresh;
  });
}

async function saveAutopilotRunStarted(session, reason = "Autopilot running") {
  return updateSessionForCwd(session.cwd, (fresh) => {
    if (!fresh.autopilotEnabled) return fresh;
    fresh.autopilotState = transitionWorkflowStatus(
      fresh.autopilotState,
      "running",
      reason,
    );
    return fresh;
  });
}

async function saveAutopilotRunCompleted(session, reason = "Autopilot run completed") {
  return updateSessionForCwd(session.cwd, (fresh) => {
    if (!fresh.autopilotEnabled) return fresh;
    fresh.autopilotState = transitionWorkflowStatus(
      fresh.autopilotState,
      "completed",
      reason,
    );
    return fresh;
  });
}

async function saveAutopilotRunTerminal(session, state, reason) {
  return updateSessionForCwd(session.cwd, (fresh) => {
    if (!fresh.autopilotEnabled) return fresh;
    fresh.autopilotEnabled = false;
    fresh.autopilotState = transitionWorkflowStatus(
      fresh.autopilotState,
      state,
      reason,
    );
    return fresh;
  });
}

function memoryFilesForCwd(cwd) {
  return {
    globalFile: path.join(paths.dataDir, "orch-memory", "user.json"),
    projectFile: path.join(requireScopedCwd(cwd), ".remember", "orchestrator-memory.json"),
  };
}

async function appendUserMessage(session, body) {
  const rawContent = String(body.content || "").trim();
  const content = redactSensitiveText(rawContent);
  const safetyRedacted = content !== rawContent;
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
    safetyRedacted,
    at: new Date().toISOString(),
  });
  await saveSession(session);
  await autoRememberUserFacts(session, content);
  return modelContent;
}

async function handleStreamMessage(req, res, id) {
  const session = await loadSession(id);
  const abortController = new AbortController();
  const activeRun = registerActiveRun(id, session, abortController, "stream");

  const body = await readBody(req).catch((error) => {
    clearActiveRun(id, abortController);
    throw error;
  });
  const clientId = String(body.clientId || "");
  const browserContext = browserContextFromRequest(req, body);
  activeRun.clientId = clientId;
  activeRun.source = body.source === "autopilot" ? "autopilot" : "manual";
  activeRun.lastActivityMs = Date.now();
  const modelContent = await appendUserMessage(session, body).catch((error) => {
    clearActiveRun(id, abortController);
    throw error;
  });
  if (activeRun.source === "autopilot") {
    const saved = await saveAutopilotRunStarted(session, "Autopilot follow-up running");
    Object.assign(session, saved);
  }
  activeRun.session = session;
  activeRun.draft = {
    role: "assistant",
    supervisor: session.supervisor,
    content: "",
    status: "Starting...",
    trace: [],
    timeline: [],
    at: new Date().toISOString(),
    streaming: true,
  };
  activeRun.warnIdle = (remainingMs) => {
    emitRunEvent(res, id, clientId, {
      type: "idle-warning",
      warning: `Autopilot has been idle and will stop in ${Math.ceil(remainingMs / 1000)}s`,
      remainingMs,
      at: new Date().toISOString(),
    });
  };

  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  emitRunEvent(res, id, clientId, { type: "session", session, draft: activeRun.draft });
  emitHookEvent({
    type: "run.start",
    sessionId: id,
    project: session.cwd,
    supervisor: session.supervisor,
    status: "running",
  });

  let transcript = "";
  let usageStarted = false;
  const onOutput = ({ stream, content }) => {
    updateRunActivity(activeRun);
    const safeContent = redactSensitiveText(content);
    transcript += safeContent;
    if (activeRun.draft) {
      activeRun.draft.status = "";
      activeRun.draft.content += safeContent;
    }
    emitRunEvent(res, id, clientId, { type: "chunk", stream, content: safeContent });
  };
  const onTrace = ({ stream = "trace", content }) => {
    updateRunActivity(activeRun);
    const safeContent = redactSensitiveText(content);
    if (activeRun.draft) {
      activeRun.draft.trace ||= [];
      activeRun.draft.trace.push(String(safeContent || ""));
      let totalChars = activeRun.draft.trace.reduce((total, item) => total + item.length, 0);
      while (activeRun.draft.trace.length > 1 && totalChars > 60000) {
        totalChars -= activeRun.draft.trace.shift().length;
      }
    }
    emitRunEvent(res, id, clientId, { type: "trace", stream, content: safeContent, at: new Date().toISOString() });
  };
  const onTask = (event) => {
    updateRunActivity(activeRun);
    if (activeRun.draft) {
      activeRun.draft.timeline = mergeTimelineEvent(activeRun.draft.timeline || [], event);
    }
    emitRunEvent(res, id, clientId, { type: "task", event, at: new Date().toISOString() });
  };

  try {
    usageStarted = true;
    await safelyRecordUsage(`start for ${session.supervisor}`, () => recordRunStart(session.supervisor));
    const answer = await runSupervisor(promptSessionWithoutCurrentUser(session), modelContent, {
      browserContext,
      onOutput,
      onTrace,
      onTask,
      onUsage: captureUsage(session.supervisor),
      signal: abortController.signal,
    });
    const finalAnswer = redactSensitiveText(answer || transcript.trim() || "(empty response)");
    session.messages.push({
      role: "assistant",
      supervisor: session.supervisor,
      content: finalAnswer,
      at: new Date().toISOString(),
      trace: activeRun.draft?.trace || [],
      timeline: activeRun.draft?.timeline || [],
    });
    await saveSession(session);
    if (activeRun.source === "autopilot") {
      const saved = await saveAutopilotRunCompleted(session, "Autopilot follow-up completed");
      Object.assign(session, saved);
    }
    activeRun.session = session;
    activeRun.draft = null;
    emitRunEvent(res, id, clientId, { type: "done", session, message: session.messages.at(-1) });
    emitHookEvent({
      type: "run.end",
      sessionId: id,
      project: session.cwd,
      supervisor: session.supervisor,
      status: "done",
      detail: `${answer?.length || transcript.length || 0} chars`,
    });
    await safelyRecordUsage(`finish for ${session.supervisor}`, () => recordRunEnd(session.supervisor));
  } catch (error) {
    const stopped = abortController.signal.aborted;
    const details = stopped ? runStopReason(abortController.signal) : (error.message || String(error));
    session.messages.push({
      role: "assistant",
      supervisor: session.supervisor,
      content: stopped
        ? [transcript.trim(), details].filter(Boolean).join("\n\n")
        : [transcript.trim(), `Error: ${details}`].filter(Boolean).join("\n\n"),
      at: new Date().toISOString(),
      trace: activeRun.draft?.trace || [],
      timeline: activeRun.draft?.timeline || [],
      error: !stopped,
      stopped,
    });
    await saveSession(session);
    if (activeRun.source === "autopilot") {
      const saved = await saveAutopilotRunTerminal(session, stopped ? "stopped" : "failed", details);
      Object.assign(session, saved);
    }
    activeRun.session = session;
    activeRun.draft = null;
    emitRunEvent(res, id, clientId, { type: stopped ? "stopped" : "error", error: details, session, message: session.messages.at(-1) });
    emitHookEvent({
      type: "run.end",
      sessionId: id,
      project: session.cwd,
      supervisor: session.supervisor,
      status: stopped ? "stopped" : "error",
      detail: details,
    });
    if (usageStarted) {
      await safelyRecordUsage(`finish for ${session.supervisor}`, () => recordRunEnd(session.supervisor, { error: details, stopped }));
    }
  } finally {
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
  const activeRun = registerActiveRun(id, session, abortController, "json");
  let usageStarted = false;
  try {
    const body = await readBody(req);
    activeRun.source = body.source === "autopilot" ? "autopilot" : "manual";
    activeRun.lastActivityMs = Date.now();
    const browserContext = browserContextFromRequest(req, body);
    const modelContent = await appendUserMessage(session, body);
    if (activeRun.source === "autopilot") {
      const saved = await saveAutopilotRunStarted(session, "Autopilot follow-up running");
      Object.assign(session, saved);
    }
    usageStarted = true;
    await safelyRecordUsage(`start for ${session.supervisor}`, () => recordRunStart(session.supervisor));
    emitHookEvent({
      type: "run.start",
      sessionId: id,
      project: session.cwd,
      supervisor: session.supervisor,
      status: "running",
    });
    const answer = await runSupervisor(promptSessionWithoutCurrentUser(session), modelContent, {
      browserContext,
      signal: abortController.signal,
      onUsage: captureUsage(session.supervisor),
    });
    const finalAnswer = redactSensitiveText(answer || "(empty response)");
    session.messages.push({
      role: "assistant",
      supervisor: session.supervisor,
      content: finalAnswer,
      at: new Date().toISOString(),
    });
    await saveSession(session);
    if (activeRun.source === "autopilot") {
      const saved = await saveAutopilotRunCompleted(session, "Autopilot follow-up completed");
      Object.assign(session, saved);
    }
    await safelyRecordUsage(`finish for ${session.supervisor}`, () => recordRunEnd(session.supervisor));
    emitHookEvent({
      type: "run.end",
      sessionId: id,
      project: session.cwd,
      supervisor: session.supervisor,
      status: "done",
      detail: `${answer?.length || 0} chars`,
    });
    completed = true;
    return sendJson(res, 200, { session, message: session.messages.at(-1) });
  } catch (error) {
    if (!abortController.signal.aborted) {
      if (activeRun.source === "autopilot") {
        const saved = await saveAutopilotFailure(session, error);
        Object.assign(session, saved);
      }
      if (usageStarted) {
        await safelyRecordUsage(`finish for ${session.supervisor}`, () => recordRunEnd(session.supervisor, { error: error.message || String(error) }));
      }
      emitHookEvent({
        type: "run.end",
        sessionId: id,
        project: session.cwd,
        supervisor: session.supervisor,
        status: "error",
        detail: error.message || String(error),
      });
      throw error;
    }
    session.messages.push({
      role: "assistant",
      supervisor: session.supervisor,
      content: runStopReason(abortController.signal),
      at: new Date().toISOString(),
      stopped: true,
    });
    await saveSession(session);
    if (activeRun.source === "autopilot") {
      const saved = await saveAutopilotRunTerminal(session, "stopped", runStopReason(abortController.signal));
      Object.assign(session, saved);
    }
    if (usageStarted) await safelyRecordUsage(`stop for ${session.supervisor}`, () => recordRunEnd(session.supervisor, { stopped: true }));
    emitHookEvent({
      type: "run.end",
      sessionId: id,
      project: session.cwd,
      supervisor: session.supervisor,
      status: "stopped",
      detail: runStopReason(abortController.signal),
    });
    completed = true;
    return sendJson(res, 200, { session, message: session.messages.at(-1), stopped: true });
  } finally {
    clearActiveRun(id, abortController);
  }
}

export async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/events") {
    return subscribeEvents(req, res);
  }
  if (req.method === "GET" && url.pathname === "/api/config") {
    return sendJson(res, 200, {
      supervisors,
      defaultSupervisor: runtime.defaultSupervisor,
      allowWrite: runtime.allowWrite,
      workspaceRoot: paths.workspaceRoot,
      promptFile: paths.promptFile,
      supervisorPeers,
      mcpToolCatalog: Object.fromEntries(Object.keys(supervisors).map((id) => [id, mcpToolCatalog(id)])),
      networkMode: runtime.networkMode,
      devServerHost: runtime.devServerHost,
      previewPorts: runtime.previewPorts,
      maxUploadBytes: runtime.maxUploadBytes,
      autopilotFeedLimit: runtime.autopilotFeedLimit,
      autopilotDecisionTimeoutMs: runtime.autopilotDecisionTimeoutMs,
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
  if (req.method === "POST" && url.pathname === "/api/prompts/reset") {
    return sendJson(res, 200, await resetPrompts(await readBody(req)));
  }
  if (req.method === "GET" && url.pathname === "/api/connections") {
    return sendJson(res, 200, { connections: await connectionStatus() });
  }
  if (req.method === "GET" && url.pathname === "/api/usage") {
    return sendJson(res, 200, await usageSnapshot());
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
    if (!session.autopilotEnabled) {
      activeAutopilotRuns.get(session.id)?.abort?.(new Error("Autopilot disabled by user"));
    }
    broadcastRunEvent(session.id, "", {
      type: "autopilot",
      phase: "state",
      project: session.cwd,
      supervisor: session.supervisor,
      session,
      at: new Date().toISOString(),
    });
    return sendJson(res, 200, { session });
  }
  const autopilotHistoryMatch = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})\/autopilot-history$/);
  if (autopilotHistoryMatch && req.method === "DELETE") {
    if (activeRuns.has(autopilotHistoryMatch[1])) {
      throw Object.assign(new Error("Stop the running model before clearing Autopilot activity"), { status: 409 });
    }
    const existing = await loadSession(autopilotHistoryMatch[1]);
    const session = await updateSessionForCwd(existing.cwd, (fresh) => clearAutopilotHistory(fresh));
    broadcastRunEvent(session.id, "", {
      type: "autopilot",
      phase: "history-cleared",
      project: session.cwd,
      supervisor: session.supervisor,
      session,
      at: new Date().toISOString(),
    });
    return sendJson(res, 200, { session });
  }
  const stopMatch = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})\/stop$/);
  if (stopMatch && req.method === "POST") {
    const activeRun = activeRuns.get(stopMatch[1]);
    if (!activeRun) return sendJson(res, 200, { stopped: false });
    activeRun.abortController.abort(new Error("Stopped by user"));
    return sendJson(res, 202, { stopped: true, run: { id: activeRun.id, supervisor: activeRun.supervisor, cwd: activeRun.cwd } });
  }

  const autopilotMatch = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})\/autopilot$/);
  if (autopilotMatch && req.method === "POST") {
    if (activeRuns.has(autopilotMatch[1])) {
      throw Object.assign(new Error("Autopilot waits for the current model run to finish"), { status: 409 });
    }
    if (activeAutopilotRuns.has(autopilotMatch[1])) {
      throw Object.assign(new Error("Autopilot decision is already running"), { status: 409 });
    }
    let session = await loadSession(autopilotMatch[1]);
    if (!workflowCanRun(session.autopilotState, session.autopilotEnabled)) {
      throw Object.assign(new Error(`Autopilot is ${session.autopilotState?.state || "paused"}`), { status: 409 });
    }
    session = await saveAutopilotRunStarted(session, "Autopilot decision running");
    const decisionTimeout = createAutopilotDecisionTimeout(session);
    activeAutopilotRuns.set(session.id, { signal: decisionTimeout.signal, abort: decisionTimeout.abort });
    broadcastRunEvent(session.id, "", {
      type: "autopilot",
      phase: "thinking",
      project: session.cwd,
      supervisor: session.supervisor,
      session,
      at: new Date().toISOString(),
    });
    try {
      const result = await decideAutopilotNextWithRetry(session, {
        signal: decisionTimeout.signal,
        config: autopilotRetryConfig,
        getSession: async (current) => {
          const fresh = await loadSession(current.id);
          if (!workflowCanRun(fresh.autopilotState, fresh.autopilotEnabled)) {
            throw Object.assign(new Error(`Autopilot is ${fresh.autopilotState?.state || "paused"}`), { status: 409 });
          }
          return fresh;
        },
        onRetry: ({ nextAttempt, attempts, delayMs, error }) => {
          broadcastRunEvent(session.id, "", {
            type: "autopilot",
            phase: "retry",
            project: session.cwd,
            supervisor: session.supervisor,
            attempt: nextAttempt,
            attempts,
            delayMs,
            error: errorDetail(error, 300),
            at: new Date().toISOString(),
          });
        },
      });
      session = result.session;
      const decision = result.decision;
      const saved = await saveAutopilotDecision(session, decision);
      void rememberAutopilotDecision(session, decision);
      emitHookEvent({
        type: "autopilot.decision",
        sessionId: session.id,
        project: session.cwd,
        supervisor: session.supervisor,
        status: decision.action,
        detail: decision.reason || decision.kind || "",
      });
      broadcastRunEvent(session.id, "", {
        type: "autopilot",
        phase: "decision",
        project: saved.cwd,
        supervisor: saved.supervisor,
        decision,
        session: saved,
        at: new Date().toISOString(),
      });
      return sendJson(res, 200, { decision, session: saved });
    } catch (error) {
      const stopped = decisionTimeout.signal?.aborted;
      const saved = await (stopped
        ? saveAutopilotRunTerminal(session, "stopped", runStopReason(decisionTimeout.signal))
        : saveAutopilotFailure(session, error)
      ).catch((saveError) => {
        console.error("autopilot state save failed:", saveError.message || saveError);
        return session;
      });
      broadcastRunEvent(session.id, "", {
        type: "autopilot",
        phase: "error",
        project: saved.cwd,
        supervisor: saved.supervisor,
        error: error.message || String(error),
        session: saved,
        at: new Date().toISOString(),
      });
      throw error;
    } finally {
      decisionTimeout.clear();
      activeAutopilotRuns.delete(session.id);
    }
  }

  if (req.method === "GET" && url.pathname === "/api/hooks/events") {
    return sendJson(res, 200, {
      events: await listHookEvents({
        limit: url.searchParams.get("limit") || 100,
        project: url.searchParams.get("project") || "",
        sessionId: url.searchParams.get("sessionId") || "",
      }),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/memory") {
    const cwd = url.searchParams.get("cwd") || ".";
    return sendJson(res, 200, {
      memory: await readMemory(memoryFilesForCwd(cwd), {
        scope: url.searchParams.get("scope") || "all",
        namespace: url.searchParams.get("namespace") || "all",
        query: url.searchParams.get("query") || "",
        limit: url.searchParams.get("limit") || 25,
      }),
    });
  }

  const streamMessageMatch = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})\/messages\/stream$/);
  if (streamMessageMatch && req.method === "POST") return handleStreamMessage(req, res, streamMessageMatch[1]);

  const messageMatch = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})\/messages$/);
  if (messageMatch && req.method === "POST") return handleJsonMessage(req, res, messageMatch[1]);

  return sendJson(res, 404, { error: "Not found" });
}
