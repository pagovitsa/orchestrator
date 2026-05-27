# Orchestrator

[![CI](https://github.com/pagovitsa/orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/pagovitsa/orchestrator/actions/workflows/ci.yml)

Orchestrator is a local supervisor cockpit for running Claude Code, OpenAI Codex CLI, Gemini CLI, and DeepSeek V4 Pro against real project folders from one browser UI.

It is designed for hands-on local development: each chat is tied to a project directory, every supervisor runs inside the selected project, and the Docker setup keeps account state, runtime data, project previews, and optional Tailscale HTTPS inside the stack instead of borrowing host machine state.

## Highlights

- Multi-agent supervisor UI for Claude, Codex, Gemini, and DeepSeek V4 Pro.
- Project-scoped conversations, uploads, memory, preview servers, and run history.
- PAL MCP peer wiring so each CLI supervisor can ask the other models for help.
- Shared MCP tools for semantic code search, live docs, local memory, and browser checks.
- Docker-owned CLI auth volumes for Claude, Codex, and Gemini.
- Optional Docker Tailscale sidecar with HTTPS Serve for the UI and preview ports.
- Persistent Autopilot workflow state with retry, idle guard, activity feed, and restart cleanup.
- Usage and budget telemetry with redaction before persistence.
- Built-in safety scanning for obvious credentials in memory, attachments, sessions, and reports.

## Quick Start

Requirements:

- Docker with Compose v2
- Node.js 22 only if you want to run tests locally outside Docker
- CLI accounts or API keys for the supervisors you plan to use

```bash
git clone git@github.com:pagovitsa/orchestrator.git
cd orchestrator
cp .env.example .env
$EDITOR .env
docker compose up -d --build
```

Open:

```text
http://127.0.0.1:8787
```

By default the host workspace is:

```text
$HOME/orch-projects -> /workspace
```

Set `ORCH_HOST_PROJECTS=/absolute/path` in `.env` if you want a different host folder.

## How It Works

```text
browser
  |
  v
orch-ui container
  |-- Node HTTP UI/API on 8787
  |-- Claude/Codex/Gemini CLI supervisors
  |-- DeepSeek direct API supervisor
  |-- PAL MCP peer servers
  |-- orch-preview helper for project web servers
  |
  +-- /workspace  -> host project folders
  +-- /data       -> sessions, memory, usage, generated MCP config, Tailscale setup

orch-tailscale container
  |-- shares orch-ui network namespace
  |-- stores node state in orch_tailscale_state
  |-- can expose UI/previews through Tailscale Serve HTTPS
```

The app root is this repository. Runtime state is deliberately outside git:

- `/data/sessions` for project chat metadata
- `/data/orch-memory` for global memory
- `/data/usage.json` for usage telemetry
- `/data/tailscale` for UI-saved Tailscale setup and status
- `<project>/.remember/` for project memory
- `<project>/.orch-ui/uploads/` for uploaded files
- `<project>/.orchestration/previews/` for detached preview process state

## Security Model

The default configuration is local-first and conservative:

- The UI binds to loopback with `ORCH_BIND_HOST=127.0.0.1`.
- If you bind beyond loopback or use host network mode, `ORCH_AUTH_PASSWORD` is required or the server refuses to start.
- Preview ports are not auth-protected. Keep `ORCH_PREVIEW_BIND_HOST=127.0.0.1` unless those ports are meant to be reachable.
- `.env` and `.env.*` are ignored by git. Commit `.env.example`, never real credentials.
- The app refuses or redacts obvious credential-shaped text before saving memory, sessions, uploads, timeline metadata, and smoke reports.
- Public tunnels such as ngrok, localtunnel, cloudflared, serveo, bore, and `ssh -R` are not part of the normal workflow. Use Docker port binding, LAN/firewall checks, or the Tailscale sidecar.

For LAN access without Tailscale:

```env
ORCH_AUTH_PASSWORD=choose-a-real-password
ORCH_BIND_HOST=0.0.0.0
```

Then recreate the container:

```bash
docker compose up -d --build
```

## Tailscale HTTPS

The compose stack includes a separate `tailscale/tailscale` sidecar. It does not use the host machine's Tailscale login or state.

You can configure it from the UI with the Tailscale button in the sidebar, or preseed `.env`:

```env
ORCH_TAILSCALE_AUTHKEY=tskey-auth-...
ORCH_TAILSCALE_HOSTNAME=orch-ui
ORCH_TAILSCALE_HTTPS_HOST=https://orch-ui.your-tailnet.ts.net
ORCH_TAILSCALE_SERVE=1
ORCH_TAILSCALE_SERVE_RESET=1
ORCH_TAILSCALE_UI_HTTPS_PORT=443
```

Your tailnet must have MagicDNS and HTTPS certificates enabled for Tailscale Serve HTTPS.

Use the HTTPS host without the raw UI port:

```text
https://orch-ui.your-tailnet.ts.net/
```

Preview HTTPS URLs include the preview port:

```text
https://orch-ui.your-tailnet.ts.net:5173/
```

If you change `.env`, recreate the stack:

```bash
docker compose up -d --build
```

## Project Web Previews

Project dev servers run inside the `orch-ui` container, so they must bind to `0.0.0.0` and use a published preview port.

Default preview ranges:

```text
3000-3020, 5173-5190, 8000-8020, 8080-8090
```

Start a Vite-style dev server:

```bash
orch-preview start 5173 -- npm run dev -- --host 0.0.0.0 --port 5173
```

Serve a static folder:

```bash
orch-preview static 8000 .
```

Stop or inspect previews:

```bash
orch-preview stop 5173
orch-preview status
```

The helper records PID and log files under `.orchestration/previews/`, which is ignored by git.

## Supervisors

| Supervisor | Runtime | Notes |
| --- | --- | --- |
| Claude CLI | `claude --print` | Uses the shared orchestrator prompt and PAL peer MCP servers. |
| Codex CLI | `codex exec` | Runs in the selected project with container-owned `CODEX_HOME`. |
| Gemini CLI | `gemini --prompt` | Uses the shared prompt and peer MCP wiring. |
| DeepSeek V4 Pro | Direct API call | Uses `DEEPSEEK_API_KEY` or `/data/secrets/deepseek-api-key`. |

Each CLI supervisor receives peer tools for the other models:

- Claude gets `pal-codex`, `pal-gemini`, and `pal-deepseek`.
- Codex gets `pal-claude`, `pal-gemini`, and `pal-deepseek`.
- Gemini gets `pal-claude`, `pal-codex`, and `pal-deepseek`.
- DeepSeek receives equivalent peer tools from the UI server.

The shared supervisor prompt is:

```text
prompts/main-orchestrator.md
```

Generated provider-specific prompts live in `prompts/`.

## Shared MCP Tools

`ORCH_ENABLED_TOOLS` defaults to:

```env
ORCH_ENABLED_TOOLS=serena,context7,memory,playwright
```

These tools provide semantic code help, current library documentation, local durable memory, and browser automation. Playwright runs with Debian Chromium inside the image:

```env
ORCH_PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium
ORCH_PLAYWRIGHT_HEADLESS=1
ORCH_PLAYWRIGHT_NO_SANDBOX=1
```

Because browser automation can reach network URLs, keep the UI behind loopback, Tailscale, or Basic auth.

## Credentials

The image includes the app, CLIs, PAL MCP server, Playwright browser MCP, Chromium, and DeepSeek model registry. It does not bake account tokens.

Docker volumes hold CLI login state:

| Volume | Container path |
| --- | --- |
| `orch_claude_auth` | `/home/node/.claude` |
| `orch_codex_auth` | `/home/node/.codex` |
| `orch_gemini_auth` | `/home/node/.gemini` |
| `orch_data` | `/data` |
| `orch_tailscale_state` | `/var/lib/tailscale` in the sidecar |

Log in inside the running container:

```bash
docker compose exec --user node orch-ui claude login
docker compose exec --user node orch-ui codex login
docker compose exec --user node orch-ui gemini
```

For Gemini, run `/auth` if the interactive prompt asks.

You can also set API keys in `.env`:

```env
DEEPSEEK_API_KEY=
OPENAI_API_KEY=
CODEX_ACCESS_TOKEN=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
GOOGLE_API_KEY=
```

OAuth/browser sessions and API-key billing are separate. Use keys only when you intentionally want API-based auth.

## Important Environment Variables

The full current reference is `.env.example`. The compose file passes the app-facing keys through to `orch-ui`; `UID`, `GID`, and host path substitutions are compose/build-time controls.

| Variable | Purpose |
| --- | --- |
| `ORCH_HOST_PROJECTS` | Host folder mounted to `/workspace`. |
| `ORCH_AUTH_USER`, `ORCH_AUTH_PASSWORD` | HTTP Basic auth for the UI. |
| `ORCH_BIND_HOST`, `ORCH_BIND_HOST_IPV6` | Host interfaces for the published UI port. |
| `ORCH_PREVIEW_BIND_HOST` | Host interface for unauthenticated preview ports. |
| `ORCH_UI_PORT` | Host UI port, default `8787`. |
| `ORCH_PREVIEW_PORTS` | Published preview ranges and allowed `orch-preview` ports. |
| `ORCH_ALLOW_WRITE` | Enables write/yolo modes for CLI supervisors. |
| `ORCH_ALLOW_WORKSPACE_ROOT` | Allows creating chats directly at `/workspace` when set to `1`. |
| `ORCH_TIMEOUT_MS` | Per-run timeout. `0` disables automatic timeout. |
| `ORCH_AUTO_UPDATE_CLIS` | Refreshes CLI packages on boot when `1`. |
| `ORCH_CLI_PACKAGE_SPECS` | CLI package specs, useful for pinning versions. |
| `ORCH_ENABLED_TOOLS` | Shared MCP tool set. |
| `ORCH_UPLOAD_MAX_BYTES` | Total upload size per message. |
| `ORCH_UPLOAD_INLINE_CHARS` | Text attachment preview budget injected into prompts. |
| `ORCH_USAGE_POLL_INTERVAL_MS` | Hidden provider usage probe interval. |
| `ORCH_BUDGET_WARNING_USD` | Lifetime spend warning threshold. |
| `ORCH_AUTOPILOT_IDLE_TIMEOUT_MS` | Stops silent automatic follow-up runs after this delay. |
| `ORCH_AUTOPILOT_IDLE_WARNING_MS` | Sends a warning before the idle stop. |
| `ORCH_AUTOPILOT_DECISION_TIMEOUT_MS` | Timeout for the DeepSeek Autopilot decision call. |
| `ORCH_AUTOPILOT_RETRY_ATTEMPTS` | Decision retry attempts for transient failures. |
| `ORCH_AUTOPILOT_RETRY_BACKOFF_MS` | Base retry backoff for Autopilot decisions. |
| `ORCH_AUTOPILOT_FEED_LIMIT` | Recent Autopilot activity entries shown per project. |
| `ORCH_TAILSCALE_*` | Docker sidecar auth, hostname, Serve, and HTTPS settings. |
| `CLAUDE_MODEL`, `CODEX_MODEL`, `GEMINI_MODEL` | Optional CLI model overrides. |

## Autopilot, Usage, and Timeline

Autopilot state is stored with each project chat. It tracks `created`, `running`, `stopped`, `completed`, `failed`, and `paused` states so automatic follow-up runs survive browser refreshes and recover cleanly after server restarts.

Autopilot has:

- idle warning and auto-stop for silent follow-up runs
- separate decision timeout
- retry/backoff for transient DeepSeek or network failures
- bounded, redacted sidebar activity feed

Usage state is stored in `/data/usage.json`. The UI tracks runs, provider usage probes, token/cost deltas, daily totals, and lifetime totals. Budget warnings are informational and do not stop runs.

The terminal modal includes a chronological run timeline for supervisor, command, tool, peer, memory, hook, and autopilot events. Metadata is redacted before storage.

## Host Network Mode

On Linux you can run the UI in host network mode:

```bash
docker compose -f docker-compose.yml -f docker-compose.host.yml up -d --build
```

This removes Docker port publishing and binds directly on the host network. It is convenient for LAN previews, but less isolated and more likely to conflict with host services. Keep `ORCH_AUTH_PASSWORD` set when using it.

## File Attachments

Use the composer attachment control to send files to a supervisor. Files are saved under:

```text
/workspace/<project>/.orch-ui/uploads/<session-id>/
```

Text attachments are inlined into the prompt up to `ORCH_UPLOAD_INLINE_CHARS`; saved files remain available by path when inline content is truncated.

## Development Checks

```bash
npm run lint
npm run check
npm test
```

`npm run lint` is the CI-facing alias for `npm run check`, which syntax-checks server, test, and browser JavaScript files.

Run a smoke check against a running UI:

```bash
ORCH_SMOKE_BASE_URL=http://127.0.0.1:8787/ npm run smoke
```

For an authenticated UI:

```bash
ORCH_SMOKE_BASE_URL=http://127.0.0.1:8787/ \
ORCH_SMOKE_AUTH=orchestrator:<password> \
npm run smoke
```

Smoke reports are written under ignored `verification/` and redact credentials.

## CI

GitHub Actions runs on push and pull requests:

- install dependencies
- syntax check
- full Node test suite
- authenticated loopback smoke check with temporary data and workspace directories

No repository secrets are required for CI smoke checks.
