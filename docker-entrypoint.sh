#!/usr/bin/env bash
set -euo pipefail

export HOME=/home/node

mkdir -p "$HOME/.claude" "$HOME/.codex" "$HOME/.gemini" /data/sessions /data/orch-mcp /data/secrets
chown -R node:node "$HOME/.claude" "$HOME/.codex" "$HOME/.gemini" /data/sessions /data/orch-mcp /data/secrets

env_enabled() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

if env_enabled "${ORCH_AUTO_UPDATE_CLIS:-1}"; then
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

runuser -u node -- env HOME="$HOME" PATH="$PATH" node /app/src/scripts/write-startup-mcp.js

exec runuser -u node -- env HOME="$HOME" PATH="$PATH" "$@"
