# Upstream Sources

This repository is an artifact-oriented repackage. It copies source trees into a new git repository without preserving their original `.git/` history.

## `openclaw/`

- Source repository: `https://github.com/landian60/openclaw`
- Copied from local checkout commit: `47044d1e1e7dd9b51928692baf8ab44caca57821`
- License at source: MIT
- Notes: kept as a mostly intact upstream snapshot so the LiveAssets integration can run without re-porting OpenClaw internals into a new layout.

## `live_assets/`

- Source repository: local git checkout with no configured remotes at copy time
- Copied from local checkout branch: `paper/codeasset-uist-tex-0323`
- Copied from local checkout commit: `8d2ca935fd47c23f91eb9344a87fbe3624121482`
- License in this artifact repo: MIT
- Notes: this directory is treated as the artifact-owned plugin codebase. The artifact root scripts load it via `plugins.load.paths`.

## Artifact-owned files

The following paths are authored for this artifact repository rather than copied from upstream:

- `README.md`
- `LICENSE`
- `UPSTREAM_SOURCES.md`
- `config/`
- `fixtures/`
- `scripts/`
- `.github/workflows/`
