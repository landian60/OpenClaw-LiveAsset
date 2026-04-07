#!/usr/bin/env python3
"""
feedback.py — stdin JSON -> Update loop with OpenClaw evidence -> stdout JSON

stdin:  {"asset_id": "...", "feedback": "...", "conversation": [...]}
stdout: {"status": "updated", "reasoning": {...}, "judge": {...}, "evidence": {...}, "asset": {...}, "attempt": N}
"""
import json
import sys
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s", stream=sys.stderr)

from lib import process_feedback


def main():
    raw = sys.stdin.read()
    params = json.loads(raw)

    result = process_feedback(
        asset_id=params["asset_id"],
        feedback=params["feedback"],
        conversation=params.get("conversation", []),
    )

    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
