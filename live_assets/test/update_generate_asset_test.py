import os
import sys
import tempfile
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

from lib import build_input_augmentation_text, strip_known_input_augmentations, strip_update_input_augmentation, update_generate_asset  # noqa: E402
import lib  # noqa: E402


class UpdateGenerateAssetTest(unittest.TestCase):
    def test_build_input_augmentation_text_does_not_append_trailing_full_stop(self):
        asset = [
            {
                "check": "contains:周报",
                "inject": "请按项目拆分 bullet 总结",
                "example": [
                    {"role": "user", "content": "帮我写周报"},
                    {"role": "assistant", "content": "好的，我按项目拆分。"},
                ],
            }
        ]

        augmentation = build_input_augmentation_text(asset, "帮我写周报")

        self.assertEqual(
            augmentation,
            "请按项目拆分 bullet 总结。参考对话：用户「帮我写周报」 → 助手「好的，我按项目拆分。」",
        )

    def test_build_input_augmentation_text_uses_english_labels_and_punctuation_for_english_queries(self):
        asset = [
            {
                "check": "contains:report",
                "inject": "Please split the summary by project",
                "example": [
                    {"role": "user", "content": "Help me write a weekly report"},
                    {"role": "assistant", "content": "Sure, I will organize it by project."},
                ],
            }
        ]

        augmentation = build_input_augmentation_text(asset, "Help me write a weekly report")

        self.assertEqual(
            augmentation,
            "Please split the summary by project. Example conversation: User: Help me write a weekly report -> Assistant: Sure, I will organize it by project.",
        )

    def test_strip_known_input_augmentations_uses_matching_asset(self):
        assets = [
            {
                "assetId": "weekly-report",
                "matching": {"any": ["周报"], "all": [], "not": []},
                "inputControl": [
                    {
                        "check": "contains:周报",
                        "inject": "请按项目拆分 bullet 总结",
                        "example": [
                            {"role": "user", "content": "帮我写周报"},
                            {"role": "assistant", "content": "好的，我按项目拆分。"},
                        ],
                    }
                ],
            }
        ]
        sample = {
            "user_turns": [
                "帮我写周报\n\n请按项目拆分 bullet 总结。参考对话：用户「帮我写周报」 → 助手「好的，我按项目拆分。」。",
                "再压缩一点",
            ],
            "assistant_outputs": [],
        }

        cleaned, stripped_count = strip_known_input_augmentations(sample, assets)

        self.assertEqual(stripped_count, 1)
        self.assertEqual(cleaned["user_turns"][0], "帮我写周报")
        self.assertEqual(cleaned["user_turns"][1], "再压缩一点")

    def test_strip_known_input_augmentations_accepts_english_variant(self):
        assets = [
            {
                "assetId": "weekly-report-en",
                "matching": {"any": ["weekly report"], "all": [], "not": []},
                "inputControl": [
                    {
                        "check": "contains:report",
                        "inject": "Please split the summary by project",
                        "example": [
                            {"role": "user", "content": "Help me write a weekly report"},
                            {"role": "assistant", "content": "Sure, I will organize it by project."},
                        ],
                    }
                ],
            }
        ]
        sample = {
            "user_turns": [
                "Help me write a weekly report\n\nPlease split the summary by project. Example conversation: User: Help me write a weekly report -> Assistant: Sure, I will organize it by project..",
            ],
            "assistant_outputs": [],
        }

        cleaned, stripped_count = strip_known_input_augmentations(sample, assets)

        self.assertEqual(stripped_count, 1)
        self.assertEqual(cleaned["user_turns"][0], "Help me write a weekly report")

    def test_strip_update_input_augmentation_only_on_update_sample(self):
        asset = {
            "assetId": "weekly-report",
            "inputControl": [
                {
                    "check": "contains:周报",
                    "inject": "请按项目拆分 bullet 总结",
                    "example": [
                        {"role": "user", "content": "帮我写周报"},
                        {"role": "assistant", "content": "好的，我按项目拆分。"},
                    ],
                }
            ],
        }
        sample = {
            "user_turns": [
                "帮我写周报\n\n请按项目拆分 bullet 总结。参考对话：用户「帮我写周报」 → 助手「好的，我按项目拆分。」。",
                "再压缩一点",
            ],
            "assistant_outputs": [],
        }

        cleaned, stripped_count = strip_update_input_augmentation(sample, asset)

        self.assertEqual(stripped_count, 1)
        self.assertEqual(cleaned["user_turns"][0], "帮我写周报")
        self.assertEqual(cleaned["user_turns"][1], "再压缩一点")

    def test_update_generate_asset_puts_current_asset_in_separate_user_message(self):
        recorded_messages = []

        def fake_openclaw_json_chat(messages, *, purpose, agent_name, round_id):
            recorded_messages.append(messages)
            self.assertEqual(purpose, "update-generate")
            self.assertEqual(agent_name, "Update Agent")
            self.assertEqual(round_id, "1")
            return {
                "matching": {"any": ["周报"], "all": [], "not": []},
                "positive_scenarios": ["帮我写周报", "写一下周报", "生成本周周报"],
                "negative_scenarios": ["写日报", "帮我查论文", "总结会议纪要"],
                "inputControl": [],
                "processControl": [],
                "outputControl": [],
                "tools": [],
                "utilityScore": 88,
            }

        original_openclaw_json_chat = lib.openclaw_json_chat
        original_assets_dir = lib.ASSETS_DIR
        try:
            lib.openclaw_json_chat = fake_openclaw_json_chat
            with tempfile.TemporaryDirectory() as tmpdir:
                lib.ASSETS_DIR = tmpdir
                old_asset = {
                    "assetId": "weekly-report",
                    "scenarioId": "report",
                    "matching": {"any": ["周报"], "all": [], "not": []},
                    "inputControl": [
                        {
                            "check": "contains:周报",
                            "inject": "请按项目拆分 bullet 总结",
                            "example": [
                                {"role": "user", "content": "帮我写周报"},
                                {"role": "assistant", "content": "好的，我按项目拆分。"},
                            ],
                        }
                    ],
                    "processControl": [],
                    "outputControl": [],
                    "tools": [],
                    "version": 3,
                    "updateLog": [],
                }
                sample = {
                    "user_turns": [
                        "帮我写周报\n\n请按项目拆分 bullet 总结。参考对话：用户「帮我写周报」 → 助手「好的，我按项目拆分。」。",
                        "再压缩一点",
                    ],
                    "assistant_outputs": [],
                }

                updated = update_generate_asset(sample, old_asset)
        finally:
            lib.openclaw_json_chat = original_openclaw_json_chat
            lib.ASSETS_DIR = original_assets_dir

        self.assertEqual(len(recorded_messages), 1)
        system_message = recorded_messages[0][0]["content"]
        asset_message = recorded_messages[0][1]["content"]
        conversation_message = recorded_messages[0][2]["content"]

        self.assertNotIn("当前资产 JSON", system_message)
        self.assertNotIn('"assetId": "weekly-report"', system_message)
        self.assertIn("当前资产 JSON", asset_message)
        self.assertIn('"assetId": "weekly-report"', asset_message)
        self.assertIn("首轮用户发言", conversation_message)
        self.assertIn("当前 UI 对话", conversation_message)
        self.assertIn("帮我写周报", conversation_message)
        self.assertNotIn("请按项目拆分 bullet 总结", conversation_message)
        self.assertEqual(updated["assetId"], "weekly-report")
        self.assertEqual(updated["version"], 4)
        self.assertEqual(updated["utilityScore"], 88)


if __name__ == "__main__":
    unittest.main()
