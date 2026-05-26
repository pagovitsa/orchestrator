import { timingSafeEqual } from "node:crypto";
import { runtime } from "../config/env.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const BASIC_REALM = 'Basic realm="Orchestrator", charset="UTF-8"';

function safeEqual(provided, expected) {
  const a = Buffer.from(String(provided || ""), "utf8");
  const b = Buffer.from(String(expected || ""), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Decodes an "Authorization: Basic base64(user:pass)" header into { user, pass }, or null.
function presentedBasic(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return null;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
}

function credentialsValid(req) {
  const creds = presentedBasic(req);
  if (!creds) return false;
  // Compare both fields with constant-time checks (evaluate both to avoid short-circuit timing leaks).
  const userOk = safeEqual(creds.user, runtime.authUser);
  const passOk = safeEqual(creds.pass, runtime.authPassword);
  return userOk && passOk;
}

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
// ORCH_BIND_HOST) without an auth password. The declared bind/mode is the only reliable exposure
// signal: in docker bridge mode the in-container socket always listens on :: and sees the gateway IP
// as the remote, so neither the listen host nor remoteAddress distinguishes a LAN client from a local
// one. Returns an error message string when the configuration is unsafe, else null.
export function startupAuthError() {
  if (runtime.authPassword) return null;
  const exposed = runtime.networkMode === "host" || !isLoopbackName(hostnameOf(runtime.bindHost));
  if (!exposed) return null;
  const how = runtime.networkMode === "host" ? "network mode 'host'" : `ORCH_BIND_HOST='${runtime.bindHost}'`;
  return `Refusing to start: ${how} exposes the server beyond loopback but ORCH_AUTH_PASSWORD is not set. ` +
    "Set ORCH_AUTH_PASSWORD, or keep ORCH_BIND_HOST on loopback (127.0.0.1).";
}

// Authorizes any request (the whole site is protected, .htaccess-style). Returns null when allowed,
// or { status, error, headers? } when denied.
// - When ORCH_AUTH_PASSWORD is set: require HTTP Basic credentials; a 401 carries WWW-Authenticate so
//   the browser shows a native login prompt and then sends the credentials on every request.
// - When no password is set: accept only loopback / ORCH_ALLOWED_HOSTS Hosts (blocks DNS-rebinding and
//   public exposure without auth).
// - The Origin check additionally blocks drive-by cross-origin browser writes.
export function authorizeRequest(req) {
  if (runtime.authPassword) {
    if (!credentialsValid(req)) {
      return { status: 401, error: "Authentication required", headers: { "www-authenticate": BASIC_REALM } };
    }
  } else if (!hostAllowed(req)) {
    return { status: 403, error: "Host not allowed; set ORCH_AUTH_PASSWORD to expose beyond loopback" };
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
