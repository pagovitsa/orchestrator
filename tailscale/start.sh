#!/bin/sh
set -eu

state_dir="${TS_STATE_DIR:-/var/lib/tailscale}"
data_dir="${ORCH_TAILSCALE_DATA_DIR:-/data/tailscale}"
config_env="${ORCH_TAILSCALE_CONFIG_ENV:-$data_dir/setup.env}"
status_file="${ORCH_TAILSCALE_STATUS_FILE:-$data_dir/status.json}"
logout_sentinel="$data_dir/logout-pending"
socket_path="${TS_SOCKET:-/tmp/tailscaled.sock}"
tailscaled_bin="${TS_TAILSCALED_BIN:-tailscaled}"
tailscale_bin="${TS_TAILSCALE_BIN:-tailscale}"
tailscale_tun="${TS_TUN:-userspace-networking}"
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
  fqdn="${3:-}"
  auth_url="${4:-}"
  backend_state="${5:-}"
  mkdir -p "$(dirname "$status_file")"
  chmod 0777 "$(dirname "$status_file")" 2>/dev/null || true
  tmp="$status_file.$$"
  printf '{"state":"%s","detail":"%s","fqdn":"%s","authURL":"%s","backendState":"%s","updatedAt":"%s"}\n' \
    "$(json_escape "$state")" \
    "$(json_escape "$detail")" \
    "$(json_escape "$fqdn")" \
    "$(json_escape "$auth_url")" \
    "$(json_escape "$backend_state")" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp"
  mv "$tmp" "$status_file"
}

# Returns the file mtime in seconds since epoch, or 0 if missing. Used to detect when the UI saves
# new setup so we can restart tailscaled in place.
config_mtime() {
  if [ -f "$config_env" ]; then
    stat -c %Y "$config_env" 2>/dev/null || stat -f %m "$config_env" 2>/dev/null || echo 0
  else
    echo 0
  fi
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

tailscale_cmd() {
  "$tailscale_bin" --socket="$socket_path" "$@"
}

wipe_tailscale_state() {
  log "wiping tailscaled state"
  rm -rf "$state_dir"/* "$state_dir"/.[!.]* 2>/dev/null || true
}

consume_pending_logout_before_start() {
  if [ -f "$logout_sentinel" ]; then
    log "logout-pending sentinel found before start; wiping old Tailscale state"
    write_status "restarting" "wiping old Tailscale state"
    wipe_tailscale_state
    rm -f "$logout_sentinel" 2>/dev/null || true
  fi
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

# Reads selected fields out of `tailscale status --json`. We use awk rather than jq because the
# upstream tailscale image doesn't ship jq. The probe returns four lines on stdout:
#   <fqdn>
#   <backendState>
#   <authURL>
#   <selfOnline>          -- "true" / "false" / ""
# Any field that isn't present (yet) is emitted as an empty line. Falls back to four empties when
# tailscaled isn't responding. selfOnline is critical: tailscaled keeps reporting BackendState=
# Running even after the control plane has deleted its node (404: node not found), but Self.Online
# flips to false. Reading both lets the polling loop see that and surface "needs re-register".
probe_tailscale_status() {
  status_json="$(tailscale_cmd status --json 2>/dev/null || true)"
  if [ -z "$status_json" ]; then
    printf '\n\n\n\n'
    return 0
  fi
  printf '%s' "$status_json" | awk '
    function strip(s) { sub(/.*:[[:space:]]*"/, "", s); sub(/"[,}].*/, "", s); return s }
    function stripbool(s) { sub(/.*:[[:space:]]*/, "", s); sub(/[,}].*/, "", s); gsub(/[[:space:]]/, "", s); return s }
    /"Self":[[:space:]]*\{/ { in_self=1 }
    in_self && /"DNSName":/ && fqdn=="" { fqdn=strip($0); sub(/\.$/, "", fqdn); }
    in_self && /"Online":/ && online=="" { online=stripbool($0); in_self=0 }
    /"BackendState":/ && backend=="" { backend=strip($0); }
    /"AuthURL":/ && authurl=="" { authurl=strip($0); }
    END {
      print fqdn;
      print backend;
      print authurl;
      print online;
    }
  '
}

