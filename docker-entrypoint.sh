#!/usr/bin/env bash
set -euo pipefail

export HOME=/home/node

mkdir -p "$HOME/.claude" "$HOME/.codex" "$HOME/.gemini" /data/sessions /data/orch-mcp /data/secrets
chown -R node:node "$HOME/.claude" "$HOME/.codex" "$HOME/.gemini" /data/sessions /data/orch-mcp /data/secrets

runuser -u node -- env HOME="$HOME" PATH="$PATH" node /app/src/scripts/write-startup-mcp.js

exec runuser -u node -- env HOME="$HOME" PATH="$PATH" "$@"
