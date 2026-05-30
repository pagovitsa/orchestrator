import { runtime } from "../config/env.js";
import { redactSensitiveText } from "./safety.js";

const MAX_FEED_REASON_CHARS = 80;
const TRANSIENT_ERROR_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
const AUTOPILOT_IDLE_TIMEOUT_PATTERN = /\bautopilot idle timeout\b/i;

export function isAutopilotIdleTimeoutMessage(message) {
  if (!message?.stopped) return false;
  return AUTOPILOT_IDLE_TIMEOUT_PATTERN.test(messageContent(message));
}

export function isAutopilotUserMessage(message) {
  return message?.role === "user" && /^autopilot\s*:/i.test(messageContent(message));
}

export function isAutopilotRunFailureMessage(message) {
  if (!message || message.role !== "assistant") return false;
  return Boolean(message.error || message.stopped);
}

export function consecutiveAutopilotRunFailures(session) {
  let count = 0;
  for (const message of [...(session?.messages || [])].reverse()) {
    if (message.role !== "assistant") continue;
    if (!isAutopilotRunFailureMessage(message)) break;
    count += 1;
  }
  return count;
}

function latestAssistantMessage(session) {
  return [...(session.messages || [])]
    .reverse()
    .find((message) => message.role === "assistant" && !isAutopilotIdleTimeoutMessage(message))
    || null;
}

function messageContent(message) {
  return String(message?.modelContent || message?.content || "").trim();
}

function hasRunError(message) {
  // Caller is responsible for guarding the no-assistant-message case; treating "no message" as
  // "error" was wedging fresh sessions with a misleading reason.
  if (!message) return false;
  return isAutopilotRunFailureMessage(message);
}

function assistantContent(message) {
  return messageContent(message);
}

