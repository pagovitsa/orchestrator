function bytesLabel(bytes) {
  if (!Number.isFinite(bytes)) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export async function fileToAttachment(file) {
  const buffer = await file.arrayBuffer();
  return {
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    dataBase64: arrayBufferToBase64(buffer),
  };
}

export async function readAttachments(files, { maxUploadBytes = 0 } = {}) {
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (maxUploadBytes && totalBytes > maxUploadBytes) {
    throw new Error(`Attached files exceed ${bytesLabel(maxUploadBytes)}`);
  }
  return Promise.all(files.map(fileToAttachment));
}

export function messageClassNames(message) {
  return ["message", message.role, message.streaming ? "streaming" : "", message.error ? "error" : "", message.stopped ? "stopped" : ""]
    .filter(Boolean)
    .join(" ");
}

export function messageStateLabel(message) {
  if (message?.error) return "error";
  if (message?.stopped) return "stopped";
  if (message?.streaming) return "live";
  return "";
}

export function appendMessageError(content, errorMessage) {
  const text = String(content || "").trimEnd();
  const errorText = `Error: ${errorMessage || "Stream failed"}`;
  return text ? `${text}\n\n${errorText}` : errorText;
}

export function applyTerminalFlags(target, draft) {
  if (!target || !draft) return;
  if (draft.error) target.error = true;
  if (draft.stopped) target.stopped = true;
}

export function autopilotStateLabel(autopilotState = {}, enabled = false) {
  const state = String(autopilotState?.state || (enabled ? "created" : "paused")).toLowerCase();
  if (!enabled && state !== "running") return "paused";
  if (state === "created" || state === "completed") return "ready";
  if (state === "running") return "running";
  if (state === "stopped") return "stopped";
  if (state === "failed") return "failed";
  if (state === "paused") return "paused";
  return enabled ? "ready" : "paused";
}

export function autopilotNeedsDecision(session) {
  if (!session?.autopilotEnabled || !Array.isArray(session.messages)) return false;
  const workflowState = String(session.autopilotState?.state || "created").toLowerCase();
  if (!["created", "completed"].includes(workflowState)) return false;
  const lastMessage = session.messages.at(-1);
  if (lastMessage?.role !== "assistant" || lastMessage.streaming || lastMessage.error || lastMessage.stopped) return false;
  const lastAssistantAt = Date.parse(lastMessage.at || "");
  const lastHistory = Array.isArray(session.autopilotHistory) ? session.autopilotHistory.at(-1) : null;
  const lastHistoryAt = Date.parse(lastHistory?.at || "");
  if (
    String(lastHistory?.action || "").toLowerCase() === "stop"
    && Number.isFinite(lastHistoryAt)
    && (!Number.isFinite(lastAssistantAt) || lastHistoryAt >= lastAssistantAt)
  ) return false;
  const decisionTimes = Array.isArray(session.autopilotHistory)
    ? session.autopilotHistory.map((entry) => Date.parse(entry?.at || "")).filter(Number.isFinite)
    : [];
  const lastDecisionAt = decisionTimes.length ? Math.max(...decisionTimes) : 0;
  return !Number.isFinite(lastAssistantAt) || lastDecisionAt < lastAssistantAt;
}

// When a supervisor run fails, the server writes the full transcript followed by an
// "Error: <details>" line into the assistant message content. Long failures (e.g. Claude
// streaming megabytes of NDJSON before crashing) produce huge bubbles that drown the actual
// reason. Collapse those into the reason line and let the terminal modal carry the raw output.
const ERROR_COLLAPSE_THRESHOLD = 800;
const ERROR_REASON_MAX_CHARS = 400;
const ERROR_REASON_MAX_LINES = 3;
const ERROR_LINE_PATTERN = /(?:^|\n)Error:\s/;

export function shouldCollapseTerminalContent(message) {
  if (!message || (!message.error && !message.stopped)) return false;
  return String(message.content || "").length > ERROR_COLLAPSE_THRESHOLD;
}

// Trim a possibly-huge multi-line block down to a few user-readable lines. The full content
// remains accessible via the terminal button — this is just for the chat bubble preview.
// JSON-looking lines (the supervisor's stream-json events dumped into the error) are replaced
// with a placeholder so the preview stays readable.
function looksLikeJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.length < 30) return false;
  return /^[{[]/.test(trimmed) || /"\s*:\s*[{["0-9tfn]/.test(trimmed);
}

