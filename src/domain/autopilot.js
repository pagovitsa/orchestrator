import { runtime } from "../config/env.js";

const AUTOPILOT_MODEL = "deepseek-v4-pro";
const MAX_DECISION_CHARS = 6000;
const MAX_ERROR_BODY_CHARS = 1000;
const TRANSIENT_ERROR_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
const FALLBACK_CONTINUE_MESSAGE = [
  "Autopilot:",
  "Συνέχισε με προσοχή και απόλυτη προσήλωση στο project.",
  "Προχώρησε στο επόμενο λογικό βήμα, επαλήθευσε ό,τι αλλάζεις, και ρώτα μόνο αν υπάρχει πραγματικό blocker ή χρειάζεται ανθρώπινη έγκριση.",
].join("\n");

const BLOCKING_APPROVAL_PATTERN = /\b(confirm|approve|approval|permission|human approval|destructive|delete|remove|drop|wipe|force[- ]?push|rewrite history|deploy|production|billing|payment|secret|credential)\b/i;
const QUESTION_PATTERN = /[?？]\s*$|(?:\b(should i|do you want|would you like|shall i|can i|may i|please confirm|which option|what would you like)\b)/i;

function latestAssistantMessage(session) {
  return [...(session.messages || [])].reverse().find((message) => message.role === "assistant") || null;
}

function recentTranscript(session, limit = 10) {
  return (session.messages || [])
    .slice(-limit)
    .map((message) => {
      const speaker = message.role === "assistant"
        ? `assistant/${message.supervisor || session.supervisor || "unknown"}`
        : "user";
      return `${speaker.toUpperCase()}:\n${message.modelContent || message.content || ""}`;
    })
    .join("\n\n");
}

function hasRunError(message) {
  if (!message) return true;
  if (message.error || message.stopped) return true;
  return /^\s*(error|command failed|uncaught|traceback)\b/i.test(String(message.content || ""));
}

function assistantContent(message) {
  return String(message?.modelContent || message?.content || "").trim();
}

function shouldForceContinue(lastAssistant) {
  if (hasRunError(lastAssistant)) return false;
  const content = assistantContent(lastAssistant);
  if (!content) return false;
  if (BLOCKING_APPROVAL_PATTERN.test(content)) return false;
  if (QUESTION_PATTERN.test(content)) return false;
  return true;
}

function fallbackContinueDecision(reason = "") {
  return {
    action: "message",
    kind: "continue",
    content: FALLBACK_CONTINUE_MESSAGE,
    reason: reason || "Assistant finished without a blocker; autopilot continues the project.",
  };
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
    const content = rawContent || FALLBACK_CONTINUE_MESSAGE;
    return {
      action: "message",
      kind: kind || (action === "answer" ? "answer" : "continue"),
      content: content.slice(0, MAX_DECISION_CHARS),
      reason,
    };
  }

  return { action: "stop", kind: "stop", reason: reason || "Autopilot returned no next message" };
}

export function normalizeAutopilotDecision(decision, lastAssistant) {
  if (decision?.action === "message") return decision;
  if (shouldForceContinue(lastAssistant)) {
    return fallbackContinueDecision(decision?.reason ? `Forced continue after non-blocking stop: ${decision.reason}` : "");
  }
  return decision;
}

function autopilotPrompt(session, lastAssistant) {
  return [
    "You are Orch UI Autopilot. You decide the next USER message for a coding supervisor.",
    "Return ONLY compact JSON. No markdown, no prose outside JSON.",
    "",
    "Rules:",
    "- If the last assistant message is an app/model error, failed login, auth failure, missing credential, timeout, permission failure, or asks for destructive/human approval, return {\"action\":\"stop\",\"reason\":\"...\"}.",
    "- If the last assistant asks the user a question, choose the safest useful answer for the project and return {\"action\":\"message\",\"kind\":\"answer\",\"content\":\"...\",\"reason\":\"...\"}.",
    "- The answer should act like a careful project owner: prefer reversible steps, no destructive approval, no fake secrets, no guessy external commitments.",
    "- If the last assistant simply finished a phase or reported completion without a blocking question/error, return {\"action\":\"message\",\"kind\":\"continue\",\"content\":\"...\",\"reason\":\"...\"}.",
    "- For continue, tell the supervisor to continue carefully and with absolute focus on the project, verify changes, and proceed to the next logical step.",
    "- Keep content concise but actionable. It will be sent automatically to the active supervisor as the next user message.",
    "",
    `Project: ${session.cwd || session.project || "."}`,
    `Supervisor to answer: ${session.supervisor || "unknown"}`,
    "",
    "Recent conversation:",
    recentTranscript(session),
    "",
    "Last assistant message to judge:",
    lastAssistant.content || "",
  ].join("\n");
}

export function appendAutopilotHistory(session, decision) {
  session.autopilotHistory = Array.isArray(session.autopilotHistory) ? session.autopilotHistory : [];
  const entry = {
    at: new Date().toISOString(),
    action: decision?.action || "stop",
    kind: decision?.kind || "",
    reason: String(decision?.reason || "").slice(0, 800),
    content: String(decision?.content || "").slice(0, 1200),
  };
  session.autopilotHistory.push(entry);
  session.autopilotHistory = session.autopilotHistory.slice(-50);
  return entry;
}

export function autopilotMemoryArgs(decision) {
  const action = decision?.action || "stop";
  const kind = decision?.kind || action;
  const reason = String(decision?.reason || "").trim();
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
      const delayMs = retry.backoffMs * (2 ** (attempt - 1));
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
  if (hasRunError(lastAssistant)) {
    return { action: "stop", kind: "stop", reason: "Last assistant message is an error or stopped run" };
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
  const parsed = JSON.parse(body);
  const content = parsed.choices?.[0]?.message?.content || "";
  let decision;
  try {
    decision = parseAutopilotDecision(content);
  } catch (error) {
    if (shouldForceContinue(lastAssistant)) {
      return fallbackContinueDecision(`Forced continue after invalid DeepSeek decision: ${error.message}`);
    }
    throw error;
  }
  return normalizeAutopilotDecision(decision, lastAssistant);
}
