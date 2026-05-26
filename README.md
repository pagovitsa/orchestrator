# Orchestrator

Local ChatGPT-style supervisor UI for Claude CLI, Codex CLI, Gemini CLI, and DeepSeek V4 Pro. This refactor keeps the original behavior from `orch-ui`, but splits the server into focused modules for config, workspace scoping, sessions, attachments, PAL MCP wiring, supervisor runners, routes, and static serving.

The shared supervisor prompt lives at:

```text
prompts/main-orchestrator.md
```

The default mounted host workspace is:

```text
/home/pagovitsa/orch-projects -> /workspace
```

Use `New chat` to enter a new project name and choose the supervisor for that chat run. The UI creates the project folder automatically. Existing projects that already have chat history are opened from the left sidebar, not re-selected from the new-chat modal.

Conversation history is project-centric: each project stores its own remember file at `.remember/orchestrator-chat.json`, and the sidebar history is keyed by project rather than by disposable chat sessions.

The selected CLI runs in that project folder, and its PAL MCP servers expose only the other models as peers.

## Start

```bash
cd /home/pagovitsa/projects/Orchestrator
cp .env.example .env
# edit .env and set DEEPSEEK_API_KEY if you want the DeepSeek route
docker compose up --build
```

Open:

```text
http://127.0.0.1:8787
```

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