function compressReason(text) {
  const cleaned = String(text || "").replace(/\s+$/g, "");
  const rawLines = cleaned.split("\n");
  const condensed = [];
  let suppressed = false;
  for (const line of rawLines) {
    if (looksLikeJsonLine(line)) {
      if (!suppressed) condensed.push("<raw output - tap terminal to view>");
      suppressed = true;
      continue;
    }
    suppressed = false;
    condensed.push(line);
    if (condensed.length >= ERROR_REASON_MAX_LINES) break;
  }
  let result = condensed.join("\n");
  if (result.length > ERROR_REASON_MAX_CHARS) result = result.slice(0, ERROR_REASON_MAX_CHARS).trimEnd() + "…";
  else if (cleaned.length > result.length && !result.endsWith("…")) result = result + "…";
  return result;
}

export function extractErrorReason(content, { error = true } = {}) {
  const text = String(content || "");
  if (!text.trim()) return error ? "Error" : "Stopped";
  if (error) {
    // Prefer the LAST "Error: ..." section. Server-side error composition appends
    // "Error: <details>" after the transcript, so the meaningful reason is at the end.
    let lastIndex = -1;
    for (const match of text.matchAll(/(?:^|\n)Error:\s/g)) lastIndex = match.index ?? lastIndex;
    if (lastIndex >= 0) {
      const tail = text.slice(lastIndex).replace(/^\n/, "");
      return compressReason(tail);
    }
  }
  // No explicit Error: marker — show the last few non-empty lines.
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return error ? "Error" : "Stopped";
  return compressReason(lines.slice(-ERROR_REASON_MAX_LINES).join("\n"));
}

// Returns the reset timestamp (ms) for the usage window the UI is *displaying*. The model status
// chip shows whichever of {currentPercent, weeklyPercent, sonnetWeeklyPercent} is highest — the
// countdown next to the chip must point at that same window, not the soonest reset overall.
// Falls back to scanning lastKnownLabel/lastProbeOutput when structured fields aren't populated
// (older usage stores, modes without explicit windows).
const RESET_TIMESTAMP_PATTERN = /reset\s+(\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?)/gi;

function parseResetMs(value, nowMs) {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms <= nowMs) return null;
  return ms;
}

export function nextUsageResetMs(usage, nowMs = Date.now()) {
  if (!usage) return null;

  // Pick the window that actually drives the displayed percent. We compare numerically so an
  // explicit 0 still wins over null. Highest non-null percent wins; ties prefer the longer window.
  const windows = [
    { key: "currentPercent", reset: "currentResetAt" },
    { key: "weeklyPercent", reset: "weeklyResetAt" },
    { key: "sonnetWeeklyPercent", reset: "sonnetWeeklyResetAt" },
  ];
  let winner = null;
  for (const w of windows) {
    const percent = usage[w.key];
    if (typeof percent !== "number" || !Number.isFinite(percent)) continue;
    if (!winner || percent > winner.percent) winner = { ...w, percent };
  }
  if (winner) {
    const ms = parseResetMs(usage[winner.reset], nowMs);
    if (ms !== null) return ms;
    // No reset stamp on the picked window: don't fall back to a soonest-other-window because that
    // would mislead the user — return null so the UI hides the countdown.
    return null;
  }

  // Legacy fallback: scrape labels/probe output for "reset <iso>" timestamps.
  let soonest = null;
  for (const field of ["lastKnownLabel", "lastProbeOutput"]) {
    const text = String(usage[field] || "");
    if (!text) continue;
    for (const match of text.matchAll(RESET_TIMESTAMP_PATTERN)) {
      const ms = parseResetMs(match[1], nowMs);
      if (ms === null) continue;
      if (soonest === null || ms < soonest) soonest = ms;
    }
  }
  return soonest;
}

