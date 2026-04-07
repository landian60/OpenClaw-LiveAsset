#!/usr/bin/env python3
"""
generate.py — stdin JSON conversation -> generate_asset -> save -> reload -> stdout JSON

Accepts two input formats:
  1. {"messages": [{"role":"user","content":"..."}, {"role":"assistant","content":"..."}, ...]}
     (from OpenClaw session history — the "Save as Asset" button path)
  2. {"user_turns": [...], "assistant_outputs": [...]}
     (legacy eval_samples format)

stdout: {"ok": true, "assetId": "...", "asset": {...}}
"""
import json
import sys
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s", stream=sys.stderr)

from lib import generate_asset, save_asset, notify_plugin_reload, load_assets, find_matching_asset, get_opening_user_utterance, update_generate_asset, strip_known_input_augmentations


def merge_consecutive_same_role(messages: list[dict]) -> list[dict]:
    """
    OpenClaw JSONL often stores multiple assistant (or user) lines per logical turn
    (streaming chunks, tool rounds). Merge consecutive same-role text into one block
    so user_turn / assistant counts match what humans consider "turns".
    Preserves toolCalls and toolResult through merges.
    toolResult messages are never merged with adjacent messages.
    """
    out: list[dict] = []
    for msg in messages:
        role = msg.get("role", "")
        content = (msg.get("content") or "").strip()
        tool_calls = msg.get("toolCalls", [])
        tool_result = msg.get("toolResult")
        if not content and not tool_calls and not tool_result:
            continue
        # Never merge toolResult messages with adjacent messages
        if role == "toolResult":
            entry: dict = {"role": role, "content": content}
            if tool_result:
                entry["toolResult"] = tool_result
            out.append(entry)
            continue
        if not out or out[-1].get("role") != role:
            entry = {"role": role, "content": content}
            if tool_calls:
                entry["toolCalls"] = list(tool_calls)
            out.append(entry)
        else:
            prev = out[-1]["content"]
            if content:
                out[-1]["content"] = f"{prev}\n\n{content}".strip()
            if tool_calls:
                out[-1].setdefault("toolCalls", []).extend(tool_calls)
    return out


def messages_to_sample(messages: list[dict]) -> dict:
    """Convert OpenClaw messages format to the eval_samples format that generate_asset expects."""
    raw_n = len(messages)
    messages = merge_consecutive_same_role(messages)
    user_turns = []
    assistant_outputs = []
    turn = 0

    for msg in messages:
        role = msg.get("role", "")
        content = msg.get("content", "")
        tool_calls = msg.get("toolCalls", [])
        tool_result = msg.get("toolResult")
        if not content and not tool_calls and not tool_result:
            continue
        if role == "user":
            turn += 1
            user_turns.append(content)
        elif role == "assistant":
            if assistant_outputs and assistant_outputs[-1].get("after_turn") == turn:
                existing = assistant_outputs[-1]
                prev_content = existing.get("content", "")
                if content:
                    existing["content"] = f"{prev_content}\n\n{content}".strip() if prev_content else content
                if tool_calls:
                    existing.setdefault("tool_calls", []).extend(tool_calls)
            else:
                assistant_outputs.append({
                    "after_turn": turn,
                    "content": content,
                    "tool_calls": tool_calls if tool_calls else [],
                })
        elif role == "toolResult" and assistant_outputs:
            # Attach tool result to the most recent assistant output
            assistant_outputs[-1].setdefault("tool_results", []).append({
                "name": tool_result.get("name", "") if tool_result else "",
                "content": content,
                "is_error": tool_result.get("isError", False) if tool_result else False,
            })

    logging.info(
        "messages_to_sample: %d raw -> %d after same-role merge -> %d user turns, %d assistant blocks",
        raw_n,
        len(messages),
        len(user_turns),
        len(assistant_outputs),
    )
    return {"user_turns": user_turns, "assistant_outputs": assistant_outputs}


def main():
    raw = sys.stdin.read()
    data = json.loads(raw)

    if "messages" in data:
        sample = messages_to_sample(data["messages"])
    else:
        sample = data

    if not sample.get("user_turns"):
        json.dump({"ok": False, "error": "No user turns found in input"}, sys.stdout, ensure_ascii=False)
        return

    existing = load_assets()
    sample, stripped_count = strip_known_input_augmentations(sample, existing)
    if stripped_count:
        logging.info("stripped %d known input augmentation block(s) before match routing", stripped_count)

    # Condition 1: check if opening message already matches an existing asset
    opening = get_opening_user_utterance(sample)
    hit = find_matching_asset(opening, existing)
    if hit:
        logging.info("Opening matches existing asset '%s' — routing to update_generate_asset", hit.get("assetId"))
        asset = update_generate_asset(sample, hit)
    else:
        asset = generate_asset(sample)

    path = save_asset(asset)

    logging.info("Asset saved to %s", path)
    notify_plugin_reload()

    result = {
        "ok": True,
        "assetId": asset.get("assetId"),
        "asset": asset,
    }
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
