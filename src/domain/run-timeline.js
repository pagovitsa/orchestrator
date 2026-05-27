const validKinds = new Set(["supervisor", "command", "tool", "memory", "model", "hook", "autopilot", "info"]);
const validStatuses = new Set(["running", "completed", "failed", "stopped", "info"]);

export const maxTimelineEvents = 80;
export const maxTimelineDetailChars = 12000;

function cleanText(value, max = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanDetail(value) {
  return String(value || "").replace(/\0/g, "").slice(0, maxTimelineDetailChars);
}

function cleanId(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(text) ? text : "";
}

function nowIso() {
  return new Date().toISOString();
}

export function createTimelineEvent(raw = {}) {
  const kind = validKinds.has(raw.kind) ? raw.kind : "info";
  const status = validStatuses.has(raw.status) ? raw.status : "info";
  const event = {
    id: cleanId(raw.id) || `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    status,
    title: cleanText(raw.title, 180) || kind,
    detail: cleanDetail(raw.detail),
    at: raw.at || nowIso(),
  };
  if (raw.endedAt) event.endedAt = raw.endedAt;
  if (Number.isFinite(raw.durationMs)) event.durationMs = Math.max(0, Math.round(raw.durationMs));
  if (raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)) event.meta = raw.meta;
  return event;
}

export function mergeTimelineEvent(timeline = [], raw = {}) {
  const event = createTimelineEvent(raw);
  const index = timeline.findIndex((item) => item.id === event.id);
  const next = [...timeline];
  if (index >= 0) {
    const existing = next[index];
    next[index] = {
      ...existing,
      ...event,
      at: existing.at || event.at,
      detail: event.detail || existing.detail || "",
    };
  } else {
    next.push(event);
  }
  return next.slice(-maxTimelineEvents);
}
