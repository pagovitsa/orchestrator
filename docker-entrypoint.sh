#!/usr/bin/env bash
set -euo pipefail

export HOME=/home/node
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"

mkdir -p "$HOME/.claude" "$HOME/.codex" "$HOME/.gemini" /data/sessions /data/orch-mcp /data/secrets
chown -R node:node "$HOME/.claude" "$HOME/.codex" "$HOME/.gemini" /data/sessions /data/orch-mcp /data/secrets

# Docker creates missing host bind-mount sources as root, so the workspace root often arrives
# unwritable for the node user. Ensure it exists and is owned by node so project creation works.
workspace_root="${ORCH_WORKSPACE_ROOT:-/workspace}"
mkdir -p "$workspace_root"
chown node:node "$workspace_root"

# When the host Docker socket is mounted, match its group dynamically so the
# non-root supervisor processes can run `docker` and `docker compose`.
docker_sock="${ORCH_DOCKER_SOCKET:-/var/run/docker.sock}"
if [ -S "$docker_sock" ]; then
  docker_gid="$(stat -c '%g' "$docker_sock" 2>/dev/null || true)"
  if [ -n "$docker_gid" ]; then
    docker_group="$(getent group "$docker_gid" | cut -d: -f1 | head -n1 || true)"
    if [ -z "$docker_group" ]; then
      docker_group="docker-host"
      groupadd -g "$docker_gid" "$docker_group" 2>/dev/null || true
    fi
    docker_group="$(getent group "$docker_gid" | cut -d: -f1 | head -n1 || true)"
    if [ -n "$docker_group" ]; then
      usermod -aG "$docker_group" node
    fi
  fi
fi

env_enabled() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

# Default git identity for the node user so auto-init/commits inside /workspace work.
runuser -u node -- env HOME="$HOME" CODEX_HOME="$CODEX_HOME" bash -c '
  git config --global --get user.name >/dev/null 2>&1 || git config --global user.name "Orchestrator"
  git config --global --get user.email >/dev/null 2>&1 || git config --global user.email "orchestrator@local.invalid"
  git config --global --get init.defaultBranch >/dev/null 2>&1 || git config --global init.defaultBranch main
'

if env_enabled "${ORCH_AUTO_UPDATE_CLIS:-0}"; then
  cli_specs="${ORCH_CLI_PACKAGE_SPECS:-@anthropic-ai/claude-code@latest @openai/codex@latest @google/gemini-cli@latest}"
  update_timeout="${ORCH_CLI_UPDATE_TIMEOUT_SECONDS:-120}"
  if [ -n "$cli_specs" ]; then
    read -r -a cli_packages <<< "$cli_specs"
    echo "[orch-entrypoint] checking npm CLI updates for up to ${update_timeout}s: $cli_specs"
    if timeout "$update_timeout" npm install -g --no-audit --no-fund --fetch-timeout=30000 --fetch-retries=1 --loglevel=warn "${cli_packages[@]}"; then
      echo "[orch-entrypoint] npm CLI update check complete"
    else
      echo "[orch-entrypoint] npm CLI update failed or timed out; continuing with baked-in versions" >&2
    fi
  fi
fi

runuser -u node -- env HOME="$HOME" CODEX_HOME="$CODEX_HOME" PATH="$PATH" node /app/src/scripts/write-startup-mcp.js

exec runuser -u node -- env HOME="$HOME" CODEX_HOME="$CODEX_HOME" PATH="$PATH" "$@"
