import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { paths, runtime } from "./config/env.js";
import { authorizeRequest, startupAuthError } from "./http/auth.js";
import { ensurePromptStore } from "./domain/prompts.js";
import { ensureSessionStore } from "./domain/sessions.js";
import { startUsagePolling } from "./domain/usage.js";
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
    const denied = authorizeRequest(req);
    if (denied) {
      for (const [key, value] of Object.entries(denied.headers || {})) res.setHeader(key, value);
      return sendJson(res, denied.status, { error: denied.error });
    }
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message || String(error) });
  }
});

// A streaming run can last up to ORCH_TIMEOUT_MS; Node's default 5-min requestTimeout would otherwise
// abort the chunked response mid-stream (ERR_INCOMPLETE_CHUNKED_ENCODING). Keep it comfortably above,
// and disable it entirely (0) when the run timeout is disabled.
server.requestTimeout = runtime.timeoutMs > 0 ? runtime.timeoutMs + 120000 : 0;

server.listen(runtime.port, runtime.listenHost, () => {
  console.log(`orch-ui listening on ${runtime.listenHost}:${runtime.port}`);
  console.log(`workspace: ${paths.workspaceRoot}`);
  console.log(`default supervisor: ${runtime.defaultSupervisor}`);
  startUsagePolling();
  if (!runtime.authPassword) {
    console.warn(
      "[orch-ui] WARNING: no ORCH_AUTH_PASSWORD set. The server has no login; only expose it on " +
      "loopback (ORCH_BIND_HOST=127.0.0.1). Set ORCH_AUTH_PASSWORD before binding to a public interface.",
    );
  }
});
