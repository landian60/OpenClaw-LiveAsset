#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path


def load_config(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"missing config: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(
            f"invalid JSON config at {path}: {exc}. Re-run ./scripts/init-real.sh to regenerate the repo-local OpenClaw config."
        ) from exc


def write_config(path: Path, config: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def normalize_endpoint_id(raw: str) -> str:
    trimmed = raw.strip().lower()
    if not trimmed:
        return ""
    out = []
    last_dash = False
    for ch in trimmed:
        keep = ("a" <= ch <= "z") or ("0" <= ch <= "9") or ch == "-"
        next_ch = ch if keep else "-"
        if next_ch == "-":
            if last_dash:
                continue
            last_dash = True
        else:
            last_dash = False
        out.append(next_ch)
    return "".join(out).strip("-")


def build_endpoint_id_from_url(base_url: str) -> str:
    from urllib.parse import urlparse

    try:
        parsed = urlparse(base_url)
    except ValueError:
        return "custom"
    host = "".join(ch.lower() if ch.isalnum() else "-" for ch in parsed.hostname or "")
    port = f"-{parsed.port}" if parsed.port else ""
    candidate = f"custom-{host}{port}"
    return normalize_endpoint_id(candidate) or "custom"


def resolve_unique_endpoint_id(requested_id: str, base_url: str, providers: dict) -> str:
    normalized = normalize_endpoint_id(requested_id) or "custom"
    existing = providers.get(normalized)
    if not isinstance(existing, dict) or not existing.get("baseUrl") or existing.get("baseUrl") == base_url:
        return normalized
    suffix = 2
    while True:
        candidate = f"{normalized}-{suffix}"
        if candidate not in providers:
            return candidate
        suffix += 1


def merge_provider_models(current: object, incoming: object) -> list:
    merged = {}
    for source in (current, incoming):
        if not isinstance(source, list):
            continue
        for entry in source:
            if not isinstance(entry, dict):
                continue
            model_id = entry.get("id")
            if not isinstance(model_id, str) or not model_id:
                continue
            prev = merged.get(model_id, {})
            if not isinstance(prev, dict):
                prev = {}
            merged[model_id] = {**prev, **copy.deepcopy(entry)}
    return list(merged.values())


def tune_provider_model_limits(args: argparse.Namespace) -> None:
    config_path = Path(args.config).resolve()
    provider_id = args.provider_id
    model_id = args.model_id
    context_window = int(args.context_window)
    max_tokens = int(args.max_tokens)
    if context_window <= 0 or max_tokens <= 0:
        raise SystemExit("context_window and max_tokens must be positive integers")

    config = load_config(config_path)
    providers = config.get("models", {}).get("providers")
    if not isinstance(providers, dict):
        print("noop")
        return
    provider = providers.get(provider_id)
    if not isinstance(provider, dict):
        print("noop")
        return
    models = provider.get("models")
    if not isinstance(models, list):
        print("noop")
        return

    updated = False
    for entry in models:
        if not isinstance(entry, dict) or entry.get("id") != model_id:
            continue
        if int(entry.get("contextWindow") or 0) < context_window:
            entry["contextWindow"] = context_window
            updated = True
        if int(entry.get("maxTokens") or 0) < max_tokens:
            entry["maxTokens"] = max_tokens
            updated = True
        break

    if not updated:
        print("noop")
        return

    write_config(config_path, config)
    print("updated")


def ensure_live_assets(args: argparse.Namespace) -> None:
    config_path = Path(args.config).resolve()
    plugin_dir = os.path.abspath(os.path.expanduser(args.plugin_dir))
    assets_dir = os.path.abspath(os.path.expanduser(args.assets_dir))
    python_bin = os.path.abspath(os.path.expanduser(args.python_bin))

    config = load_config(config_path)
    plugins = config.setdefault("plugins", {})
    plugins["enabled"] = True

    load = plugins.setdefault("load", {})
    paths = load.setdefault("paths", [])
    if not isinstance(paths, list):
        raise SystemExit("config path plugins.load.paths must be a list")
    if plugin_dir not in paths:
        paths.append(plugin_dir)

    entries = plugins.setdefault("entries", {})
    if not isinstance(entries, dict):
        raise SystemExit("config path plugins.entries must be an object")
    live_assets = entries.setdefault("live-assets", {})
    if not isinstance(live_assets, dict):
        raise SystemExit('config path plugins.entries["live-assets"] must be an object')
    live_assets["enabled"] = True

    plugin_config = live_assets.setdefault("config", {})
    if not isinstance(plugin_config, dict):
        raise SystemExit('config path plugins.entries["live-assets"].config must be an object')
    plugin_config["assetsDir"] = assets_dir
    plugin_config["pythonBin"] = python_bin
    plugin_config.pop("internalAgentId", None)

    gateway = config.setdefault("gateway", {})
    if not isinstance(gateway, dict):
        raise SystemExit("config path gateway must be an object")
    http = gateway.setdefault("http", {})
    if not isinstance(http, dict):
        raise SystemExit("config path gateway.http must be an object")
    endpoints = http.setdefault("endpoints", {})
    if not isinstance(endpoints, dict):
        raise SystemExit("config path gateway.http.endpoints must be an object")
    chat_completions = endpoints.setdefault("chatCompletions", {})
    if not isinstance(chat_completions, dict):
        raise SystemExit("config path gateway.http.endpoints.chatCompletions must be an object")
    chat_completions["enabled"] = True

    agents = config.setdefault("agents", {})
    if not isinstance(agents, dict):
        raise SystemExit("config path agents must be an object")
    agent_list = agents.setdefault("list", [])
    if not isinstance(agent_list, list):
        raise SystemExit("config path agents.list must be a list")
    agents["list"] = [
        entry
        for entry in agent_list
        if not (
            isinstance(entry, dict)
            and str(entry.get("id", "")).strip().lower() == "liveassets"
        )
    ]

    write_config(config_path, config)
    print(config_path)


def ensure_preset_tooling(args: argparse.Namespace) -> None:
    config_path = Path(args.config).resolve()
    config = load_config(config_path)

    tools = config.setdefault("tools", {})
    if not isinstance(tools, dict):
        raise SystemExit("config path tools must be an object")
    tools["profile"] = "full"

    browser = config.setdefault("browser", {})
    if not isinstance(browser, dict):
        raise SystemExit("config path browser must be an object")
    browser["enabled"] = True

    write_config(config_path, config)
    print(config_path)


def migrate_preset_custom_provider(args: argparse.Namespace) -> None:
    config_path = Path(args.config).resolve()
    base_url = args.base_url
    model_id = args.model_id
    config = load_config(config_path)

    models = config.get("models")
    if not isinstance(models, dict):
        print("noop")
        return
    providers = models.get("providers")
    if not isinstance(providers, dict):
        print("noop")
        return

    for provider_id, provider_value in providers.items():
        if provider_id == "openai":
            continue
        if not isinstance(provider_value, dict):
            continue
        if provider_value.get("baseUrl") != base_url or provider_value.get("api") != "openai-completions":
            continue
        provider_models = provider_value.get("models")
        if not isinstance(provider_models, list):
            continue
        if model_id in {entry.get("id") for entry in provider_models if isinstance(entry, dict)}:
            print(provider_id)
            return

    broken_provider = providers.get("openai")
    if not isinstance(broken_provider, dict):
        print("noop")
        return
    if broken_provider.get("baseUrl") != base_url or broken_provider.get("api") != "openai-completions":
        print("noop")
        return

    broken_models = broken_provider.get("models")
    if not isinstance(broken_models, list) or model_id not in {
        entry.get("id") for entry in broken_models if isinstance(entry, dict)
    }:
        print("noop")
        return

    target_provider_id = resolve_unique_endpoint_id(
        build_endpoint_id_from_url(base_url),
        base_url,
        {key: value for key, value in providers.items() if key != "openai"},
    )
    target_provider = providers.get(target_provider_id)
    if target_provider is not None and not isinstance(target_provider, dict):
        raise SystemExit(f'config path models.providers["{target_provider_id}"] must be an object')

    next_provider = copy.deepcopy(target_provider) if isinstance(target_provider, dict) else {}
    for key, value in broken_provider.items():
        if key == "models":
            continue
        next_provider.setdefault(key, copy.deepcopy(value))
    next_provider["baseUrl"] = base_url
    next_provider["api"] = "openai-completions"
    next_provider["models"] = merge_provider_models(next_provider.get("models"), broken_models)
    providers[target_provider_id] = next_provider
    del providers["openai"]

    broken_ref = f"openai/{model_id}"
    target_ref = f"{target_provider_id}/{model_id}"

    agents = config.get("agents")
    if isinstance(agents, dict):
        defaults = agents.get("defaults")
        if isinstance(defaults, dict):
            model = defaults.get("model")
            if isinstance(model, dict) and model.get("primary") == broken_ref:
                model["primary"] = target_ref
            model_entries = defaults.get("models")
            if isinstance(model_entries, dict) and broken_ref in model_entries:
                target_entry = model_entries.get(target_ref)
                if target_entry is not None and not isinstance(target_entry, dict):
                    raise SystemExit(
                        f'config path agents.defaults.models["{target_ref}"] must be an object'
                    )
                broken_entry = model_entries.pop(broken_ref)
                if target_ref not in model_entries:
                    model_entries[target_ref] = broken_entry
                elif isinstance(target_entry, dict) and isinstance(broken_entry, dict):
                    model_entries[target_ref] = {**broken_entry, **target_entry}

    write_config(config_path, config)
    print(target_provider_id)


def read_value(args: argparse.Namespace) -> None:
    config = load_config(Path(args.config).resolve())
    if args.field == "gateway-port":
        value = config.get("gateway", {}).get("port", 18789)
    elif args.field == "gateway-token":
        value = config.get("gateway", {}).get("auth", {}).get("token", "")
    elif args.field == "workspace":
        value = config.get("agents", {}).get("defaults", {}).get("workspace", "")
    else:
        raise SystemExit(f"unsupported field: {args.field}")

    if value is None:
        value = ""
    print(value)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    ensure_parser = subparsers.add_parser("ensure-live-assets")
    ensure_parser.add_argument("--config", required=True)
    ensure_parser.add_argument("--plugin-dir", required=True)
    ensure_parser.add_argument("--assets-dir", required=True)
    ensure_parser.add_argument("--python-bin", required=True)
    ensure_parser.set_defaults(func=ensure_live_assets)

    preset_tools_parser = subparsers.add_parser("ensure-preset-tooling")
    preset_tools_parser.add_argument("--config", required=True)
    preset_tools_parser.set_defaults(func=ensure_preset_tooling)

    migrate_parser = subparsers.add_parser("migrate-preset-custom-provider")
    migrate_parser.add_argument("--config", required=True)
    migrate_parser.add_argument("--base-url", required=True)
    migrate_parser.add_argument("--model-id", required=True)
    migrate_parser.set_defaults(func=migrate_preset_custom_provider)

    tune_parser = subparsers.add_parser("tune-provider-model-limits")
    tune_parser.add_argument("--config", required=True)
    tune_parser.add_argument("--provider-id", required=True)
    tune_parser.add_argument("--model-id", required=True)
    tune_parser.add_argument("--context-window", required=True, type=int)
    tune_parser.add_argument("--max-tokens", required=True, type=int)
    tune_parser.set_defaults(func=tune_provider_model_limits)

    read_parser = subparsers.add_parser("read")
    read_parser.add_argument("--config", required=True)
    read_parser.add_argument("field", choices=["gateway-port", "gateway-token", "workspace"])
    read_parser.set_defaults(func=read_value)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
