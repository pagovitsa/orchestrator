const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// No HTTP Basic auth. The Orchestrator is meant to sit inside a Tailscale tailnet (or on loopback);
// the tailnet ACL is the authentication boundary, not a shared password. See README "Security model".
// `startupAuthError` stays as a no-op so existing call sites keep compiling.
export function startupAuthError() {
  return null;
}

// Origin/Host alignment is the only thing we still enforce — it blocks drive-by cross-origin browser
// writes from another site that happens to send the user's cookies/credentials. The tailnet handles
// authentication; we just refuse to be a confused deputy.
export function authorizeRequest(req) {
  if (MUTATING.has(req.method || "")) {
    const origin = req.headers.origin;
    if (origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch {
        return { status: 403, error: "Invalid Origin" };
      }
      if (originHost !== (req.headers.host || "")) {
        return { status: 403, error: "Cross-origin request blocked" };
      }
    }
  }
  return null;
}
