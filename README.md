<div align="center">



# LiveAssets: Compiling Interactive Guidance into Executable Procedural Memory for Personal Agents

English | [中文](./README.zh-CN.md)

<br/>
<img src="docs/openclaw-liveasset-introduction.png" alt="OpenClaw-LiveAsset" width="700">


<p>
  <a href="https://github.com/landian60/OpenClaw-LiveAsset"><img src="https://img.shields.io/badge/github-OpenClaw--LiveAsset-181717?style=flat&labelColor=555&logo=github&logoColor=white" alt="GitHub"></a>
  <img src="https://img.shields.io/badge/🔌_OpenClaw_Plugin-orange?style=flat&labelColor=555" alt="OpenClaw Plugin" />
  <img src="https://img.shields.io/badge/🧠_Procedural_Memory-blue?style=flat&labelColor=555" alt="Procedural Memory" />
  <img src="https://img.shields.io/badge/📄_No_Training-green?style=flat&labelColor=555" alt="No Training" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat" alt="MIT License"></a>
</p>

<p>
  <a href="docs/LiveAsset_Blog_ming.pdf"><strong>LiveAsset Technical Report</strong></a>
</p>

<p>
  <video src="https://github.com/user-attachments/assets/490add0d-02b4-4dbd-93fb-a52658049929" controls width="600"></video>
</p>

</div>

---

## News

- **[2026/04/07]** We release **OpenClaw-LiveAsset** — an OpenClaw plugin that turns user corrections into reusable, executable procedural assets. No fine-tuning required.

---

## Overview

**OpenClaw-LiveAsset** compiles interactive user guidance into visible, editable runtime assets that serve as executable procedural memory for personal agents.

Each LiveAsset is a bounded procedural asset that encodes matching conditions, input control, process control, and output control, so user corrections persist across sessions and are enforced deterministically at runtime. When users provide follow-up feedback, LiveAssets updates the asset, runs it again on the original query in OpenClaw, and checks whether the new result actually fixes the problem. The overall design is inspired by [ACT-R](http://act-r.psy.cmu.edu/wordpress/wp-content/uploads/2012/12/526FSQUERY.pdf).

This repository packages a runnable [OpenClaw](https://openclaw.ai) snapshot together with the LiveAsset plugin. `openclaw/` is the upstream runtime. `live_assets/` is the plugin. All local state lives under `.local/`.

### Key Features

**Visible runtime assets** — Keeps user corrections as bounded, editable runtime assets instead of buried prompt tweaks or weight changes.

**Validated asset generation** — Compiles multi-turn corrections through a Match Agent and a Control Agent, then validates and repairs matching before saving the asset.

**Deterministic execution** — Assets apply inspectable matching logic together with input control, process control, and output control at runtime.

**Closed-loop update** — After feedback, LiveAssets updates the asset, reruns the same query, and checks the new result before keeping the change.

**Visual workbench** — A built-in web UI for inspecting activation traces, editing assets directly, and refining rules without reading JSON.

### Comparison

This high-level comparison follows the framing in the technical report.

| Approach | Primary unit | Procedural logic | Deterministic enforcement | User-visible and editable |
|----------|--------------|------------------|---------------------------|---------------------------|
| Memory systems | Facts and preferences | No | No | Limited |
| Skill modules | Prompts and tool allowlists | Limited | No | Limited |
| Training-based methods | Model weights | No | Embedded in weights | No |
| LiveAssets | Bounded runtime assets | Yes | Yes | Yes |

---

## Quick Start

### Prerequisites

- Node.js `>=22.12.0`
- `pnpm`
- Python `3.11+`
- `curl`

### 1. Install and configure

```bash
cp .env.example .env          # configure your API keys
./scripts/bootstrap.sh
./scripts/check.sh
```

For the preset demo, `OPENAI_API_KEY` is the only required variable. Set `OPENAI_API_BASE_URL` and `OPENAI_MODEL` only when using an OpenAI-compatible endpoint. Root scripts load `./.env` by default. To use a different env file, set `ARTIFACT_ENV_PATH=/absolute/path/to/.env`.

### 2. Pick a startup path

If you want the fastest demo, run:

```bash
./scripts/run-preset.sh
```

This creates a preset config under `.local/preset/`, seeds `fixtures/assets/` into the asset directory, and starts the gateway with the Control UI and `/live-assets/` UI.

Supported modes:
- **Default OpenAI:** set `OPENAI_API_KEY`
- **OpenAI-compatible endpoint:** set `OPENAI_API_KEY`, `OPENAI_API_BASE_URL`, and `OPENAI_MODEL` (must be the raw model ID expected by the endpoint)

If you want the full OpenClaw onboarding flow, run:

```bash
./scripts/init-real.sh
./scripts/run-real.sh
```

`init-real.sh` runs the onboarding wizard with repo-local `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH`, then mounts `live_assets` into the generated config.

After startup, the terminal prints the local Control UI and LiveAssets URLs. Then chat naturally and correct the agent; LiveAsset captures feedback in the background.

### 3. Useful commands

| Task | Command |
|------|---------|
| Stop preset gateway | `OPENCLAW_STATE_DIR=.local/preset/state OPENCLAW_CONFIG_PATH=.local/preset/state/openclaw.json node openclaw/openclaw.mjs gateway stop` |
| Stop real gateway | `OPENCLAW_STATE_DIR=.local/real/state OPENCLAW_CONFIG_PATH=.local/real/state/openclaw.json node openclaw/openclaw.mjs gateway stop` |
| Reset preset state | `ARTIFACT_RESET=1 ./scripts/run-preset.sh` |
| Reset real onboarding state | `ARTIFACT_RESET=1 ./scripts/init-real.sh` |
| Rebuild after source changes | `ARTIFACT_FORCE_BOOTSTRAP=1 ./scripts/bootstrap.sh` |
| Rebuild UI only | `pnpm --dir openclaw run ui:build` |

---

## Acknowledgements

OpenClaw-LiveAsset builds on top of:

- [OpenClaw](https://openclaw.ai) — the core personal AI assistant framework.
---

## Citation

If you use OpenClaw-LiveAsset in academic work, please cite the technical report:

- [LiveAsset Technical Report](docs/LiveAsset_Blog_ming.pdf)

BibTeX will be added here after the citation metadata is finalized.

---

## License

This project is licensed under the [MIT License](LICENSE).
