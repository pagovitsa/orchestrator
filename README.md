# Orchestrator

Local ChatGPT-style supervisor UI for Claude CLI, Codex CLI, Gemini CLI, and DeepSeek V4 Pro. This refactor keeps the original behavior from `orch-ui`, but splits the server into focused modules for config, workspace scoping, sessions, attachments, PAL MCP wiring, supervisor runners, routes, and static serving.

The shared supervisor prompt lives at:

```text
prompts/main-orchestrator.md
```

The default mounted host workspace is:

```text
$HOME/orch-projects -> /workspace
```

Override it with `ORCH_HOST_PROJECTS=/absolute/path` if you want a different host folder.

Use `New chat` to enter a new project name and choose the supervisor for that chat run. The UI creates the project folder automatically. Existing projects that already have chat history are opened from the left sidebar, not re-selected from the new-chat modal.

Conversation history is project-centric: each project stores its own remember file at `.remember/orchestrator-chat.json`, and the sidebar history is keyed by project rather than by disposable chat sessions.

The selected CLI runs in that project folder, and its PAL MCP servers expose only the other models as peers.

## Start

```bash
cd /path/to/Orchestrator
cp .env.example .env
# edit .env and set DEEPSEEK_API_KEY if you want the DeepSeek route
docker compose up --build
```

Open:

```text
http://127.0.0.1:8787
```

From another PC on the same LAN, open the UI with the host machine IP:

```text
http://<host-lan-ip>:8787
```

## Host Network Mode

On Linux you can run `orch-ui` on the host network instead of Docker bridge/port publishing:

```bash
docker compose -f docker-compose.yml -f docker-compose.host.yml up --build
```

In this mode Docker does not use the `ports:` mappings. The UI and project previews bind directly on the host network, so `0.0.0.0:<port>` is immediately visible on the host and LAN if the host firewall allows it. This is often simpler for local LAN previews, but it is less isolated and can conflict with host services already using the same ports.

Use the default bridge mode if you want explicit Docker port mappings or better portability across Docker Desktop / non-Linux environments.

## Project Web Previews

Project dev servers run inside the `orch-ui` container, so they must bind to `0.0.0.0` and use a Docker-published preview port. The default published ranges are:

```text
3000-3020, 5173-5190, 8000-8020, 8080-8090
```

Ask the supervisor to start servers with explicit host/port flags, for example:

```bash
orch-preview start 5173 -- npm run dev -- --host 0.0.0.0 --port 5173
```

For a plain static folder:

```bash
orch-preview static 8000 .
```

Then open:

```text
http://127.0.0.1:5173
http://<host-lan-ip>:5173
```

If another machine still cannot connect, check the host firewall for the selected preview port. The UI and preview bind host default to `0.0.0.0`; set `ORCH_BIND_HOST=127.0.0.1` only if you want local-only access.

The `orch-preview` helper detaches the server, records PID/log files in `.orchestration/previews/`, and keeps it alive after the model response finishes. `.orchestration/` is runtime-only and ignored by git. Use `orch-preview stop <port>` to stop one, and `orch-preview status` to list active previews. When a chat is opened through Tailscale/LAN, the UI passes the current browser host into the supervisor so `orch-preview` can print that reachable host instead of only `localhost`.

Every supervisor receives an injected runtime note that it is running inside the `orch-ui` Docker image/container. In bridge mode it treats shell `127.0.0.1` as container-local and uses Docker-published ports for browser/LAN previews; in host network mode it knows the container shares the host network namespace.

Supervisors are instructed not to use public tunnels such as localtunnel, ngrok, cloudflared, serveo, bore, or `ssh -R` unless the latest user message explicitly asks for a tunnel. If a LAN browser cannot connect, the expected fix is port mapping, host IP, or firewall diagnosis.

## Supervisors

- `Claude CLI` runs `claude --print` with the shared prompt.
- `Codex CLI` runs `codex exec` with the shared prompt.
- `Gemini CLI` runs `gemini --prompt` with the shared prompt.
- `DeepSeek V4 Pro` calls `https://api.deepseek.com/v1/chat/completions` directly.

Each CLI supervisor gets PAL MCP peer servers for the other models:

- Claude gets `pal-codex`, `pal-gemini`, and `pal-deepseek`.
- Codex gets `pal-claude`, `pal-gemini`, and `pal-deepseek`.
- Gemini gets `pal-claude`, `pal-codex`, and `pal-deepseek`.

DeepSeek is exposed through the PAL `chat` tool with `deepseek-v4-pro` as the default model. When DeepSeek is the active supervisor, the UI server provides equivalent peer tools for Claude, Codex, and Gemini.

### Memory MCP

CLI supervisors also receive the local `memory` MCP server when `ORCH_ENABLED_TOOLS` includes `memory` (enabled by default). It stores durable facts locally:

- user/global memory: `/data/orch-memory/user.json`
- project memory: `<project>/.remember/orchestrator-memory.json`

Examples: if the user says "my name is Kostas", the active supervisor should store that with `memory_remember` using `scope: "user"`, so future projects can recall it. Project-specific decisions and constraints use `scope: "project"`. The memory layer refuses obvious secrets such as passwords, API keys, and tokens.

## Credentials

The image contains the UI, the Claude/Codex/Gemini CLIs, PAL MCP, and the DeepSeek model registry. It does not bake account tokens or API keys.

CLI logins are stored in Docker named volumes:

- `orch_claude_auth` -> `/home/node/.claude`
- `orch_codex_auth` -> `/home/node/.codex`
- `orch_gemini_auth` -> `/home/node/.gemini`
- `orch_data` -> `/data` for generated MCP configs

Log in once inside the container:

```bash
docker compose exec --user node orch-ui claude login
docker compose exec --user node orch-ui codex login
docker compose exec --user node orch-ui gemini
```

For Gemini, run `/auth` in the interactive prompt if it asks. Put `DEEPSEEK_API_KEY=...` in `.env` for the DeepSeek route.

## CLI Auto Updates

On every container boot, `orch-entrypoint` checks npm for newer Claude/Codex/Gemini CLI packages and installs the configured latest specs before starting the UI server:

```env
ORCH_AUTO_UPDATE_CLIS=1
ORCH_CLI_PACKAGE_SPECS=@anthropic-ai/claude-code@latest @openai/codex@latest @google/gemini-cli@latest
ORCH_CLI_UPDATE_TIMEOUT_SECONDS=120
```

If npm is unavailable or the check times out, startup continues with the versions baked into the image. Set `ORCH_AUTO_UPDATE_CLIS=0` to keep the baked-in versions only, or replace `ORCH_CLI_PACKAGE_SPECS` with pinned versions if needed.

## Write Mode

`ORCH_ALLOW_WRITE=1` launches the CLI supervisors in YOLO mode: Claude bypasses permissions, Codex bypasses approvals and sandbox prompts, and Gemini uses `approval-mode yolo`. The selected workspace folder is still passed as the session working directory and the prompt scope.

With the default `ORCH_ALLOW_WORKSPACE_ROOT=0`, new chats must pick a project folder instead of `/workspace` itself.

Use:

```env
ORCH_ALLOW_WRITE=0
```

for read-only/plan mode.

## File Attachments

Use `Attach` in the composer to add one or more files to a message. Files are written under the selected workspace folder at:

```text
/workspace/<selected-folder>/.orch-ui/uploads/<session-id>/
```

The default total upload limit per message is 25 MB. Override it with `ORCH_UPLOAD_MAX_BYTES`.

## Checks

```bash
npm run check
npm test
```

`npm run check` syntax-checks server, test, and browser JavaScript files.
