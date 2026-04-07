#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

ensure_artifact_layout
load_artifact_env
ensure_runtime_prereqs

export CI=true

if [[ "${ARTIFACT_FORCE_BOOTSTRAP:-0}" != "1" ]] && bootstrap_ready; then
  printf 'bootstrap already satisfied\n'
  exit 0
fi

if [[ -d "$ARTIFACT_ROOT/openclaw/node_modules" && -d "$ARTIFACT_ROOT/openclaw/ui/node_modules" ]]; then
  printf '==> OpenClaw dependencies already installed\n'
else
  printf '==> Installing openclaw dependencies\n'
  pnpm --dir "$ARTIFACT_ROOT/openclaw" install --frozen-lockfile --prefer-offline
fi

if [[ -d "$ARTIFACT_ROOT/live_assets/node_modules" ]]; then
  printf '==> LiveAssets dependencies already installed\n'
else
  printf '==> Installing live_assets dependencies\n'
  pnpm --dir "$ARTIFACT_ROOT/live_assets" install --frozen-lockfile --prefer-offline
fi

if [[ -x "$ARTIFACT_ROOT/live_assets/.venv/bin/python" ]]; then
  printf '==> LiveAssets virtualenv already exists\n'
else
  printf '==> Creating live_assets virtualenv\n'
  python3 -m venv "$ARTIFACT_ROOT/live_assets/.venv"
  "$ARTIFACT_ROOT/live_assets/.venv/bin/python" -m pip install --upgrade 'pip==26.0.1'
  "$ARTIFACT_ROOT/live_assets/.venv/bin/python" -m pip install -r "$ARTIFACT_ROOT/live_assets/requirements.txt"
fi

printf '==> Building OpenClaw core\n'
pnpm --dir "$ARTIFACT_ROOT/openclaw" run build

printf '==> Building OpenClaw UI\n'
pnpm --dir "$ARTIFACT_ROOT/openclaw" run ui:build

printf '==> Typechecking LiveAssets\n'
pnpm --dir "$ARTIFACT_ROOT/live_assets" run typecheck

printf 'bootstrap complete\n'
