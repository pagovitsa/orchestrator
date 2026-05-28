import { runtime } from "../config/env.js";
import { redactSensitiveText } from "./safety.js";

const AUTOPILOT_MODEL = "deepseek-v4-pro";
const MAX_DECISION_CHARS = 6000;
const MAX_ERROR_BODY_CHARS = 1000;
const MAX_FEED_REASON_CHARS = 80;
const RECENT_TRANSCRIPT_LIMIT = 16;
const TRANSIENT_ERROR_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
function latestAssistantMessage(session) {
  return [...(session.messages || [])].reverse().find((message) => message.role === "assistant") || null;
}

function messageContent(message) {
  return String(message?.modelContent || message?.content || "").trim();
}

function recentTranscript(session, limit = RECENT_TRANSCRIPT_LIMIT) {
  return (session.messages || [])
    .slice(-limit)
    .map((message) => {
      const speaker = message.role === "assistant"
        ? `assistant/${message.supervisor || session.supervisor || "unknown"}`
        : "user";
      return `${speaker.toUpperCase()}:\n${messageContent(message)}`;
    })
    .join("\n\n");
}

function hasRunError(message) {
  // Caller is responsible for guarding the no-assistant-message case; treating "no message" as
  // "error" was wedging fresh sessions with a misleading reason.
  if (!message) return false;
  if (message.error || message.stopped) return true;
  return /^\s*(error|command failed|uncaught|traceback)\b/i.test(String(message.content || ""));
}

function hasPushAuthBlocker(message) {
  const content = assistantContent(message);
  if (!content) return false;
  const hasGitPush = /\bgit push\b/i.test(content);
  const hasPublicKeyDenied = /\bpermission denied\s*\(publickey\)/i.test(content);
  const mentionsMissingToken = /(?:\b(no|neither)\b[\s\S]{0,80}\b(GITHUB_TOKEN|GH_TOKEN)\b)|(?:\b(GITHUB_TOKEN|GH_TOKEN)\b[\s\S]{0,80}\b(absent|missing|not present)\b)/i.test(content);
  const asksForAuth = /\b(next unblock step|provide|install|configure|expose|set)\b[\s\S]{0,80}\b(auth|credential|credentials|token|tokens|ssh key|github push auth)\b/i.test(content);
  return hasGitPush && (hasPublicKeyDenied || mentionsMissingToken) && asksForAuth;
}

function assistantContent(message) {
  return messageContent(message);
}

function extractJsonObject(text) {
  const value = String(text || "").trim();
  if (!value) throw new Error("DeepSeek returned an empty autopilot decision");
  try {
    return JSON.parse(value);
  } catch {
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced);
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(value.slice(start, end + 1));
    throw new Error("DeepSeek autopilot decision was not valid JSON");
  }
}

export function parseAutopilotDecision(text) {
  const parsed = extractJsonObject(text);
  const action = String(parsed.action || "").trim().toLowerCase();
  const kind = String(parsed.kind || "").trim().toLowerCase();
  const reason = String(parsed.reason || "").trim();
  const rawContent = String(parsed.content || parsed.message || "").trim();

  if (action === "stop") {
    return { action: "stop", kind: kind || "stop", reason: reason || "Autopilot stopped" };
  }

  if (["message", "answer", "continue"].includes(action) || rawContent) {
    const content = rawContent;
    if (!content) return { action: "stop", kind: "stop", reason: reason || "Autopilot returned no next message" };
    return {
      action: "message",
      kind: kind || (action === "answer" ? "answer" : "continue"),
      content: content.slice(0, MAX_DECISION_CHARS),
      reason,
    };
  }

  return { action: "stop", kind: "stop", reason: reason || "Autopilot returned no next message" };
}

export function normalizeAutopilotDecision(decision) {
  if (decision?.action === "message") return decision;
  return decision;
}

