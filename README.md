<p align="center">
  <img src="logo.png" alt="bcoders AI orchestration logo" width="760">
</p>

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

The Orchestrator does **not** ship with HTTP Basic auth. By design, the only supported way to expose
it beyond loopback is to put it on a Tailscale tailnet (or behind another network-layer ACL). The
tailnet is the authentication boundary — every device on your tailnet is authenticated by Tailscale,
so wrapping the UI in a second username/password adds friction without buying real security.

What we still enforce:

- The UI binds to loopback by default (`ORCH_BIND_HOST=127.0.0.1`). Cross-origin browser writes are
  rejected via Origin/Host alignment.
- Preview ports are unauthenticated. Keep `ORCH_PREVIEW_BIND_HOST=127.0.0.1` unless those ports are
  meant to be reachable over the tailnet.
- `.env` and `.env.*` are ignored by git. Commit `.env.example`, never real credentials.
- The app refuses or redacts obvious credential-shaped text before saving memory, sessions,
  uploads, timeline metadata, and smoke reports.
- Public tunnels (ngrok, localtunnel, cloudflared, serveo, bore, `ssh -R`) are not part of the
  workflow. Use Docker port binding, LAN/firewall rules, or the Tailscale sidecar.

If you want LAN-only access without Tailscale, set `ORCH_BIND_HOST=0.0.0.0` and constrain access at
the firewall / your router. Do not put the unauthenticated UI on the open internet.

The settings menu (gear icon in the sidebar) carries a **Sign out everything** action that revokes
every CLI auth volume (Claude / Codex / Gemini), deletes the DeepSeek API key, the GitHub keypair +
token, and the saved Tailscale setup — useful when handing the device off or for routine cleanup.

## Tailscale HTTPS

The compose stack includes a separate `tailscale/tailscale` sidecar. It does not use the host
machine's Tailscale login or state. Configure it from the UI (settings gear -> Tailscale).

The wizard asks for **one field** — a Tailscale key. The hostname is always `orch-ui`, and the
HTTPS host (`orch-ui.<tailnet>.ts.net`) is auto-detected after the sidecar registers.

You can paste either of:

- **API access token** (`tskey-api-...`) — **recommended**. Generate at
  [login.tailscale.com/admin/settings/keys](https://login.tailscale.com/admin/settings/keys)
  -> "Generate access token". On save, the orchestrator deletes any stale `orch-ui*` devices on
  your tailnet via the Tailscale API and mints a fresh reusable auth key for the sidecar. You'll
  never get bumped to `orch-ui-2` again.
- **Auth key** (`tskey-auth-...`) — works for registration only. No API access, so if a stale
  `orch-ui` device is still on the tailnet you'll need to delete it once at
  [login.tailscale.com/admin/machines](https://login.tailscale.com/admin/machines) before the new
  container can claim the name. A reusable + ephemeral key keeps things clean afterwards.

Your tailnet must have MagicDNS and HTTPS certificates enabled for Tailscale Serve HTTPS.

After the sidecar registers, use the HTTPS host without the raw UI port:

```text
https://orch-ui.<your-tailnet>.ts.net/
```

Preview HTTPS URLs include the preview port:

```text
https://orch-ui.<your-tailnet>.ts.net:5173/
```

The sidecar watches `/data/tailscale/setup.env`: when you save Tailscale setup in the UI it
restarts `tailscaled` in place, so you do **not** need to `docker compose restart` after
changing setup. The status file at `/data/tailscale/status.json` carries the live FQDN that
the UI reads back.

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

Because browser automation can reach network URLs, keep the UI behind loopback or Tailscale.

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

## Docker From Supervisors

The image includes the Docker CLI and Docker Compose plugin. Compose mounts the host Docker socket into `orch-ui`, and the entrypoint adds the `node` user to the socket group at startup, so Claude, Codex, and Gemini supervisor runs can execute commands such as:

```bash
docker ps
docker compose up -d --build
```

The default socket settings are:

```env
ORCH_DOCKER_SOCKET=/var/run/docker.sock
ORCH_DOCKER_HOST=unix:///var/run/docker.sock
```

Mounting the Docker socket gives supervisors host-level Docker control. Keep the UI on loopback or Tailscale and only enable write-capable supervisors for projects you trust.

## Important Environment Variables

The full current reference is `.env.example`. The compose file passes the app-facing keys through to `orch-ui`; `UID`, `GID`, and host path substitutions are compose/build-time controls.

| Variable | Purpose |
| --- | --- |
| `ORCH_HOST_PROJECTS` | Host folder mounted to `/workspace`. |
| `ORCH_BIND_HOST`, `ORCH_BIND_HOST_IPV6` | Host interfaces for the published UI port. |
| `ORCH_PREVIEW_BIND_HOST` | Host interface for unauthenticated preview ports. |
| `ORCH_UI_PORT` | Host UI port, default `8787`. |
| `ORCH_PREVIEW_PORTS` | Published preview ranges and allowed `orch-preview` ports. |
| `ORCH_ALLOW_WRITE` | Enables write/yolo modes for CLI supervisors. |
| `ORCH_ALLOW_WORKSPACE_ROOT` | Allows creating chats directly at `/workspace` when set to `1`. |
| `ORCH_TIMEOUT_MS` | Per-run timeout. `0` disables automatic timeout. |
| `ORCH_AUTO_UPDATE_CLIS` | Refreshes CLI packages on boot when `1`. |
| `ORCH_CLI_PACKAGE_SPECS` | CLI package specs, useful for pinning versions. |
| `ORCH_DOCKER_SOCKET`, `ORCH_DOCKER_HOST` | Host Docker socket and in-container Docker client endpoint for supervisors. |
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
| `ORCH_AUTOPILOT_SERVER_LOOP_MS` | Server-side scheduler interval so Autopilot continues without a browser tab. |
| `ORCH_TAILSCALE_*` | Docker sidecar auth, hostname, Serve, and HTTPS settings. |
| `CLAUDE_MODEL`, `CODEX_MODEL`, `GEMINI_MODEL` | CLI model defaults; compose defaults to Claude Opus 4.8, Codex GPT-5.5, and Gemini 3 Pro preview. |
| `CLAUDE_EFFORT`, `CODEX_REASONING_EFFORT` | Reasoning effort defaults (`max` for Claude; Codex uses `xhigh`, and maps `max` to `xhigh`). |

## Autopilot, Usage, and Timeline

Autopilot state is stored with each project chat. It tracks `created`, `running`, `stopped`, `completed`, `failed`, and `paused` states so automatic follow-up runs survive browser refreshes and recover cleanly after server restarts.

Autopilot has:

- idle warning and auto-stop for silent follow-up runs
- separate decision timeout
- retry/backoff for transient DeepSeek or network failures
- bounded, redacted sidebar activity feed
- a server-side scheduler, so enabled projects keep advancing even when the browser tab sleeps or disconnects

Usage state is stored in `/data/usage.json`. The UI tracks runs, provider usage probes, token/cost deltas, daily totals, and lifetime totals. Budget warnings are informational and do not stop runs.

The terminal modal includes a chronological run timeline for supervisor, command, tool, peer, memory, hook, and autopilot events. Metadata is redacted before storage.

## Host Network Mode

On Linux you can run the UI in host network mode:

```bash
docker compose -f docker-compose.yml -f docker-compose.host.yml up -d --build
```

This removes Docker port publishing and binds directly on the host network. It is convenient for LAN previews, but less isolated and more likely to conflict with host services. Constrain access at the firewall or join the tailnet — there is no HTTP basic auth fallback.

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

Smoke reports are written under ignored `verification/` and redact credentials.

## CI

GitHub Actions runs on push and pull requests:

- install dependencies
- syntax check
- full Node test suite
- authenticated loopback smoke check with temporary data and workspace directories

No repository secrets are required for CI smoke checks.
