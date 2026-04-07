#!/usr/bin/env bash
set -euo pipefail
export ARTIFACT_RUNTIME_NAME=preset
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

ensure_artifact_layout
load_artifact_env
ensure_runtime_prereqs
ensure_bootstrapped

# Rebuild UI if source is newer than last build
UI_SRC="$ARTIFACT_ROOT/openclaw/ui/src"
UI_OUT="$ARTIFACT_ROOT/openclaw/dist/control-ui/index.html"
if [[ -d "$UI_SRC" ]] && find "$UI_SRC" -newer "$UI_OUT" -name '*.ts' -o -name '*.css' | grep -q .; then
  printf '==> UI sources changed, rebuilding…\n'
  pnpm --dir "$ARTIFACT_ROOT/openclaw" run ui:build
fi

ARTIFACT_PORT="${ARTIFACT_PORT:-29789}"
ARTIFACT_RESET="${ARTIFACT_RESET:-0}"
OPENAI_API_BASE_URL="${OPENAI_API_BASE_URL:-}"
OPENAI_MODEL="${OPENAI_MODEL:-}"
ARTIFACT_MODEL_CONTEXT_WINDOW="${ARTIFACT_MODEL_CONTEXT_WINDOW:-128000}"
ARTIFACT_MODEL_MAX_TOKENS="${ARTIFACT_MODEL_MAX_TOKENS:-8192}"

PRESET_AUTH_CHOICE=""
declare -a PRESET_AUTH_ARGS=()

[[ -n "${OPENAI_API_KEY:-}" ]] || artifact_fail "missing OPENAI_API_KEY; set it in .env before running ./scripts/run-preset.sh"

if [[ -n "$OPENAI_API_BASE_URL" || -n "$OPENAI_MODEL" ]]; then
  [[ -n "$OPENAI_API_BASE_URL" ]] || artifact_fail "missing OPENAI_API_BASE_URL for OpenAI-compatible preset route"
  [[ -n "$OPENAI_MODEL" ]] || artifact_fail "missing OPENAI_MODEL for OpenAI-compatible preset route"
  if [[ "$OPENAI_API_BASE_URL" == *"dashscope.aliyuncs.com"* && "$OPENAI_MODEL" == bailian/* ]]; then
    artifact_fail "DashScope OpenAI-compatible endpoints expect raw model IDs like qwen3-max-2026-01-23, not OpenClaw model refs like $OPENAI_MODEL"
  fi
  PRESET_AUTH_CHOICE="custom-api-key"
  export CUSTOM_API_KEY="${CUSTOM_API_KEY:-$OPENAI_API_KEY}"
  PRESET_AUTH_ARGS=(
    --custom-base-url "$OPENAI_API_BASE_URL"
    --custom-model-id "$OPENAI_MODEL"
    --custom-compatibility openai
  )
else
  PRESET_AUTH_CHOICE="openai-api-key"
  PRESET_AUTH_ARGS=(--openai-api-key "$OPENAI_API_KEY")
fi

RUNTIME_ROOT="$(artifact_runtime_root)"
STATE_DIR="$(artifact_state_dir)"
CONFIG_PATH="$(artifact_config_path)"
WORKSPACE_DIR="$(artifact_workspace_dir)"
LOG_DIR="$(artifact_log_dir)"
ASSETS_DIR="$(artifact_assets_dir)"
PYTHON_BIN="$(artifact_python_bin)"
PID_FILE="$LOG_DIR/gateway.pid"

if [[ "$ARTIFACT_RESET" == "1" ]]; then
  rm -rf "$RUNTIME_ROOT"
fi
mkdir -p "$STATE_DIR" "$LOG_DIR"

export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_CONFIG_PATH="$CONFIG_PATH"

if [[ ! -f "$CONFIG_PATH" ]]; then
  node "$ARTIFACT_ROOT/openclaw/openclaw.mjs" onboard \
    --non-interactive \
    --accept-risk \
    --auth-choice "$PRESET_AUTH_CHOICE" \
    --secret-input-mode ref \
    --workspace "$WORKSPACE_DIR" \
    --gateway-port "$ARTIFACT_PORT" \
    --gateway-bind loopback \
    --gateway-auth token \
    --skip-channels \
    --skip-skills \
    --skip-search \
    --skip-ui \
    --skip-health \
    "${PRESET_AUTH_ARGS[@]}"
fi

[[ -f "$CONFIG_PATH" ]] || artifact_fail "missing $CONFIG_PATH after preset initialization"

if [[ -n "$OPENAI_API_BASE_URL" ]]; then
  CUSTOM_PROVIDER_ID="$(
    python3 "$ARTIFACT_ROOT/scripts/real-config.py" migrate-preset-custom-provider \
    --config "$CONFIG_PATH" \
    --base-url "$OPENAI_API_BASE_URL" \
    --model-id "$OPENAI_MODEL" \
  )"
  if [[ "$CUSTOM_PROVIDER_ID" != "noop" ]]; then
    python3 "$ARTIFACT_ROOT/scripts/real-config.py" tune-provider-model-limits \
      --config "$CONFIG_PATH" \
      --provider-id "$CUSTOM_PROVIDER_ID" \
      --model-id "$OPENAI_MODEL" \
      --context-window "$ARTIFACT_MODEL_CONTEXT_WINDOW" \
      --max-tokens "$ARTIFACT_MODEL_MAX_TOKENS" \
      >/dev/null
  fi
fi

python3 "$ARTIFACT_ROOT/scripts/real-config.py" ensure-live-assets \
  --config "$CONFIG_PATH" \
  --plugin-dir "$ARTIFACT_ROOT/live_assets" \
  --assets-dir "$ASSETS_DIR" \
  --python-bin "$PYTHON_BIN" \
  >/dev/null

python3 "$ARTIFACT_ROOT/scripts/real-config.py" ensure-preset-tooling \
  --config "$CONFIG_PATH" \
  >/dev/null

rm -rf "$ASSETS_DIR"
mkdir -p "$ASSETS_DIR"
cp "$ARTIFACT_ROOT"/fixtures/assets/*.json "$ASSETS_DIR"/

ARTIFACT_PORT="$(python3 "$ARTIFACT_ROOT/scripts/real-config.py" read --config "$CONFIG_PATH" gateway-port)"
ARTIFACT_GATEWAY_TOKEN="$(python3 "$ARTIFACT_ROOT/scripts/real-config.py" read --config "$CONFIG_PATH" gateway-token)"

ensure_loopback_port_available "$ARTIFACT_PORT"

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
printf 'Preset config: %s\n' "$CONFIG_PATH"
printf 'Gateway port: %s\n' "$ARTIFACT_PORT"
printf 'Seeded assets: %s\n' "$ASSETS_DIR"
if [[ -n "$OPENAI_API_BASE_URL" ]]; then
  printf 'Preset OpenAI-compatible base URL: %s\n' "$OPENAI_API_BASE_URL"
  printf 'Preset model id: %s\n' "$OPENAI_MODEL"
else
  printf 'Preset model provider: OpenAI\n'
fi

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
