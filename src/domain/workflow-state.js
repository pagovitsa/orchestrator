export const workflowStates = ["created", "running", "stopped", "completed", "failed", "paused"];

const validStates = new Set(workflowStates);
const transitions = {
  created: new Set(["created", "running", "paused", "stopped", "completed", "failed"]),
  running: new Set(["running", "stopped", "completed", "failed", "paused"]),
  stopped: new Set(["stopped", "created", "running", "paused", "failed"]),
  completed: new Set(["completed", "running", "paused", "stopped", "failed"]),
  failed: new Set(["failed", "created", "running", "paused", "stopped"]),
  paused: new Set(["paused", "created", "running", "stopped", "failed"]),
};
const runnableStates = new Set(["created", "completed"]);

export function normalizeWorkflowState(value, fallback = "created") {
  const state = typeof value === "string" ? value.trim().toLowerCase() : "";
  return validStates.has(state) ? state : fallback;
}

export function normalizeWorkflowStatus(status = {}, fallbackState = "created") {
  const state = normalizeWorkflowState(status?.state, fallbackState);
  return {
    state,
    updatedAt: status?.updatedAt || new Date().toISOString(),
    reason: String(status?.reason || "").slice(0, 800),
  };
}

export function transitionWorkflowStatus(status = {}, nextState, reason = "") {
  const current = normalizeWorkflowStatus(status);
  const target = normalizeWorkflowState(nextState, current.state);
  if (!transitions[current.state]?.has(target)) {
    throw Object.assign(new Error(`Invalid workflow transition: ${current.state} -> ${target}`), { status: 409 });
  }
  return normalizeWorkflowStatus({
    state: target,
    updatedAt: new Date().toISOString(),
    reason,
  }, target);
}

export function workflowCanRun(status = {}, enabled = false) {
  const state = normalizeWorkflowStatus(status).state;
  return Boolean(enabled) && runnableStates.has(state);
}

export function workflowStateLabel(status = {}) {
  const state = normalizeWorkflowStatus(status).state;
  if (state === "created" || state === "completed") return "ready";
  if (state === "running") return "running";
  if (state === "paused") return "paused";
  if (state === "stopped") return "stopped";
  if (state === "failed") return "failed";
  return "";
}