function autopilotPrompt(session, lastAssistant) {
  return [
    "You are Orch UI Autopilot. You decide the next USER message for a coding supervisor.",
    "Return ONLY compact JSON. No markdown, no prose outside JSON.",
    "",
    "Rules:",
    "- First read the latest messages as the context window. Use them to form an accurate picture of the project state before deciding.",
    "- Judge the latest assistant message in that context, not in isolation.",
    "- If the last assistant message is an app/model error, failed login, auth failure, missing credential, timeout, permission failure, blocked state, completed task, or asks for destructive/human approval, return {\"action\":\"stop\",\"reason\":\"...\"}.",
    "- If the last assistant asks a low-risk, non-approval question, choose the safest useful answer for the project and return {\"action\":\"message\",\"kind\":\"answer\",\"content\":\"...\",\"reason\":\"...\"}.",
    "- Never answer questions that involve destructive changes, secrets, credentials, billing, deployment, production access, force-push, or history rewrites.",
    "- If the last assistant still leaves a clear, concrete, reversible next step, return {\"action\":\"message\",\"kind\":\"continue\",\"content\":\"...\",\"reason\":\"...\"}.",
    "- If that next step is for the user to provide credentials, auth tokens, SSH keys, or manual authentication, stop instead even if the assistant labels it as a next unblock step.",
    "- For continue, tell the supervisor the specific next step, require verification, and avoid generic continue-only instructions.",
    "- Otherwise, stop.",
    "- Keep content concise but actionable. It will be sent automatically to the active supervisor as the next user message.",
    "",
    `Project: ${session.cwd || session.project || "."}`,
    `Supervisor to answer: ${session.supervisor || "unknown"}`,
    "",
    `Latest messages for context (oldest to newest, last ${RECENT_TRANSCRIPT_LIMIT} max):`,
    recentTranscript(session),
    "",
    "Last assistant message to judge:",
    assistantContent(lastAssistant),
  ].join("\n");
}

export function appendAutopilotHistory(session, decision) {
  session.autopilotHistory = Array.isArray(session.autopilotHistory) ? session.autopilotHistory : [];
  const entry = {
    at: new Date().toISOString(),
    action: decision?.action || "stop",
    kind: decision?.kind || "",
    reason: redactSensitiveText(String(decision?.reason || "")).slice(0, 800),
    content: redactSensitiveText(String(decision?.content || "")).slice(0, 1200),
  };
  session.autopilotHistory.push(entry);
  session.autopilotHistory = session.autopilotHistory.slice(-50);
  return entry;
}

export function autopilotFeedLimit(limit = runtime.autopilotFeedLimit) {
  const value = Number(limit);
  if (!Number.isFinite(value)) return 2;
  return Math.max(0, Math.min(10, Math.round(value)));
}

export function summarizeAutopilotFeed(history, { limit = runtime.autopilotFeedLimit } = {}) {
  const max = autopilotFeedLimit(limit);
  if (!Array.isArray(history) || max <= 0) return [];
  return history
    .slice(-max)
    .reverse()
    .map((entry) => ({
      at: String(entry?.at || ""),
      action: String(entry?.action || "stop").slice(0, 32),
      kind: String(entry?.kind || entry?.action || "stop").slice(0, 32),
      reason: redactSensitiveText(String(entry?.reason || "")).slice(0, MAX_FEED_REASON_CHARS),
    }));
}

export function clearAutopilotHistory(session) {
  session.autopilotHistory = [];
  session.autopilotFeed = [];
  return session;
}

export function autopilotMemoryArgs(decision) {
  const action = decision?.action || "stop";
  const kind = decision?.kind || action;
  const reason = redactSensitiveText(String(decision?.reason || "")).trim();
  const text = [`Autopilot ${action}/${kind}`, reason ? `reason: ${reason}` : ""].filter(Boolean).join(" - ");
  return {
    scope: "project",
    kind: "decision",
    namespace: "autopilot",
    text,
    tags: ["autopilot", kind].filter(Boolean),
    source: "orch-ui autopilot",
  };
}

export function normalizeAutopilotRetryConfig({
  attempts = runtime.autopilotRetryAttempts,
  backoffMs = runtime.autopilotRetryBackoffMs,
} = {}) {
  const normalizedAttempts = Number.isFinite(Number(attempts)) ? Math.max(1, Math.round(Number(attempts))) : 1;
  const normalizedBackoff = Number.isFinite(Number(backoffMs)) ? Math.max(0, Math.round(Number(backoffMs))) : 0;
  return { attempts: normalizedAttempts, backoffMs: normalizedBackoff };
}

