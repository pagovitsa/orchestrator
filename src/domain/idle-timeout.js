export function normalizeIdleTimeoutConfig({
  timeoutMs = 0,
  warningMs = 0,
} = {}) {
  const timeout = Number.isFinite(Number(timeoutMs)) ? Math.max(0, Math.round(Number(timeoutMs))) : 0;
  const warning = Number.isFinite(Number(warningMs)) ? Math.max(0, Math.round(Number(warningMs))) : 0;
  return {
    timeoutMs: timeout,
    warningMs: timeout > 0 ? Math.min(warning, Math.max(0, timeout - 1)) : 0,
  };
}

export function idleTimeoutDecision(run = {}, nowMs = Date.now(), config = {}) {
  const { timeoutMs, warningMs } = normalizeIdleTimeoutConfig(config);
  if (!timeoutMs || run.source !== "autopilot" || run.idleStopped) return { action: "none" };
  const lastActivityMs = Number.isFinite(run.lastActivityMs) ? run.lastActivityMs : nowMs;
  const idleMs = Math.max(0, nowMs - lastActivityMs);
  if (idleMs >= timeoutMs) return { action: "stop", idleMs };
  if (warningMs > 0 && idleMs >= timeoutMs - warningMs && !run.idleWarningSent) {
    return { action: "warn", idleMs, remainingMs: Math.max(0, timeoutMs - idleMs) };
  }
  return { action: "none", idleMs };
}
