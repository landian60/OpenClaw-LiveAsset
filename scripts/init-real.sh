#!/usr/bin/env bash
set -euo pipefail
export ARTIFACT_RUNTIME_NAME=real
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

ensure_artifact_layout
load_artifact_env
ensure_runtime_prereqs
ensure_bootstrapped

ARTIFACT_PORT="${ARTIFACT_PORT:-29789}"
ARTIFACT_RESET="${ARTIFACT_RESET:-0}"

RUNTIME_ROOT="$(artifact_runtime_root)"
STATE_DIR="$(artifact_state_dir)"
CONFIG_PATH="$(artifact_config_path)"
WORKSPACE_DIR="$(artifact_workspace_dir)"
LOG_DIR="$(artifact_log_dir)"
ASSETS_DIR="$(artifact_assets_dir)"
PYTHON_BIN="$(artifact_python_bin)"

if [[ "$ARTIFACT_RESET" == "1" ]]; then
  rm -rf "$RUNTIME_ROOT"
fi
mkdir -p "$STATE_DIR" "$LOG_DIR"

export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_CONFIG_PATH="$CONFIG_PATH"

if [[ -n "${ARTIFACT_ENV_FILE:-}" ]]; then
  printf 'Env file: %s\n' "$ARTIFACT_ENV_FILE"
else
  printf 'Env file: not found\n'
fi
printf 'State dir: %s\n' "$STATE_DIR"
printf 'Workspace: %s\n' "$WORKSPACE_DIR"
printf 'Gateway port: %s\n' "$ARTIFACT_PORT"
printf 'OpenClaw will now run its official onboarding wizard.\n'

node "$ARTIFACT_ROOT/openclaw/openclaw.mjs" onboard \
  --workspace "$WORKSPACE_DIR" \
  --gateway-port "$ARTIFACT_PORT" \
  --gateway-bind loopback \
  --gateway-auth token

[[ -f "$CONFIG_PATH" ]] || artifact_fail "OpenClaw onboarding did not create $CONFIG_PATH"

python3 "$ARTIFACT_ROOT/scripts/real-config.py" ensure-live-assets \
  --config "$CONFIG_PATH" \
  --plugin-dir "$ARTIFACT_ROOT/live_assets" \
  --assets-dir "$ASSETS_DIR" \
  --python-bin "$PYTHON_BIN" \
  >/dev/null

node "$ARTIFACT_ROOT/openclaw/openclaw.mjs" gateway stop >/dev/null
wait_for_loopback_port_available "$ARTIFACT_PORT" 30

printf 'Initialized config: %s\n' "$CONFIG_PATH"
printf 'LiveAssets plugin mounted from: %s\n' "$ARTIFACT_ROOT/live_assets"
printf 'Temporary onboarding gateway stopped.\n'
printf 'Next step: ./scripts/run-real.sh\n'
