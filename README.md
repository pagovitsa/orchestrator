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

## Recent Reliability Features

Recent work focuses on making long supervisor sessions easier to trust and debug:

- Cost visibility: usage probes and run signals update per-supervisor token/cost totals, with optional lifetime budget warnings.
- Safety scanning: credential-shaped text is refused or redacted before memory, session, attachment, and timeline persistence.
- Verification artifacts: `npm run smoke` performs lightweight HTTP checks and writes a redacted JSON report under ignored `verification/`.
- Timeline telemetry: terminal timeline cards show grouped supervisor/tool/peer/memory/autopilot events with status, timestamps, durations, and redacted metadata.
- Autopilot workflow: persisted state, retry/backoff, idle warning/auto-stop, restart cleanup, and a bounded sidebar activity feed make automatic follow-up runs more observable and recoverable.

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

## Security and LAN Access

Set `ORCH_AUTH_PASSWORD` before exposing the UI beyond loopback. The server refuses non-loopback or host-network startup without a password. Preview ports are not auth-protected, so keep `ORCH_PREVIEW_BIND_HOST=127.0.0.1` for local-only previews or set it to `0.0.0.0` only when the selected preview ports are acceptable on your LAN/Tailscale network.

The app also scans obvious credential-shaped text before persistence. Memory writes refuse secrets, text attachments with API keys/tokens are rejected before upload storage, and chat/session strings are redacted before they are saved.

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

If another machine still cannot connect, check the host firewall for the selected preview port and confirm Docker published the preview range on a non-loopback interface. The UI and preview published ports default to loopback for safety. Use `ORCH_BIND_HOST=0.0.0.0` for LAN UI access with `ORCH_AUTH_PASSWORD` set, and use `ORCH_PREVIEW_BIND_HOST=0.0.0.0` only when the unauthenticated preview ports are acceptable on your LAN/Tailscale network.

Because these are Docker port-publish settings, recreate the compose container after changing them.

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

### Usage and Budget Warnings

Usage state is stored in `/data/usage.json`. The UI tracks runs, provider usage probes, last-seen tokens/cost, daily totals, and lifetime totals per supervisor. Token/cost signals are treated as cumulative within a run and accumulated by delta so repeated final signals do not double-count.

Set `ORCH_BUDGET_WARNING_USD` to show a budget warning once lifetime reported dollar cost reaches that amount. `ORCH_BUDGET_USD` is accepted as a legacy alias. This is a warning only; it does not stop runs. Models that do not report dollar cost still show runs/tokens/provider quota but do not contribute dollar spend unless a provider balance probe exposes spend.

### Run Timeline

The terminal modal includes a chronological run timeline for supervisor, command, tool, peer, memory, hook, and autopilot events. Timeline cards show status, timestamp, duration when known, redacted metadata, and compact details so failed or slow steps can be inspected without digging through raw terminal output.

### Autopilot Workflow State

Autopilot enablement is stored with each project chat instead of only in browser storage. The workflow state uses `created`, `running`, `stopped`, `completed`, `failed`, and `paused`: `running` is used while Autopilot is deciding, `completed` means the last decision produced the next message and can continue, and `paused`/`stopped`/`failed` block further automatic turns until Autopilot is enabled again. The sidebar shows the current Autopilot indicator for enabled projects.

The sidebar also shows a compact Autopilot activity feed when available. Set `ORCH_AUTOPILOT_FEED_LIMIT` to control how many recent decisions appear, or `0` to hide the feed. Feed entries include only the bounded outcome, timestamp age, and a redacted short reason in the hover title; generated message content is redacted before persistence and is not exposed in project summaries. Use the project context menu to clear a project's activity history.

Autopilot follow-up runs have an idle guard separate from manual messages. Set `ORCH_AUTOPILOT_IDLE_TIMEOUT_MS` to stop an automatically sent follow-up after silence, and `ORCH_AUTOPILOT_IDLE_WARNING_MS` to warn shortly before the stop; defaults are 15 minutes and 1 minute. Set the timeout to `0` to disable the idle guard. On server startup, stale Autopilot `running` state and persisted usage `active` flags from a previous process are cleared.

Autopilot decision calls retry transient DeepSeek/network failures before marking the workflow failed. Set `ORCH_AUTOPILOT_RETRY_ATTEMPTS` and `ORCH_AUTOPILOT_RETRY_BACKOFF_MS` to tune attempts and exponential backoff; attempts includes the first call. HTTP 429 and 5xx responses are retried, while auth/configuration errors fail immediately. The retry is only for the decision step, not the follow-up supervisor run, so persisted user messages are not duplicated.

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

### Smoke Reports

Run a small HTTP smoke check against a running UI or preview:

```bash
ORCH_SMOKE_BASE_URL=http://127.0.0.1:8787/ npm run smoke
```

The smoke command checks core HTML/API/static asset endpoints, writes a JSON report under `verification/`, and exits non-zero if any check fails. Use `ORCH_SMOKE_AUTH=user:password` for Basic auth, `ORCH_SMOKE_CHECKS=/,/api/config` to override checked paths, and `ORCH_SMOKE_RETRIES`, `ORCH_SMOKE_RETRY_DELAY_MS`, `ORCH_SMOKE_TIMEOUT_MS`, or `ORCH_SMOKE_MAX_BODY_BYTES` for slow-start or large-response servers.

For an authenticated UI, set `ORCH_SMOKE_AUTH` instead of embedding credentials in the URL; reports redact auth material and URL credentials, but keeping credentials out of command URLs avoids accidental shell history leaks.
