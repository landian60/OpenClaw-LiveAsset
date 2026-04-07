#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

artifact_fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || artifact_fail "missing required command: $1"
}

ensure_artifact_layout() {
  [[ -d "$ARTIFACT_ROOT/openclaw" ]] || artifact_fail "missing openclaw/ directory"
  [[ -d "$ARTIFACT_ROOT/live_assets" ]] || artifact_fail "missing live_assets/ directory"
}

artifact_runtime_root() {
  printf '%s\n' "$ARTIFACT_ROOT/.local/$(artifact_runtime_name)"
}

artifact_runtime_name() {
  printf '%s\n' "${ARTIFACT_RUNTIME_NAME:-real}"
}

artifact_state_dir() {
  printf '%s\n' "$(artifact_runtime_root)/state"
}

artifact_config_path() {
  printf '%s\n' "$(artifact_state_dir)/openclaw.json"
}

artifact_workspace_dir() {
  printf '%s\n' "$(artifact_runtime_root)/workspace"
}

artifact_log_dir() {
  printf '%s\n' "$(artifact_runtime_root)/logs"
}

artifact_assets_dir() {
  printf '%s\n' "$(artifact_state_dir)/live-assets"
}

resolve_artifact_env_file() {
  local env_file="${ARTIFACT_ENV_PATH:-$ARTIFACT_ROOT/.env}"
  [[ -f "$env_file" ]] || return 1
  printf '%s\n' "$env_file"
}

load_artifact_env() {
  local env_file=""
  if ! env_file="$(resolve_artifact_env_file)"; then
    ARTIFACT_ENV_FILE=""
    export ARTIFACT_ENV_FILE
    return 0
  fi
  ARTIFACT_ENV_FILE="$env_file"
  export ARTIFACT_ENV_FILE
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
}

ensure_runtime_prereqs() {
  require_cmd node
  require_cmd pnpm
  require_cmd python3
  require_cmd curl
  node -e 'const [maj,min,patch]=process.versions.node.split(".").map(Number); if (maj < 22 || (maj === 22 && (min < 12 || (min === 12 && patch < 0)))) process.exit(1);' \
    || artifact_fail "Node.js >= 22.12.0 is required"
}

artifact_python_bin() {
  local venv_python="$ARTIFACT_ROOT/live_assets/.venv/bin/python"
  [[ -x "$venv_python" ]] || artifact_fail "missing virtualenv python at $venv_python; run ./scripts/bootstrap.sh first"
  printf '%s\n' "$venv_python"
}

bootstrap_ready() {
  [[ -d "$ARTIFACT_ROOT/openclaw/node_modules" ]] || return 1
  [[ -d "$ARTIFACT_ROOT/openclaw/ui/node_modules" ]] || return 1
  [[ -f "$ARTIFACT_ROOT/openclaw/dist/entry.js" || -f "$ARTIFACT_ROOT/openclaw/dist/entry.mjs" ]] || return 1
  [[ -f "$ARTIFACT_ROOT/openclaw/dist/control-ui/index.html" ]] || return 1
  [[ -d "$ARTIFACT_ROOT/live_assets/node_modules" ]] || return 1
  [[ -x "$ARTIFACT_ROOT/live_assets/.venv/bin/python" ]] || return 1
}

ensure_bootstrapped() {
  bootstrap_ready || artifact_fail "artifact bootstrap is incomplete; run ./scripts/bootstrap.sh"
}

wait_for_http() {
  local url="$1"
  local timeout="${2:-60}"
  local start_ts
  start_ts="$(date +%s)"
  until curl --noproxy '*' -fsS "$url" >/dev/null 2>&1; do
    if [[ $(( $(date +%s) - start_ts )) -ge "$timeout" ]]; then
      artifact_fail "timed out waiting for $url"
    fi
    sleep 1
  done
}

cleanup_pid() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
  fi
}

ensure_loopback_port_available() {
  local port="$1"
  node -e '
const port = Number(process.argv[1]);
const hosts = ["127.0.0.1", "::1"];
const net = require("node:net");
let index = 0;

const tryNext = () => {
  if (index >= hosts.length) {
    process.exit(0);
    return;
  }
  const host = hosts[index++];
  const server = net.createServer();
  server.once("error", (err) => {
    if (err && err.code === "EAFNOSUPPORT") {
      tryNext();
      return;
    }
    process.stderr.write(`${host}:${port}:${err?.code ?? "UNKNOWN"}\n`);
    process.exit(1);
  });
  server.listen({ host, port }, () => {
    server.close(() => tryNext());
  });
};

tryNext();
' "$port" >/dev/null 2>&1 || artifact_fail "loopback port $port is already in use; set ARTIFACT_PORT or ARTIFACT_MODEL_PORT to a free port"
}

wait_for_loopback_port_available() {
  local port="$1"
  local timeout="${2:-30}"
  local start_ts
  start_ts="$(date +%s)"
  until ensure_loopback_port_available "$port" >/dev/null 2>&1; do
    if [[ $(( $(date +%s) - start_ts )) -ge "$timeout" ]]; then
      artifact_fail "timed out waiting for loopback port $port to become available"
    fi
    sleep 1
  done
}

find_artifact_junk() {
  find "$ARTIFACT_ROOT" \
    \( \
      -path "$ARTIFACT_ROOT/.git" -o \
      -path "$ARTIFACT_ROOT/.local" -o \
      -path "$ARTIFACT_ROOT/openclaw/node_modules" -o \
      -path "$ARTIFACT_ROOT/openclaw/ui/node_modules" -o \
      -path "$ARTIFACT_ROOT/openclaw/dist" -o \
      -path "$ARTIFACT_ROOT/live_assets/node_modules" -o \
      -path "$ARTIFACT_ROOT/live_assets/.venv" \
    \) -prune -o \
    \( -type f \( -name '.DS_Store' -o -name '*.pyc' \) -print \)
}
