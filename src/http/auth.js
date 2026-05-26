import { timingSafeEqual } from "node:crypto";
import { runtime } from "../config/env.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function tokensMatch(provided, expected) {
  const a = Buffer.from(String(provided || ""), "utf8");
  const b = Buffer.from(String(expected || ""), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function presentedToken(req) {
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  // ?token= is only the browser bootstrap (handled by the static page); API calls must use a header.
  return bearer || req.headers["x-orch-token"] || "";
}

// Extracts the bare hostname from a Host header ("127.0.0.1:8787" -> "127.0.0.1", "[::1]:8787" -> "::1").
function hostnameOf(hostHeader) {
  const host = String(hostHeader || "").trim().toLowerCase();
  if (!host) return "";
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end >= 0 ? host.slice(1, end) : host;
  }
  return host.split(":")[0];
}

function isLoopbackName(name) {
  return name === "" || LOOPBACK_HOSTS.has(name);
}

function hostAllowed(req) {
  const name = hostnameOf(req.headers.host);
  return LOOPBACK_HOSTS.has(name) || runtime.allowedHosts.includes(name);
}

// Refuses startup when the operator declares a public posture (host network mode, or a non-loopback
// ORCH_BIND_HOST) without an auth token. The declared bind/mode is the only reliable exposure signal:
// in docker bridge mode the in-container socket always listens on :: and sees the gateway IP as the
// remote, so neither the listen host nor remoteAddress can distinguish a LAN client from a local one.
// Returns an error message string when the configuration is unsafe, else null.
export function startupAuthError() {
  if (runtime.authToken) return null;
  const exposed = runtime.networkMode === "host" || !isLoopbackName(hostnameOf(runtime.bindHost));
  if (!exposed) return null;
  const how = runtime.networkMode === "host" ? "network mode 'host'" : `ORCH_BIND_HOST='${runtime.bindHost}'`;
  return `Refusing to start: ${how} exposes the API beyond loopback but ORCH_AUTH_TOKEN is not set. ` +
    "Set ORCH_AUTH_TOKEN, or keep ORCH_BIND_HOST on loopback (127.0.0.1).";
}

// Authorizes an /api/ request. Returns null when allowed, or { status, error } when denied.
// - Token (when ORCH_AUTH_TOKEN/secret is set) is the primary control; a valid token grants access
//   from any Host (the operator opted into remote access).
// - With no token, requests are accepted only from loopback / explicitly allowed Hosts. This blocks
//   DNS-rebinding (attacker hostname won't match) and public exposure without a token.
// - The Origin check additionally blocks drive-by cross-origin browser writes.
export function authorizeApi(req, url) {
  if (runtime.authToken) {
    if (!tokensMatch(presentedToken(req), runtime.authToken)) {
      return { status: 401, error: "Unauthorized" };
    }
  } else if (!hostAllowed(req)) {
    return { status: 403, error: "Host not allowed; set ORCH_AUTH_TOKEN to expose beyond loopback" };
  }

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