export function formatResetCountdown(targetMs, nowMs = Date.now()) {
  if (!Number.isFinite(targetMs)) return "";
  const seconds = Math.max(0, Math.round((targetMs - nowMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = Math.round(seconds / 3600);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(seconds / 86400);
  const remHours = Math.round((seconds - days * 86400) / 3600);
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

// Computes which steps in a wizard are blocked / next active. Steps are objects with at least
// an `id`. `ready(id)` returns whether the step's prerequisite is met (e.g. a key has been
// generated for the "add" step). Auto-advances past already-completed steps.
export function nextWizardStep(steps, currentId, ready) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const idx = steps.findIndex((s) => s.id === currentId);
  for (let i = idx + 1; i < steps.length; i += 1) {
    if (ready(steps[i].id)) return steps[i].id;
  }
  return steps[steps.length - 1].id;
}

export function prevWizardStep(steps, currentId) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const idx = steps.findIndex((s) => s.id === currentId);
  if (idx <= 0) return steps[0].id;
  return steps[idx - 1].id;
}

export function wizardProgress(steps, currentId) {
  if (!Array.isArray(steps) || steps.length === 0) return { index: 0, total: 0, percent: 0 };
  const idx = Math.max(0, steps.findIndex((s) => s.id === currentId));
  const total = steps.length;
  const percent = Math.round(((idx + 1) / total) * 100);
  return { index: idx + 1, total, percent };
}

export function autopilotCanResumeFromSummary(session) {
  if (!session?.id || session.autopilotEnabled !== true) return false;
  const workflowState = String(session.autopilotState?.state || "created").toLowerCase();
  return workflowState === "created" || workflowState === "completed";
}

export function normalizeAutopilotFeed(feed = [], { limit = 2 } = {}) {
  const max = Math.max(0, Math.min(10, Math.round(Number(limit) || 0)));
  if (!Array.isArray(feed) || max <= 0) return [];
  return feed.slice(0, max).map((entry) => ({
    at: String(entry?.at || ""),
    action: String(entry?.action || "stop").slice(0, 32),
    kind: String(entry?.kind || entry?.action || "stop").slice(0, 32),
    reason: String(entry?.reason || "").slice(0, 80),
  }));
}

export function autopilotFeedEntryLabel(entry, nowMs = Date.now()) {
  const action = String(entry?.action || "stop");
  const kind = String(entry?.kind || action || "stop");
  const outcome = action === "message" ? kind || "message" : action;
  const atMs = Date.parse(entry?.at || "");
  let age = "";
  if (Number.isFinite(atMs)) {
    const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
    age = seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.round(seconds / 60)}m ago` : `${Math.round(seconds / 3600)}h ago`;
  }
  return [outcome, age].filter(Boolean).join(" - ");
}

export function createSessionSendGate() {
  const pending = new Set();
  return {
    tryStart(sessionId) {
      if (!sessionId || pending.has(sessionId)) return false;
      pending.add(sessionId);
      return true;
    },
    finish(sessionId) {
      pending.delete(sessionId);
    },
    has(sessionId) {
      return pending.has(sessionId);
    },
  };
}

const terminalStreamEvents = new Set(["done", "error", "stopped"]);

function handleStreamEvent(event, handlers) {
  handlers[event.type]?.(event);
  return terminalStreamEvents.has(event.type);
}

export async function streamApi(path, body, handlers = {}, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error || `HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawTerminalEvent = false;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          handlers.trace?.({ content: "[client] ignored malformed stream line\n" });
          continue;
        }
        sawTerminalEvent = handleStreamEvent(event, handlers) || sawTerminalEvent;
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        sawTerminalEvent = handleStreamEvent(event, handlers) || sawTerminalEvent;
      } catch {
        handlers.trace?.({ content: "[client] ignored malformed final stream line\n" });
      }
    }
  } finally {
    // Release the reader so the body stream can be cancelled and the underlying connection
    // released even if the loop above threw (network error, handler exception).
    try { reader.releaseLock(); } catch { /* already released */ }
  }

  if (!sawTerminalEvent) throw new Error("Stream ended before completion");
}
