import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { paths, runtime } from "./config/env.js";
import { authorizeApi, startupAuthError } from "./http/auth.js";
import { ensurePromptStore } from "./domain/prompts.js";
import { ensureSessionStore } from "./domain/sessions.js";
import { handleApi } from "./http/routes.js";
import { sendJson } from "./http/response.js";
import { serveStatic } from "./http/static.js";

async function ensureRuntimeDirs() {
  await ensureSessionStore();
  await ensurePromptStore();
  await mkdir(paths.mcpConfigDir, { recursive: true });
}

await ensureRuntimeDirs();

const authError = startupAuthError();
if (authError) {
  console.error(`[orch-ui] ${authError}`);
  process.exit(1);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      const denied = authorizeApi(req, url);
      if (denied) return sendJson(res, denied.status, { error: denied.error });
      return await handleApi(req, res, url);
    }
    return await serveStatic(req, res, url);
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message || String(error) });
  }
});

server.listen(runtime.port, runtime.listenHost, () => {
  console.log(`orch-ui listening on ${runtime.listenHost}:${runtime.port}`);
  console.log(`workspace: ${paths.workspaceRoot}`);
  console.log(`default supervisor: ${runtime.defaultSupervisor}`);
  if (!runtime.authToken) {
    console.warn(
      "[orch-ui] WARNING: no ORCH_AUTH_TOKEN set. The API has no auth; only expose it on loopback " +
      "(ORCH_BIND_HOST=127.0.0.1). Set ORCH_AUTH_TOKEN before binding to a public interface.",
    );
  }
});