serve_https() {
  https_port="$1"
  target_port="$2"
  log "serve https port $https_port -> 127.0.0.1:$target_port"
  tailscale_cmd serve --bg --yes --https="$https_port" "http://127.0.0.1:$target_port"
}

configure_serve() {
  if [ "$serve_reset" != "0" ]; then
    tailscale_cmd serve reset >/dev/null 2>&1 || true
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

  tailscale_cmd serve status || true
}

wait_for_tailscaled_socket() {
  elapsed=0
  while [ "$elapsed" -lt "$wait_seconds" ]; do
    if [ -S "$socket_path" ]; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

start_tailscaled() {
  rm -f "$socket_path" 2>/dev/null || true
  "$tailscaled_bin" --socket="$socket_path" --statedir="$state_dir" --tun="$tailscale_tun" &
  daemon_pid="$!"
  if ! wait_for_tailscaled_socket; then
    write_status "error" "tailscaled socket did not become ready"
    kill "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
    return 1
  fi
  return 0
}

start_tailscale_up() {
  hostname="${TS_HOSTNAME:-orch-ui}"
  if [ -n "${TS_AUTHKEY:-}" ]; then
    # TS_EXTRA_ARGS is intentionally split into shell words so advanced deployments can pass
    # multiple Tailscale flags through docker-compose.yml.
    tailscale_cmd up --auth-key="$TS_AUTHKEY" --hostname="$hostname" ${TS_EXTRA_ARGS:-} &
  else
    tailscale_cmd up --hostname="$hostname" ${TS_EXTRA_ARGS:-} &
  fi
  up_pid="$!"
}

stop_tailscale_processes() {
  if [ -n "${up_pid:-}" ]; then
    kill "$up_pid" 2>/dev/null || true
    wait "$up_pid" 2>/dev/null || true
  fi
  if [ -n "${daemon_pid:-}" ]; then
    kill "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
}

# One run of the sidecar lifecycle: load config, start tailscaled, configure Serve, watch for env
# file changes, exit when the watcher sees a new mtime so the outer loop can re-run with the new
# auth key / hostname.
run_once() {
  if [ -z "${TS_AUTHKEY:-}" ] && ! state_exists; then
    log "waiting for Tailscale setup at $config_env"
    if ! wait_for_saved_config; then
      write_status "missing" "no saved Tailscale setup"
      return 64
    fi
  fi

  consume_pending_logout_before_start

  if ! command -v "$tailscaled_bin" >/dev/null 2>&1; then
    log "cannot find tailscaled executable: $tailscaled_bin" >&2
    write_status "error" "tailscaled is missing"
    return 127
  fi
  if ! command -v "$tailscale_bin" >/dev/null 2>&1; then
    log "cannot find tailscale executable: $tailscale_bin" >&2
    write_status "error" "tailscale CLI is missing"
    return 127
  fi

  start_mtime="$(config_mtime)"

  write_status "starting" "starting Tailscale"
  daemon_pid=""
  up_pid=""
  up_done=0
  up_rc=0
  if ! start_tailscaled; then
    return 1
  fi
  start_tailscale_up
  # Make sure SIGTERM from outside kills both watcher children and tailscaled.
  trap 'stop_tailscale_processes; exit 0' INT TERM

  fqdn=""
  backend=""
  auth_url=""
  served=0

  if [ "$serve_enabled" = "0" ]; then
    write_status "ready" "Tailscale started"
  fi

  # Poll loop: every 2s, probe `tailscale status --json`, push fields into status.json, and react
  # to backend state. Three things drive the loop's life:
  #   - setup.env mtime changes → restart (returns 75 so the outer loop reloads config)
  #   - BackendState=Running + FQDN known → configure Serve once, then keep heartbeating "ready"
  #   - BackendState=NeedsLogin → publish the AuthURL so the UI can show / open it
  while kill -0 "$daemon_pid" 2>/dev/null; do
    if [ "$up_done" = "0" ] && ! kill -0 "$up_pid" 2>/dev/null; then
      if wait "$up_pid"; then
        up_rc=0
      else
        up_rc=$?
      fi
      up_done=1
      if [ "$up_rc" != "0" ]; then
        log "tailscale up exited with status $up_rc"
      fi
    fi

    # logout-pending sentinel: orch-ui dropped this when the user clicked "Re-register" in the
    # wizard or "Sign out everything" in settings. Run `tailscale logout` so the node is removed
    # from the tailnet, wipe the persisted state so the next start can't reuse a stale identity,
    # then restart via the outer loop.
    if [ -f "$logout_sentinel" ]; then
      log "logout-pending sentinel found; calling tailscale logout"
      write_status "restarting" "logging out and wiping Tailscale state"
      tailscale_cmd logout >/dev/null 2>&1 || true
      stop_tailscale_processes
      wipe_tailscale_state
      rm -f "$logout_sentinel" 2>/dev/null || true
      return 75
    fi

    current_mtime="$(config_mtime)"
    if [ "$current_mtime" != "$start_mtime" ] && [ "$current_mtime" != "0" ]; then
      log "setup.env changed (mtime $start_mtime -> $current_mtime); restarting tailscaled"
      write_status "restarting" "applying new Tailscale setup"
      stop_tailscale_processes
      # A new key (or browser-auth restart) means the user wants a fresh registration. Drop any
      # persisted tailscaled state so the next start can't fall back to a stale node
      # identity that's been deleted from the tailnet (which would leave us stuck in NeedsLogin).
      wipe_tailscale_state
      return 75  # EX_TEMPFAIL — outer loop treats this as "go again"
    fi

    probe="$(probe_tailscale_status)"
    new_fqdn="$(printf '%s\n' "$probe" | sed -n '1p')"
    new_backend="$(printf '%s\n' "$probe" | sed -n '2p')"
    new_auth="$(printf '%s\n' "$probe" | sed -n '3p')"
    new_online="$(printf '%s\n' "$probe" | sed -n '4p')"
    [ -n "$new_fqdn" ] && fqdn="$new_fqdn"
    backend="$new_backend"
    auth_url="$new_auth"
    online="$new_online"

    case "$backend" in
      Running)
        if [ "$online" = "true" ]; then
          if [ "$serve_enabled" != "0" ] && [ "$served" = "0" ]; then
            log "tailscaled is Running and online; configuring Serve"
            configure_serve || true
            served=1
          fi
          if [ -n "$fqdn" ]; then
            write_status "ready" "Tailscale Serve configured" "$fqdn" "" "$backend"
          else
            write_status "ready" "Tailscale Serve configured (FQDN detection pending)" "" "" "$backend"
          fi
        else
          # tailscaled is Running locally but the control plane has dropped the node (404 node not
          # found, etc). Surface this as "needs-relogin" so the wizard knows the saved state is
          # unusable and the user has to re-save a key. The orch-ui save flow will then wipe state
          # and the next run_once will register fresh.
          write_status "needs-relogin" "Sidecar lost its tailnet identity; paste a fresh Tailscale key" "" "" "$backend"
        fi
        ;;
      NeedsLogin)
        if [ -n "$auth_url" ]; then
          write_status "needs-login" "Visit the auth URL to authorize this node" "" "$auth_url" "$backend"
        else
          write_status "needs-login" "Tailscale needs login; waiting for auth URL" "" "" "$backend"
        fi
        ;;
      Starting|NoState)
        write_status "starting" "Tailscale ${backend:-starting}" "" "" "$backend"
        ;;
      "")
        # tailscaled not responding yet — keep the previous status.
        ;;
      *)
        if [ "$up_done" = "1" ] && [ "$up_rc" != "0" ]; then
          write_status "error" "tailscale up exited with status $up_rc" "$fqdn" "$auth_url" "$backend"
        else
          write_status "starting" "Tailscale backend: $backend" "$fqdn" "$auth_url" "$backend"
        fi
        ;;
    esac
    sleep 2
  done

  stop_tailscale_processes
  return 0
}

mkdir -p "$state_dir"
mkdir -p "$data_dir"
chmod 0777 "$data_dir" 2>/dev/null || true

# Outer restart loop: if run_once exits with 75 (EX_TEMPFAIL) we reload config and try again.
# Anything else is final.
while true; do
  load_saved_config || true
  run_once
  rc=$?
  case "$rc" in
    75)
      log "restarting after config change"
      # Reset env from earlier load so the next iteration picks up the new file cleanly.
      unset TS_AUTHKEY TS_HOSTNAME TS_EXTRA_ARGS
      continue
      ;;
    *)
      exit "$rc"
      ;;
  esac
done