export function isRetriableAutopilotError(error) {
  if (!error) return false;
  if (error.name === "AbortError") return false;
  const status = Number(error.status || error.statusCode || 0);
  if (status === 429 || status >= 500) return true;
  if (status >= 400) return false;
  if (TRANSIENT_ERROR_CODES.has(error.code)) return true;
  if (TRANSIENT_ERROR_CODES.has(error.cause?.code)) return true;
  return error instanceof TypeError;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error("Autopilot retry aborted"), { name: "AbortError" });
}

function sleepWithAbort(ms, signal) {
  throwIfAborted(signal);
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error("Autopilot retry aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function decideAutopilotNextWithRetry(session, {
  signal,
  config = {},
  decide = decideAutopilotNext,
  getSession,
  onRetry,
} = {}) {
  const retry = normalizeAutopilotRetryConfig(config);
  let currentSession = session;
  let lastError;

  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    throwIfAborted(signal);
    if (attempt > 1 && getSession) currentSession = await getSession(currentSession);
    try {
      const decision = await decide(currentSession, { signal, attempt });
      return { decision, session: currentSession, attempts: attempt };
    } catch (error) {
      lastError = error;
      throwIfAborted(signal);
      if (attempt >= retry.attempts || !isRetriableAutopilotError(error)) throw error;
      // Full jitter: pick uniformly in [base/2, base]. Without jitter, multiple sessions backing
      // off a shared 429 wake up simultaneously and hammer the endpoint together.
      const base = retry.backoffMs * (2 ** (attempt - 1));
      const delayMs = Math.round(base * (0.5 + Math.random() * 0.5));
      onRetry?.({
        attempt,
        nextAttempt: attempt + 1,
        attempts: retry.attempts,
        delayMs,
        error,
      });
      await sleepWithAbort(delayMs, signal);
    }
  }

  throw lastError || new Error("Autopilot retry exhausted");
}

export async function decideAutopilotNext(session, { signal } = {}) {
  const lastAssistant = latestAssistantMessage(session);
  if (!lastAssistant) {
    return { action: "stop", kind: "stop", reason: "No assistant message to evaluate yet" };
  }
  if (hasRunError(lastAssistant)) {
    return { action: "stop", kind: "stop", reason: "Last assistant message is an error or stopped run" };
  }
  if (hasPushAuthBlocker(lastAssistant)) {
    return { action: "stop", kind: "stop", reason: "Assistant indicates git push authentication is blocked and needs manual credentials" };
  }
  if (!runtime.deepseekApiKey) {
    throw Object.assign(new Error("DeepSeek API key is required for Autopilot"), { status: 409 });
  }

  const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${runtime.deepseekApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: AUTOPILOT_MODEL,
      temperature: 0.1,
      max_tokens: 1200,
      messages: [
        {
          role: "system",
          content: "You are a strict JSON autopilot planner for a coding chat UI. Return only JSON.",
        },
        { role: "user", content: autopilotPrompt(session, lastAssistant) },
      ],
    }),
    signal,
  });

  const body = await response.text();
  if (!response.ok) {
    const details = body.length > MAX_ERROR_BODY_CHARS
      ? `${body.slice(0, MAX_ERROR_BODY_CHARS)}...`
      : body;
    throw Object.assign(new Error(`DeepSeek autopilot HTTP ${response.status}: ${details}`), { status: response.status });
  }
  // A 2xx with a non-JSON body (proxy error page, truncated response) would otherwise throw a
  // bare SyntaxError that the retry classifier does not recognise; wrap it as an HTTP-style
  // failure so the caller can surface it consistently.
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    const snippet = body.length > MAX_ERROR_BODY_CHARS ? `${body.slice(0, MAX_ERROR_BODY_CHARS)}...` : body;
    throw Object.assign(new Error(`DeepSeek autopilot returned non-JSON body: ${error.message} :: ${snippet}`), { status: 502 });
  }
  const content = parsed.choices?.[0]?.message?.content || "";
  return parseAutopilotDecision(content);
}
