#!/usr/bin/env bash
set -euo pipefail
export ARTIFACT_RUNTIME_NAME=real
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

ensure_artifact_layout
load_artifact_env
ensure_runtime_prereqs
ensure_bootstrapped

STATE_DIR="$(artifact_state_dir)"
CONFIG_PATH="$(artifact_config_path)"
LOG_DIR="$(artifact_log_dir)"
ASSETS_DIR="$(artifact_assets_dir)"
PYTHON_BIN="$(artifact_python_bin)"
PID_FILE="$LOG_DIR/gateway.pid"

[[ -f "$CONFIG_PATH" ]] || artifact_fail "missing $CONFIG_PATH; run ./scripts/init-real.sh first"

python3 "$ARTIFACT_ROOT/scripts/real-config.py" ensure-live-assets \
  --config "$CONFIG_PATH" \
  --plugin-dir "$ARTIFACT_ROOT/live_assets" \
  --assets-dir "$ASSETS_DIR" \
  --python-bin "$PYTHON_BIN" \
  >/dev/null

ARTIFACT_PORT="$(python3 "$ARTIFACT_ROOT/scripts/real-config.py" read --config "$CONFIG_PATH" gateway-port)"
ARTIFACT_GATEWAY_TOKEN="$(python3 "$ARTIFACT_ROOT/scripts/real-config.py" read --config "$CONFIG_PATH" gateway-token)"

ensure_loopback_port_available "$ARTIFACT_PORT"
mkdir -p "$LOG_DIR"

if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$EXISTING_PID" ]] && kill -0 "$EXISTING_PID" >/dev/null 2>&1; then
    printf 'OpenClaw gateway already running.\n'
    printf 'PID: %s\n' "$EXISTING_PID"
    printf 'OpenClaw control UI: http://127.0.0.1:%s/\n' "$ARTIFACT_PORT"
    printf 'LiveAssets UI: http://127.0.0.1:%s/live-assets/\n' "$ARTIFACT_PORT"
    printf 'Gateway log: %s\n' "$LOG_DIR/gateway.log"
    printf 'Tail logs: tail -f %s\n' "$LOG_DIR/gateway.log"
    tail -n +1 -f "$LOG_DIR/gateway.log"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_CONFIG_PATH="$CONFIG_PATH"
export OPENCLAW_GATEWAY_URL="http://127.0.0.1:$ARTIFACT_PORT"
if [[ -n "$ARTIFACT_GATEWAY_TOKEN" ]]; then
  export OPENCLAW_GATEWAY_TOKEN="$ARTIFACT_GATEWAY_TOKEN"
else
  unset OPENCLAW_GATEWAY_TOKEN 2>/dev/null || true
fi
export OPENCLAW_SKIP_CHANNELS=1
export CLAWDBOT_SKIP_CHANNELS=1
export PYTHON_BIN="$PYTHON_BIN"

if [[ -n "${ARTIFACT_ENV_FILE:-}" ]]; then
  printf 'Env file: %s\n' "$ARTIFACT_ENV_FILE"
else
  printf 'Env file: not found\n'
fi
printf 'Gateway config: %s\n' "$CONFIG_PATH"
printf 'Gateway port: %s\n' "$ARTIFACT_PORT"

node "$ARTIFACT_ROOT/openclaw/openclaw.mjs" gateway run \
  >"$LOG_DIR/gateway.log" 2>&1 &
GATEWAY_PID="$!"
printf '%s\n' "$GATEWAY_PID" >"$PID_FILE"

wait_for_http "http://127.0.0.1:$ARTIFACT_PORT/live-assets/assets" 120

printf 'OpenClaw control UI: http://127.0.0.1:%s/\n' "$ARTIFACT_PORT"
printf 'LiveAssets UI: http://127.0.0.1:%s/live-assets/\n' "$ARTIFACT_PORT"
printf 'Gateway config: %s\n' "$CONFIG_PATH"
printf 'Gateway log: %s\n' "$LOG_DIR/gateway.log"
printf 'Gateway PID: %s\n' "$GATEWAY_PID"
printf 'Tail logs: tail -f %s\n' "$LOG_DIR/gateway.log"
tail -n +1 -f "$LOG_DIR/gateway.log"
