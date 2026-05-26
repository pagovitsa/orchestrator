import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { paths, runtime } from "./config/env.js";
import { ensurePromptStore } from "./domain/prompts.js";
import { ensureSessionStore } from "./domain/sessions.js";
import { handleApi } from "./http/routes.js";
import { sendJson } from "./http/response.js";
import { serveStatic } from "./http/static.js";

async function ensureRuntimeDirs() {
  await ensureSessionStore();
  await ensurePromptStore();
  await mkdir(path.join(paths.workspaceRoot, ".orch-ui", "uploads"), { recursive: true });
  await mkdir(paths.mcpConfigDir, { recursive: true });
}

await ensureRuntimeDirs();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message || String(error) });
  }
});

server.listen(runtime.port, runtime.listenHost, () => {
  console.log(`orch-ui listening on ${runtime.listenHost}:${runtime.port}`);
  console.log(`workspace: ${paths.workspaceRoot}`);
  console.log(`default supervisor: ${runtime.defaultSupervisor}`);
});
