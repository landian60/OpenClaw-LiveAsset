import os
import sys
import types
import unittest

os.environ.setdefault("ASSETS_DIR", "/tmp")

openai_stub = types.ModuleType("openai")


class OpenAI:
    def __init__(self, *args, **kwargs):
        pass


openai_stub.OpenAI = OpenAI
sys.modules.setdefault("openai", openai_stub)

requests_stub = types.ModuleType("requests")
requests_stub.post = lambda *args, **kwargs: None
requests_stub.get = lambda *args, **kwargs: None
sys.modules.setdefault("requests", requests_stub)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from generate import messages_to_sample
from lib import check_output, format_conversation, format_conversation_simple, format_message_conversation


class RewriteFormatTest(unittest.TestCase):
    def test_format_message_conversation_preserves_tool_history(self):
        conversation = [
            {"role": "user", "content": "你要去网络查啊"},
            {
                "role": "assistant",
                "content": "看来额度不够，我先查。",
                "toolCalls": [
                    {
                        "name": "web_search",
                        "params": {"query": "recent research on memory in AI agents 2026"},
                    }
                ],
            },
            {
                "role": "toolResult",
                "content": '{"status":"error","tool":"web_search"}',
                "toolResult": {"name": "web_search", "isError": False},
            },
        ]

        self.assertEqual(
            format_message_conversation(conversation),
            "\n".join(
                [
                    "[user]: 你要去网络查啊",
                    "[assistant]: 看来额度不够，我先查。",
                    '[tool_call]: web_search({"query": "recent research on memory in AI agents 2026"})',
                    '[tool_result]web_search: {"status":"error","tool":"web_search"}',
                ]
            ),
        )

    def test_messages_to_sample_keeps_tool_use_when_same_turn_has_later_text_reply(self):
        sample = messages_to_sample(
            [
                {"role": "user", "content": "查一些热门skill"},
                {
                    "role": "assistant",
                    "content": "",
                    "toolCalls": [{"name": "web_search", "params": {"query": "Popular OpenClaw Skills"}}],
                },
                {
                    "role": "toolResult",
                    "content": '{"status":"error","tool":"web_search"}',
                    "toolResult": {"name": "web_search", "isError": False},
                },
                {
                    "role": "assistant",
                    "content": "信用额度不够，没法直接查“Popular OpenClaw Skills”。不过我可以换个方式帮你找。",
                },
            ]
        )

        self.assertEqual(
            sample["assistant_outputs"],
            [
                {
                    "after_turn": 1,
                    "content": "信用额度不够，没法直接查“Popular OpenClaw Skills”。不过我可以换个方式帮你找。",
                    "tool_calls": [{"name": "web_search", "params": {"query": "Popular OpenClaw Skills"}}],
                    "tool_results": [
                        {
                            "name": "web_search",
                            "content": '{"status":"error","tool":"web_search"}',
                            "is_error": False,
                        }
                    ],
                }
            ],
        )

        formatted = format_conversation(sample)
        self.assertIn('[工具调用]: web_search({"query": "Popular OpenClaw Skills"})', formatted)
        self.assertIn('[工具结果]web_search: {"status":"error","tool":"web_search"}', formatted)
        self.assertIn("信用额度不够，没法直接查", formatted)

    def test_format_conversation_keeps_chinese_labels_for_chinese_sample(self):
        sample = {
            "user_turns": ["帮我记饮食"],
            "assistant_outputs": [
                {
                    "after_turn": 1,
                    "content": "先告诉我你吃了什么。",
                    "tool_calls": [{"name": "write", "params": {"path": "memory/eating.md"}}],
                    "tool_results": [{"name": "write", "content": "ok", "is_error": False}],
                }
            ],
        }

        formatted = format_conversation(sample)

        self.assertIn("[用户 第1轮]: 帮我记饮食", formatted)
        self.assertIn('[工具调用]: write({"path": "memory/eating.md"})', formatted)
        self.assertIn("[工具结果]write: ok", formatted)
        self.assertIn("[助手回复]: 先告诉我你吃了什么。", formatted)

    def test_format_conversation_uses_english_labels_for_english_sample(self):
        sample = {
            "user_turns": ["save a file for my eating record"],
            "assistant_outputs": [
                {
                    "after_turn": 1,
                    "content": "What did you eat today?",
                    "tool_calls": [{"name": "write", "params": {"path": "memory/eating.md"}}],
                    "tool_results": [{"name": "write", "content": "ok", "is_error": False}],
                }
            ],
        }

        formatted = format_conversation(sample)

        self.assertIn("[user turn 1]: save a file for my eating record", formatted)
        self.assertIn('[tool_call]: write({"path": "memory/eating.md"})', formatted)
        self.assertIn("[tool_result]write: ok", formatted)
        self.assertIn("[assistant_reply]: What did you eat today?", formatted)
        self.assertNotIn("[用户 第1轮]", formatted)
        self.assertNotIn("[工具调用]", formatted)

    def test_format_conversation_simple_uses_english_labels_for_english_sample(self):
        sample = {
            "user_turns": ["help me search the web"],
            "assistant_outputs": [
                {
                    "after_turn": 1,
                    "content": "",
                    "tool_calls": [{"name": "web_search", "params": {"query": "latest hci papers"}}],
                }
            ],
        }

        formatted = format_conversation_simple(sample)

        self.assertEqual(
            formatted,
            "\n".join(
                [
                    "[user turn 1]: help me search the web",
                    "[tool_call]: web_search",
                ]
            ),
        )

    def test_check_output_uses_english_reason_when_requested(self):
        ok, failed, reason = check_output(
            "hello world",
            [{"check": "contains:append", "rewrite": "Include append."}],
            zh=False,
        )

        self.assertFalse(ok)
        self.assertEqual(failed, {"check": "contains:append", "rewrite": "Include append."})
        self.assertEqual(reason, "Missing required text: append")


if __name__ == "__main__":
    unittest.main()