function normalizedLine(text) {
  return String(text || "")
    .replace(/[`\*_]/g, "")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function riskyAutopilotTask(text) {
  return /\b(secret|credential|credentials|token|password|api key|billing|production|prod|deploy|release|force[- ]?push|history rewrite|delete backups?|drop database|destructive)\b/i
    .test(String(text || ""))
    || /\b(git\s+push|push(?:ing)?\s+(?:to|remote|origin|github)|remote\s+(?:write|publish|push)|publish(?:ing)?\s+(?:to|remote|github)|create\s+(?:a\s+)?(?:github\s+)?repo)\b/i
    .test(String(text || ""));
}

function cleanCandidateTask(text) {
  const candidate = normalizedLine(text);
  if (!candidate || riskyAutopilotTask(candidate)) return "";
  return candidate;
}

function extractExplicitNextStage(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = normalizedLine(lines[index]).replace(/^#{1,6}\s+/, "");
    const colonMatch = line.match(/^(?:next|upcoming|remaining)\s+(?:(?:safe|concrete|autonomous|local-only|planned|plan)\s+)*(?:stage|phase|step|item)(?:\s+(?:of|from|according to)\s+(?:the\s+)?(?:plan|design|roadmap))?\s*[:=-]\s*(.+)$/i);
    const remainsMatch = line.match(/^(?:next|upcoming)\s+(?:(?:safe|concrete|autonomous|local-only|planned|plan)\s+)*(?:stage|phase|step|item)\s+(?:is|remains)\s+(.+)$/i);
    const candidate = cleanCandidateTask(colonMatch?.[1] || remainsMatch?.[1] || "");
    if (candidate) return candidate;

    if (/^(?:next|upcoming|remaining)\s+(?:(?:safe|concrete|autonomous|local-only|planned|plan)\s+)*(?:stage|phase|step|item)\b/i.test(line)) {
      for (let next = index + 1; next < Math.min(lines.length, index + 5); next += 1) {
        const trimmed = lines[next].trim();
        const bullet = trimmed.match(/^[-*]\s+(.+)$/) || trimmed.match(/^\d+[.)]\s+(.+)$/);
        const followup = cleanCandidateTask(bullet?.[1] || trimmed);
        if (followup) return followup;
      }
    }
  }
  return "";
}

function extractSuggestedNextTask(text) {
  const lines = String(text || "").split(/\r?\n/);
  const markerIndex = lines.findIndex((line) => (
    /\b(remaining work|remaining useful next phases?|remaining next phases?|useful next phases?|next phases?|remaining useful next steps?|next steps?|follow[- ]?ups?|todo|outstanding work|remaining tasks?)\b/i
      .test(line)
  ));
  if (markerIndex < 0) return "";
  const start = markerIndex + 1;
  const end = Math.min(lines.length, start + 12);

  for (let index = start; index < end; index += 1) {
    const trimmed = lines[index].trim();
    const match = trimmed.match(/^[-*]\s+(.+)$/) || trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (!match) continue;
    const candidate = cleanCandidateTask(match[1]);
    if (candidate) return candidate;
  }

  return "";
}

function extractPlannedNextStage(text) {
  return extractExplicitNextStage(text) || extractSuggestedNextTask(text);
}

function looksLikeVerificationOrReviewTask(text) {
  return /\b(browser\s+)?verification\b|\bverify\b|\b(code\s+)?review\b|\bregression\b|\bsmoke\b|\bhealth\s+check\b|\bconsole cleanliness\b|\bfocus trap\b|\bscroll[- ]lock\b|\breduced[- ]motion\b|\btop[- ]layer\b|\btype[- ]?check\b|\blint\b/i
    .test(String(text || ""));
}

function mentionsManualAuth(text) {
  return /\b(auth|authenticate|login|credential|credentials|token|tokens|ssh key|api key|manual authentication)\b|(?:GITHUB|GH)_TOKEN/i
    .test(String(text || ""));
}

function mentionsRiskyApproval(text) {
  return /\b(approval|confirm|permission)\b[\s\S]{0,120}\b(delete|destructive|production|prod|deploy|release|force[- ]?push|history rewrite|billing)\b/i
    .test(String(text || ""));
}

function mentionsDockerGate(text) {
  return /\b(docker|compose|testcontainers?|container(?:s)?|full .*test(?:s| suite)|merge gate)\b/i
    .test(String(text || ""));
}

function fallbackContinuationContent(lastAssistant) {
  const content = assistantContent(lastAssistant);
  const nextTask = extractPlannedNextStage(content);
  if (nextTask) {
    if (looksLikeVerificationOrReviewTask(nextTask)) {
      return `Continue with the next stage of the current plan: ${nextTask}. Run that verification/review against the live project. Do not invent a code change just to satisfy Autopilot; only make the smallest fix if the check exposes a concrete defect, then verify and commit it. If no files change, report the evidence and leave the tree clean.`;
    }
    return `Continue with the next stage of the current plan: ${nextTask}. Implement it end to end, run targeted verification, and report what changed.`;
  }
  if (mentionsManualAuth(content)) {
    return "Do not wait for credentials or manual authentication. Choose the safest local-only next step that avoids secrets and remote write access, verify it, and report any remaining auth blocker separately.";
  }
  if (mentionsRiskyApproval(content)) {
    return "Choose the safest reversible path that avoids destructive changes, production deployment, force-push, and history rewrites. Continue with local inspection or tests, then report the decision and result.";
  }
  if (mentionsDockerGate(content)) {
    return "Docker is available inside the orch-ui supervisor container. Verify Docker with `docker version` and `docker compose version`, then run the project's Docker/testcontainers verification or merge gate. If Docker itself fails, report that concrete tool/app error instead of saying Docker is unavailable.";
  }
  return "Review the latest result, repo state, and any existing plan. If there is no explicit next stage, identify or update the plan first, then continue with the next safest concrete stage. Run targeted verification and report the decision and result.";
}

function continuationStepPolicy(continuation) {
  if (/do not invent a code change/i.test(continuation)) {
    return "Keep the step small and reversible; commit only if you changed files.";
  }
  return "If a file change is required, make one small, reversible change, run its verification, and commit it locally before the next step. If the safest next step is inspection or verification only, do not invent a change; report concrete evidence and leave the tree clean.";
}

// (2) Goal anchor: the original objective is the first real human message of the chat (autopilot's
// own injected user turns are skipped). Re-stating it on every continuation keeps the supervisor from
// drifting into self-invented, error-prone scope.
function originalObjective(session) {
  const first = (session?.messages || []).find(
    (message) => message.role === "user" && !isAutopilotUserMessage(message) && messageContent(message),
  );
  return first ? messageContent(first).replace(/\s+/g, " ").slice(0, 300) : "";
}

function objectiveReminder(session) {
  const objective = originalObjective(session);
  return objective ? ` Keep the original objective in focus: "${objective}".` : "";
}

// (1) Heuristic: the last turn describes an edit that actually happened (past tense, specific), not a
// plan ("I will add ...") or a summary. Used to decide whether a verification step is owed.
function describesCodeChange(text) {
  return /\b(edited|implemented|refactored|rewrote|wrote|modified|patched|applied the (patch|change|diff)|added (a|an|the|new)\b|changed the\b|fixed the\b|created (a|an|the|new)\b)/i
    .test(String(text || ""));
}

// (1) Heuristic: the text shows the project checks were actually EXERCISED — a runner was invoked or a
// concrete result/exit code/emoji is present. Deliberately strict: bare intent ("the tests should
// pass") must NOT count, or the gate becomes a no-op that never asks for real verification.
function showsVerificationEvidence(text) {
  const value = String(text || "");
  return (
    /\b(npm|yarn|pnpm)\s+(run\s+)?(test|lint|build|check|typecheck)\b/i.test(value)
    || /\b(pytest|jest|mocha|vitest|tsc|eslint|cargo\s+(test|build|check)|go\s+test|make\s+(test|check|lint))\b/i.test(value)
    || /\bgit\s+diff\s+--check\b[\s\S]{0,120}\b(pass(ed)?|exit(?:ed)?\s+0|clean)\b/i.test(value)
    || /\bexit\s+code\s+\d+\b/i.test(value)
    || /\b\d+\s*(\/\s*\d+)?\s+(tests?|specs?|checks?|assertions?|examples?)\b/i.test(value)
    || /\b\d+\s+(passed|failed|passing|failing|pending|skipped)\b/i.test(value)
    || /\b(tests?|checks?|build|suite|lint|type[- ]?check|compilation)\s+(passed|failed|succeeded|errored|broke)\b/i.test(value)
    || /\b(all|every)\s+(tests?|checks?|specs?)\s+(pass(ed)?|green)\b/i.test(value)
    || /\bcompiled successfully\b|\bbuild (succeeded|passed)\b|\bno (errors|failures)\b/i.test(value)
    || /[✓✗✅❌]/.test(value)
  );
}

// (1+D) A clear recap that verification already happened. Lets the gate skip "I edited X and already
// verified it" recaps without weakening the gate for genuinely unverified changes.
function mentionsAlreadyVerified(text) {
  return /\b(already|just|have|has been)\s+(verified|tested)\b|\b(verified|tested)\s+(it|this|that|the change)\b|\btests?\s+already\s+(pass|passed|green)\b/i
    .test(String(text || ""));
}

function normalizeForCompare(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[`*_>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Token-set (Jaccard) similarity in [0,1]. Cheap and good enough to catch "the supervisor said almost
// the same thing again" without pulling in a dependency.
function similarityRatio(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let intersection = 0;
  for (const token of ta) if (tb.has(token)) intersection += 1;
  const union = ta.size + tb.size - intersection;
  return union ? intersection / union : 0;
}

// The most recent real assistant answers (newest first), skipping idle-timeout markers and failures.
function recentRealAnswers(session, limit = 2) {
  const answers = [];
  for (const message of [...(session?.messages || [])].reverse()) {
    if (message.role !== "assistant") continue;
    if (isAutopilotIdleTimeoutMessage(message) || message.error || message.stopped) continue;
    answers.push(normalizeForCompare(messageContent(message)));
    if (answers.length >= limit) break;
  }
  return answers;
}

// (5) No-progress breaker: the last two substantial answers are near-duplicates, so the supervisor is
// spinning. Two guards keep this from firing on legitimate iterative refinement (where each turn
// shares vocabulary but adds real new work): a high similarity floor AND a requirement that the newer
// answer introduces almost no new tokens. Tuned conservatively — a false fire derails real progress,
// which is the opposite of the goal, so we only trip on genuine repetition.
function looksLikeNoProgress(session) {
  const answers = recentRealAnswers(session, 2);
  if (answers.length < 2) return false;
  if (answers[0].length < 40 || answers[1].length < 40) return false;
  if (similarityRatio(answers[0], answers[1]) < 0.9) return false;
  const newer = new Set(answers[0].split(" ").filter(Boolean));
  const older = new Set(answers[1].split(" ").filter(Boolean));
  let novel = 0;
  for (const token of newer) if (!older.has(token)) novel += 1;
  const novelRatio = newer.size ? novel / newer.size : 0;
  return novelRatio < 0.15;
}

function runFailureRecoveryContent(lastAssistant, failureCount = 1) {
  const details = assistantContent(lastAssistant).replace(/\s+/g, " ").slice(0, 280);
  return [
    `The previous supervisor run failed before a normal final answer was saved (${failureCount}/3).`,
    details ? `Observed failure: ${details}` : "",
    "Do not stop yet. Inspect the current repo state, usage/tool status, and any partial changes; choose the smallest safe recovery step, avoid repeating the exact failing command unchanged, run targeted verification, and report the concrete result.",
  ].filter(Boolean).join(" ");
}

export function autopilotNeedsDecision(session) {
  if (!session?.autopilotEnabled || !Array.isArray(session.messages)) return false;
  const workflowState = String(session.autopilotState?.state || "created").toLowerCase();
  if (!["created", "completed"].includes(workflowState)) return false;
  const enabledAt = Date.parse(session.autopilotState?.updatedAt || "");
  const enabledAfterHistoryReset = workflowState === "created"
    && /autopilot enabled/i.test(String(session.autopilotState?.reason || ""))
    && Number.isFinite(enabledAt);
  const lastMessage = session.messages.at(-1);
  const failureCount = consecutiveAutopilotRunFailures(session);
  const recoveringFromIdleTimeout = isAutopilotIdleTimeoutMessage(lastMessage);
  const recoveringFromRunFailure = isAutopilotRunFailureMessage(lastMessage) && failureCount > 0 && failureCount < 3;
  const retryingInterruptedFollowup = isAutopilotUserMessage(lastMessage);
  if (
    (!["assistant", "user"].includes(lastMessage?.role) || (lastMessage.role === "user" && !retryingInterruptedFollowup))
    || lastMessage.streaming
    || ((lastMessage.error || lastMessage.stopped) && !recoveringFromIdleTimeout && !recoveringFromRunFailure)
  ) return false;
  const lastAssistantAt = Date.parse(lastMessage.at || "");
  const lastHistory = Array.isArray(session.autopilotHistory) ? session.autopilotHistory.at(-1) : null;
  const lastHistoryAt = Date.parse(lastHistory?.at || "");
  if (
    String(lastHistory?.action || "").toLowerCase() === "stop"
    && Number.isFinite(lastHistoryAt)
    && (!Number.isFinite(lastAssistantAt) || lastHistoryAt >= lastAssistantAt)
    && (!enabledAfterHistoryReset || lastHistoryAt >= enabledAt)
  ) return false;
  const decisionTimes = Array.isArray(session.autopilotHistory)
    ? session.autopilotHistory
      .map((entry) => Date.parse(entry?.at || ""))
      .filter((time) => Number.isFinite(time) && (!enabledAfterHistoryReset || time >= enabledAt))
    : [];
  const lastDecisionAt = decisionTimes.length ? Math.max(...decisionTimes) : 0;
  return !Number.isFinite(lastAssistantAt) || lastDecisionAt < lastAssistantAt;
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
    // Do NOT unref the timer: under Node 22 the test runner flags unref'd timers as
    // "Promise resolution is still pending but the event loop has already resolved" when no
    // other work keeps the loop alive. The actual sleep is bounded (retry backoff in seconds)
    // so we don't need unref in production either.
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
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

// Deterministic autopilot pacer. No model (DeepSeek or otherwise) is consulted to choose the next
// step: the strong active supervisor — which has full tool access and just produced the latest turn
// — is the one asked to pick and verify the next step. Autopilot only keeps the session alive and
// hands that choice back to the supervisor, stopping only on hard safety conditions (an error loop
// of three consecutive failed runs; idle timeout and manual disable are enforced elsewhere).
// Removing a weak-model decision from the loop is the core error-reduction goal.
// Invariant: every path returns a valid decision object — this function performs no I/O and never
// throws, so decideAutopilotNextWithRetry no longer needs a planner-failure fallback.
export async function decideAutopilotNext(session) {
  const failureCount = consecutiveAutopilotRunFailures(session);
  if (failureCount >= 3) {
    return {
      action: "stop",
      kind: "stop",
      reason: "Three consecutive supervisor runs failed before returning a normal final answer",
    };
  }
  const lastMessage = session.messages?.at(-1);
  if (isAutopilotUserMessage(lastMessage)) {
    return {
      action: "message",
      kind: "continue",
      content: messageContent(lastMessage),
      reason: "Retrying interrupted Autopilot follow-up that had no saved supervisor answer",
    };
  }
  const objective = objectiveReminder(session);
  const lastAssistant = latestAssistantMessage(session);
  if (!lastAssistant) {
    return {
      action: "message",
      kind: "continue",
      content: `Inspect the project status, choose the safest concrete next step, run targeted verification, and report what changed.${objective}`,
      reason: "Autopilot starts by choosing a safe first step",
    };
  }
  if (hasRunError(lastAssistant)) {
    return {
      action: "message",
      kind: "continue",
      content: runFailureRecoveryContent(lastAssistant, Math.max(1, failureCount)),
      reason: `Recovering from supervisor run failure ${Math.max(1, failureCount)}/3`,
    };
  }
  const content = assistantContent(lastAssistant);
  // (1) Verification gate: the last turn made a change but shows no evidence the checks were run.
  // Checked BEFORE the no-progress breaker because an unverified change is the more specific, more
  // actionable error signal — unverified steps stacking on each other is a top source of compounding
  // errors, so verify before doing (or repeating) anything new.
  if (describesCodeChange(content) && !showsVerificationEvidence(content) && !mentionsAlreadyVerified(content)) {
    return {
      action: "message",
      kind: "continue",
      content: `Before any new change, verify the previous change: run the project's documented checks (tests, lint, type-check, build as applicable) and report the actual result. If a check fails, fix it before moving on; if no check exists for it, say so explicitly.${objective}`,
      reason: "Autopilot requires the last change to be verified before continuing",
    };
  }
  // (5) No-progress breaker: stop repeating a near-identical turn; force a different, diagnosed step.
  if (looksLikeNoProgress(session)) {
    return {
      action: "message",
      kind: "continue",
      content: `The last steps repeated with no verified progress. Do not repeat the same action. Diagnose WHY there is no progress: read the actual error or test output, re-check your assumptions against the live files, then take a different concrete step. Run targeted verification and report what changed.${objective}`,
      reason: "Autopilot detected repeated turns with no verified progress",
    };
  }
  // (2)+(3) Keep-alive: hand the next step to the supervisor, anchored to the original objective and
  // framed as one small, reversible step. Local commits are required only when files changed; pure
  // verification/review steps should not drift into invented edits just to satisfy the pacer.
  const continuation = fallbackContinuationContent(lastAssistant);
  return {
    action: "message",
    kind: "continue",
    content: `${continuation} ${continuationStepPolicy(continuation)}${objective}`,
    reason: "Autopilot keeps the session active; the supervisor chooses and verifies the next step",
  };
}
