#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

ensure_artifact_layout
load_artifact_env
ensure_runtime_prereqs

printf 'Node.js: %s\n' "$(node --version)"
printf 'pnpm: %s\n' "$(pnpm --version)"
printf 'Python: %s\n' "$(python3 --version)"
printf 'curl: %s\n' "$(curl --version | head -n 1)"
if [[ -n "${ARTIFACT_ENV_FILE:-}" ]]; then
  printf 'Env file: %s\n' "$ARTIFACT_ENV_FILE"
else
  printf 'Env file: not found\n'
fi

bootstrap_ready || artifact_fail "bootstrap is incomplete; run ./scripts/bootstrap.sh first"
printf 'Bootstrap: ready\n'

declare -a banned_paths=(
  "openclaw/.agent"
  "openclaw/.agents"
  "openclaw/.claude"
  "openclaw/.vscode"
  "openclaw/.github"
  "openclaw/tmp-code-assets-e2e"
  "openclaw/fly.private.toml"
  "openclaw/restart-gateway.sh"
  "openclaw/AGENTS.md"
  "openclaw/ui/package-lock.json"
  "live_assets/.pytest_cache"
  "live_assets/.DS_Store"
  "live_assets/AGENTS.md"
  "live_assets/CLAUDE.md"
  "live_assets/slurmbash"
)

for rel_path in "${banned_paths[@]}"; do
  [[ ! -e "$ARTIFACT_ROOT/$rel_path" ]] || artifact_fail "unexpected repo-local path present: $rel_path"
done

junk_matches="$(find_artifact_junk)"
if [[ -n "$junk_matches" ]]; then
  printf 'unexpected generated paths:\n%s\n' "$junk_matches" >&2
  artifact_fail "remove generated junk from the repo tree"
fi

declare -a banned_content_patterns=(
  "anaconda3/bin/python"
  "settings.local.json"
)

if [[ -n "${HOME:-}" ]]; then
  banned_content_patterns+=("$HOME")
fi

declare -a rg_args=(-n -F)
for pattern in "${banned_content_patterns[@]}"; do
  rg_args+=(-e "$pattern")
done

path_matches="$(rg "${rg_args[@]}" "$ARTIFACT_ROOT" || true)"
path_matches="$(printf '%s\n' "$path_matches" | grep -v 'scripts/check.sh' || true)"
if [[ -n "$path_matches" ]]; then
  artifact_fail "personal absolute paths or local-only settings are still committed"
fi

printf 'check passed\n'
