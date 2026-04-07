#!/usr/bin/env python3
"""
rewrite.py — stdin JSON -> output-control regeneration -> stdout JSON

stdin:
{
  "conversation": [
    {
      "role": "user|assistant|toolResult",
      "content": "...",
      "toolCalls": [{"name": "...", "params": {...}}],
      "toolResult": {"name": "...", "isError": false}
    }
  ],
  "asset": {...},
  "draft": "...",
  "reason": "..."
}

stdout:
{"output": "..."}
"""
import json
import sys
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s", stream=sys.stderr)

from lib import build_rewrite_user_message, rewrite_output_from_user_message


def main():
    raw = sys.stdin.read()
    params = json.loads(raw)
    user_prompt = params.get("userPrompt")
    if not isinstance(user_prompt, str) or not user_prompt.strip():
        user_prompt = build_rewrite_user_message(
            conversation=params.get("conversation", []),
            asset=params["asset"],
            draft=params["draft"],
            reason=params.get("reason", ""),
        )
    output = rewrite_output_from_user_message(user_prompt)
    json.dump({"output": output, "userPrompt": user_prompt}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
