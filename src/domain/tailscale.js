import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths, runtime } from "../config/env.js";

const tailscaleDir = path.join(paths.dataDir, "tailscale");
const setupFile = path.join(tailscaleDir, "setup.json");
const envFile = path.join(tailscaleDir, "setup.env");
const statusFile = path.join(tailscaleDir, "status.json");

function cleanString(value, limit = 1000) {
  return String(value || "").trim().slice(0, limit);
}

function envFlagValue(value, defaultValue = true) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function envNumberValue(value, defaultValue) {
  const number = Number(value || defaultValue);
  return Number.isFinite(number) ? number : defaultValue;
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

export function normalizeTailscaleHostname(value) {
  const hostname = cleanString(value || "orch-ui", 63).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) {
    throw Object.assign(new Error("Tailscale hostname must be 1-63 letters, numbers, or dashes."), { status: 400 });
  }
  return hostname;
}

export function normalizeTailscaleHttpsHost(value) {
  let raw = cleanString(value, 260);
  if (!raw) throw Object.assign(new Error("Tailscale HTTPS host is required."), { status: 400 });
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("Tailscale HTTPS host must be a valid https URL."), { status: 400 });
  }
  if (url.protocol !== "https:") {
    throw Object.assign(new Error("Tailscale HTTPS host must use https."), { status: 400 });
  }
  if (!url.hostname) {
    throw Object.assign(new Error("Tailscale HTTPS host must include a hostname."), { status: 400 });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw Object.assign(new Error("Tailscale HTTPS host cannot include credentials, query, or hash."), { status: 400 });
  }
  return url.origin;
}

function publicSetupFromConfig(config = {}, env = {}) {
  const hostname = cleanString(config.hostname || env.ORCH_TAILSCALE_HOSTNAME || process.env.ORCH_TAILSCALE_HOSTNAME || "orch-ui", 63);
  const httpsHost = cleanString(config.httpsHost || env.ORCH_TAILSCALE_HTTPS_HOST || process.env.ORCH_TAILSCALE_HTTPS_HOST || "", 260);
  const authKeyConfigured = Boolean(env.ORCH_TAILSCALE_AUTHKEY || env.TS_AUTHKEY || process.env.ORCH_TAILSCALE_AUTHKEY || process.env.TS_AUTHKEY || config.authKeyConfigured);
  const serve = config.serve !== undefined ? Boolean(config.serve) : envFlagValue(env.ORCH_TAILSCALE_SERVE ?? process.env.ORCH_TAILSCALE_SERVE, true);
  const serveReset = config.serveReset !== undefined ? Boolean(config.serveReset) : envFlagValue(env.ORCH_TAILSCALE_SERVE_RESET ?? process.env.ORCH_TAILSCALE_SERVE_RESET, true);
  const uiHttpsPort = envNumberValue(config.uiHttpsPort || env.ORCH_TAILSCALE_UI_HTTPS_PORT || process.env.ORCH_TAILSCALE_UI_HTTPS_PORT, 443);
  const previewPorts = cleanString(config.previewPorts || env.ORCH_TAILSCALE_PREVIEW_PORTS || process.env.ORCH_TAILSCALE_PREVIEW_PORTS || runtime.previewPorts, 300);
  return {
    configured: Boolean(authKeyConfigured && httpsHost),
    saved: Boolean(config.saved || config.updatedAt || Object.keys(env).length),
    hostname,
    httpsHost,
    authKeyConfigured,
    serve,
    serveReset,
    uiHttpsPort,
    previewPorts,
    updatedAt: config.updatedAt || "",
  };
}

export async function tailscaleStatus() {
  const [config, env, sidecar] = await Promise.all([
    readJsonFile(setupFile, {}),
    readEnvFile(),
    readJsonFile(statusFile, {}),
  ]);
  const setup = publicSetupFromConfig(config, env);
  return {
    ...setup,
    state: cleanString(sidecar.state || (setup.configured ? "saved" : "missing"), 40),
    detail: cleanString(sidecar.detail || "", 300),
    sidecarUpdatedAt: cleanString(sidecar.updatedAt || "", 80),
  };
}

export async function saveTailscaleSetup(body = {}) {
  const existingEnv = await readEnvFile();
  const authKey = cleanString(body.authKey || existingEnv.ORCH_TAILSCALE_AUTHKEY || existingEnv.TS_AUTHKEY || process.env.ORCH_TAILSCALE_AUTHKEY || process.env.TS_AUTHKEY, 500);
  if (!authKey) {
    throw Object.assign(new Error("Tailscale auth key is required the first time."), { status: 400 });
  }

  const hostname = normalizeTailscaleHostname(body.hostname || existingEnv.ORCH_TAILSCALE_HOSTNAME || process.env.ORCH_TAILSCALE_HOSTNAME || "orch-ui");
  const httpsHost = normalizeTailscaleHttpsHost(body.httpsHost || existingEnv.ORCH_TAILSCALE_HTTPS_HOST || process.env.ORCH_TAILSCALE_HTTPS_HOST || "");
  const serve = body.serve === undefined ? envFlagValue(existingEnv.ORCH_TAILSCALE_SERVE ?? process.env.ORCH_TAILSCALE_SERVE, true) : Boolean(body.serve);
  const serveReset = body.serveReset === undefined ? envFlagValue(existingEnv.ORCH_TAILSCALE_SERVE_RESET ?? process.env.ORCH_TAILSCALE_SERVE_RESET, true) : Boolean(body.serveReset);
  const uiHttpsPort = envNumberValue(body.uiHttpsPort || existingEnv.ORCH_TAILSCALE_UI_HTTPS_PORT || process.env.ORCH_TAILSCALE_UI_HTTPS_PORT, 443);
  if (uiHttpsPort < 1 || uiHttpsPort > 65535) {
    throw Object.assign(new Error("UI HTTPS port must be between 1 and 65535."), { status: 400 });
  }
  const previewPorts = cleanString(body.previewPorts || existingEnv.ORCH_TAILSCALE_PREVIEW_PORTS || process.env.ORCH_TAILSCALE_PREVIEW_PORTS || runtime.previewPorts, 300);
  const updatedAt = new Date().toISOString();

  const publicConfig = {
    saved: true,
    hostname,
    httpsHost,
    authKeyConfigured: true,
    serve,
    serveReset,
    uiHttpsPort,
    previewPorts,
    updatedAt,
  };

  const envText = [
    "# Generated by Orch UI. Do not commit this file.",
    `ORCH_TAILSCALE_AUTHKEY=${shellQuote(authKey)}`,
    `ORCH_TAILSCALE_HOSTNAME=${shellQuote(hostname)}`,
    `ORCH_TAILSCALE_HTTPS_HOST=${shellQuote(httpsHost)}`,
    `ORCH_TAILSCALE_SERVE=${shellQuote(serve ? "1" : "0")}`,
    `ORCH_TAILSCALE_SERVE_RESET=${shellQuote(serveReset ? "1" : "0")}`,
    `ORCH_TAILSCALE_UI_HTTPS_PORT=${shellQuote(String(uiHttpsPort))}`,
    `ORCH_TAILSCALE_PREVIEW_PORTS=${shellQuote(previewPorts)}`,
    "",
  ].join("\n");

  // Sequential, env first: the env file is what the sidecar consumes at startup. If we write the
  // setup JSON first and the env write then fails (disk full, permissions), the UI reports
  // "configured" but the sidecar has no key. Writing env first keeps the visible config truthful.
  await writeFileAtomic(envFile, envText);
  await writeFileAtomic(setupFile, `${JSON.stringify(publicConfig, null, 2)}\n`);

  return tailscaleStatus();
}
