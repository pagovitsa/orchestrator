#!/bin/sh
set -eu

containerboot="${TS_CONTAINERBOOT:-/usr/local/bin/containerboot}"
state_dir="${TS_STATE_DIR:-/var/lib/tailscale}"
data_dir="${ORCH_TAILSCALE_DATA_DIR:-/data/tailscale}"
config_env="${ORCH_TAILSCALE_CONFIG_ENV:-$data_dir/setup.env}"
status_file="${ORCH_TAILSCALE_STATUS_FILE:-$data_dir/status.json}"
ui_port="${ORCH_TAILSCALE_UI_PORT:-8787}"
ui_https_port="${ORCH_TAILSCALE_UI_HTTPS_PORT:-443}"
preview_ports="${ORCH_TAILSCALE_PREVIEW_PORTS:-3000-3020,5173-5190,8000-8020,8080-8090}"
serve_enabled="${ORCH_TAILSCALE_SERVE:-1}"
serve_reset="${ORCH_TAILSCALE_SERVE_RESET:-1}"
wait_seconds="${ORCH_TAILSCALE_WAIT_SECONDS:-90}"
config_wait_seconds="${ORCH_TAILSCALE_CONFIG_WAIT_SECONDS:-0}"

log() {
  printf '%s\n' "orch-tailscale: $*"
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

write_status() {
  state="$1"
  detail="${2:-}"
  mkdir -p "$(dirname "$status_file")"
  chmod 0777 "$(dirname "$status_file")" 2>/dev/null || true
  tmp="$status_file.$$"
  printf '{"state":"%s","detail":"%s","updatedAt":"%s"}\n' \
    "$(json_escape "$state")" \
    "$(json_escape "$detail")" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp"
  mv "$tmp" "$status_file"
}

is_port() {
  case "${1:-}" in
    ""|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

emit_ports() {
  printf '%s' "$1" | tr ',' '\n' | while IFS= read -r item; do
    item="$(printf '%s' "$item" | tr -d '[:space:]')"
    [ -n "$item" ] || continue
    case "$item" in
      *-*)
        start="${item%-*}"
        end="${item#*-}"
        if ! is_port "$start" || ! is_port "$end" || [ "$start" -gt "$end" ]; then
          log "invalid preview port range: $item" >&2
          return 2
        fi
        port="$start"
        while [ "$port" -le "$end" ]; do
          printf '%s\n' "$port"
          port=$((port + 1))
        done
        ;;
      *)
        if ! is_port "$item"; then
          log "invalid preview port: $item" >&2
          return 2
        fi
        printf '%s\n' "$item"
        ;;
    esac
  done
}

state_exists() {
  [ -s "$state_dir/tailscaled.state" ] || [ -s "$state_dir/tailscaled.state.tmp" ]
}

load_saved_config() {
  [ -f "$config_env" ] || return 1
  # shellcheck disable=SC1090
  set -a
  . "$config_env"
  set +a

  if [ -z "${TS_AUTHKEY:-}" ] && [ -n "${ORCH_TAILSCALE_AUTHKEY:-}" ]; then
    export TS_AUTHKEY="$ORCH_TAILSCALE_AUTHKEY"
  fi
  if [ -n "${ORCH_TAILSCALE_HOSTNAME:-}" ]; then
    export TS_HOSTNAME="$ORCH_TAILSCALE_HOSTNAME"
  fi
  if [ -n "${ORCH_TAILSCALE_EXTRA_ARGS:-}" ]; then
    export TS_EXTRA_ARGS="$ORCH_TAILSCALE_EXTRA_ARGS"
  fi
  if [ -n "${ORCH_TAILSCALE_SERVE:-}" ]; then
    serve_enabled="$ORCH_TAILSCALE_SERVE"
  fi
  if [ -n "${ORCH_TAILSCALE_SERVE_RESET:-}" ]; then
    serve_reset="$ORCH_TAILSCALE_SERVE_RESET"
  fi
  if [ -n "${ORCH_TAILSCALE_UI_HTTPS_PORT:-}" ]; then
    ui_https_port="$ORCH_TAILSCALE_UI_HTTPS_PORT"
  fi
  if [ -n "${ORCH_TAILSCALE_PREVIEW_PORTS:-}" ]; then
    preview_ports="$ORCH_TAILSCALE_PREVIEW_PORTS"
  fi
  return 0
}

wait_for_saved_config() {
  elapsed=0
  while [ "$config_wait_seconds" = "0" ] || [ "$elapsed" -lt "$config_wait_seconds" ]; do
    if load_saved_config; then
      write_status "starting" "saved config loaded"
      return 0
    fi
    write_status "waiting" "waiting for Tailscale setup from Orch UI"
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

wait_for_tailscale() {
  elapsed=0
  while [ "$elapsed" -lt "$wait_seconds" ]; do
    if tailscale status >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$boot_pid" 2>/dev/null; then
      write_status "error" "Tailscale exited before it became ready"
      wait "$boot_pid"
      exit $?
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

serve_https() {
  https_port="$1"
  target_port="$2"
  log "serve https port $https_port -> 127.0.0.1:$target_port"
  tailscale serve --bg --yes --https="$https_port" "http://127.0.0.1:$target_port"
}

configure_serve() {
  if [ "$serve_reset" != "0" ]; then
    tailscale serve reset >/dev/null 2>&1 || true
  fi

  serve_https "$ui_https_port" "$ui_port"
  emit_ports "$preview_ports" | while IFS= read -r port; do
    [ -n "$port" ] || continue
    if [ "$port" = "$ui_https_port" ]; then
      log "skip preview port $port because it is already used by the UI HTTPS listener"
      continue
    fi
    serve_https "$port" "$port"
  done

  tailscale serve status || true
}

mkdir -p "$state_dir"
mkdir -p "$data_dir"
chmod 0777 "$data_dir" 2>/dev/null || true

load_saved_config || true

if [ -z "${TS_AUTHKEY:-}" ] && ! state_exists; then
  log "waiting for Tailscale setup at $config_env"
  if ! wait_for_saved_config; then
    write_status "missing" "no saved Tailscale setup"
    exit 64
  fi
fi

if [ ! -x "$containerboot" ]; then
  log "cannot find executable containerboot at $containerboot" >&2
  write_status "error" "containerboot is missing"
  exit 127
fi

write_status "starting" "starting Tailscale"
"$containerboot" &
boot_pid="$!"

trap 'kill "$boot_pid" 2>/dev/null || true; wait "$boot_pid" 2>/dev/null || true' INT TERM

if [ "$serve_enabled" != "0" ]; then
  log "waiting for Tailscale before configuring HTTPS serve"
  if wait_for_tailscale; then
    configure_serve
    write_status "ready" "Tailscale Serve configured"
  else
    log "Tailscale did not become ready within ${wait_seconds}s; leaving daemon running without Serve config" >&2
    write_status "error" "Tailscale did not become ready within ${wait_seconds}s"
  fi
else
  write_status "ready" "Tailscale started"
fi

wait "$boot_pid"
