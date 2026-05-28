import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths, runtime } from "../config/env.js";

const tailscaleDir = path.join(paths.dataDir, "tailscale");
const setupFile = path.join(tailscaleDir, "setup.json");
const envFile = path.join(tailscaleDir, "setup.env");
const statusFile = path.join(tailscaleDir, "status.json");
// Drop-file the sidecar polls. When present, start.sh runs `tailscale logout`, wipes
// /var/lib/tailscale, deletes the sentinel, and restarts. Used by both Re-register (Start setup
// from the wizard) and Sign out everything from settings — anything that wants the sidecar's
// tailnet identity gone, not just the UI's record of it.
const logoutSentinelFile = path.join(tailscaleDir, "logout-pending");

// Fixed device hostname. The sidecar always registers as this; the browser-auth flow gives the
// user the chance to delete any stale orch-ui* in their tailnet admin if they want before
// reauthorizing.
export const ORCH_HOSTNAME = "orch-ui";

function cleanString(value, limit = 1000) {
  return String(value || "").trim().slice(0, limit);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function parseEnv(text) {
  const result = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replaceAll("'\\''", "'");
    } else if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
    }
    result[match[1]] = value;
  }
  return result;
}

async function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readEnvFile() {
  try {
    return parseEnv(await readFile(envFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeFileAtomic(file, content, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  await writeFile(tmp, content, { mode });
  await chmod(tmp, mode);
  await rename(tmp, file);
}

function publicSetupFromConfig(config = {}, env = {}, sidecar = {}) {
  // Prefer the sidecar-reported live FQDN; otherwise fall back to whatever the save left behind.
  const fqdn = cleanString(sidecar.fqdn || "", 260);
  const httpsHost = fqdn
    ? `https://${fqdn}`
    : cleanString(config.httpsHost || env.ORCH_TAILSCALE_HTTPS_HOST || process.env.ORCH_TAILSCALE_HTTPS_HOST || "", 260);
  const authKeyConfigured = Boolean(
    env.ORCH_TAILSCALE_AUTHKEY || env.TS_AUTHKEY ||
    process.env.ORCH_TAILSCALE_AUTHKEY || process.env.TS_AUTHKEY ||
    config.authKeyConfigured,
  );
  // "Configured" means the sidecar is actually serving on the tailnet. We don't trust setup.env
  // alone — tailscaled can have stale persisted state pointing at a deleted node and still claim
  // BackendState=Running. Only state="ready" (which the sidecar only writes when BackendState=
  // Running AND Self.Online=true) counts.
  const sidecarReady = sidecar.state === "ready" && Boolean(httpsHost);
  return {
    configured: sidecarReady,
    saved: Boolean(config.saved || config.updatedAt || Object.keys(env).length),
    hostname: ORCH_HOSTNAME,
    httpsHost,
    fqdn,
    authKeyConfigured,
    apiManaged: Boolean(config.apiManaged),
    cleanup: config.cleanup || null,
    serve: true,
    serveReset: true,
    uiHttpsPort: 443,
    previewPorts: runtime.previewPorts,
    updatedAt: config.updatedAt || "",
  };
}

export async function tailscaleStatus() {
  const [config, env, sidecar] = await Promise.all([
    readJsonFile(setupFile, {}),
    readEnvFile(),
    readJsonFile(statusFile, {}),
  ]);
  const setup = publicSetupFromConfig(config, env, sidecar);
  return {
    ...setup,
    state: cleanString(sidecar.state || (setup.configured ? "saved" : "missing"), 40),
    detail: cleanString(sidecar.detail || "", 300),
    sidecarUpdatedAt: cleanString(sidecar.updatedAt || "", 80),
    // Live signals from `tailscale status --json` so the UI can react: show an auth URL when the
    // sidecar needs browser login, and treat backendState=Running as "this is actually online".
    authURL: cleanString(sidecar.authURL || "", 500),
    backendState: cleanString(sidecar.backendState || "", 40),
  };
}

// Triggers a fresh tailscaled registration via browser auth. No key is required from the user; the
// sidecar starts tailscaled and runs `tailscale up` without TS_AUTHKEY, which emits an AuthURL that
// the wizard catches and opens in a browser tab. We drop a logout-pending sentinel first so any
// pre-existing tailnet identity in /var/lib/tailscale is logged out and wiped before re-auth —
// otherwise tailscaled would happily reuse a stale identity that's been deleted from the tailnet
// and silently fail (BackendState=Running but 404 on every PollNetMap).
export async function saveTailscaleSetup() {
  console.error("[tailscale-save] starting fresh registration via browser auth");

  const updatedAt = new Date().toISOString();
  const publicConfig = {
    saved: true,
    hostname: ORCH_HOSTNAME,
    httpsHost: "", // filled by sidecar after registration
    authKeyConfigured: false,
    apiManaged: false,
    cleanup: null,
    updatedAt,
  };

  const envText = [
    "# Generated by Orch UI. Do not commit this file.",
    `ORCH_TAILSCALE_HOSTNAME=${shellQuote(ORCH_HOSTNAME)}`,
    "ORCH_TAILSCALE_SERVE=1",
    "ORCH_TAILSCALE_SERVE_RESET=1",
    "ORCH_TAILSCALE_UI_HTTPS_PORT=443",
    `ORCH_TAILSCALE_PREVIEW_PORTS=${shellQuote(runtime.previewPorts)}`,
    "",
  ].join("\n");

  try {
    await mkdir(tailscaleDir, { recursive: true });
    await Promise.all([
      rm(statusFile, { force: true }),
      writeFile(logoutSentinelFile, updatedAt, "utf8"),
      writeFileAtomic(setupFile, `${JSON.stringify(publicConfig, null, 2)}\n`),
    ]);
    await writeFileAtomic(envFile, envText);
    console.error("[tailscale-save] wrote setup.env + logout-pending sentinel (sidecar will logout, wipe state, restart)");
  } catch (error) {
    console.error(`[tailscale-save] file write FAILED: ${error.message}`);
    throw error;
  }

  return tailscaleStatus();
}

// Sign out everything (settings menu) calls this. We drop the logout-pending sentinel so the
// sidecar actually runs `tailscale logout` and wipes its state — otherwise the file-side reset
// would leave a still-registered orch-ui device on the tailnet, defeating the "sign out" intent.
export async function clearTailscaleSetup() {
  await mkdir(tailscaleDir, { recursive: true }).catch(() => {});
  await Promise.all([
    writeFile(logoutSentinelFile, new Date().toISOString(), "utf8").catch(() => {}),
    rm(setupFile, { force: true }),
    rm(envFile, { force: true }),
    rm(statusFile, { force: true }),
  ]);
  return tailscaleStatus();
}
