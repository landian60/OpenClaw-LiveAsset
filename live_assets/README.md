# OpenClaw-LiveAsset

OpenClaw-LiveAsset is an OpenClaw plugin that turns user corrections into executable behavioral assets.

This directory stays separate from `openclaw/` on purpose. The artifact repo wires the plugin in through `plugins.load.paths` so the upstream snapshot remains easy to compare against its source.

## What is here

- `src/`: runtime hooks, HTTP routes, and session handling.
- `scripts/`: Python generation, rewrite, update, and validation logic.
- `ui/`: standalone `/live-assets/` debug UI served by the plugin.
- `test/`: TypeScript and Python contract tests.

## Local commands

Run these from `live_assets/` after the artifact bootstrap step has created `.venv/`.

```bash
pnpm run typecheck
pnpm run test:ts
pnpm run test:py
pnpm run test
```

## Runtime expectations

- Node.js `>=22.12`
- `pnpm`
- Python `3.11+`
- A `requests`-capable virtualenv at `live_assets/.venv`

The artifact root scripts set `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_GATEWAY_URL`, and `OPENCLAW_GATEWAY_TOKEN` so the plugin can run without touching `~/.openclaw`.
