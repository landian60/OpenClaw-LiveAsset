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

from lib import (  # noqa: E402
    _validate_atomic_checks,
    _validate_process_constraints,
    _validate_rule_text_fields,
    _validate_tools_contract,
    build_live_assets_session_key,
    normalize_controls,
)


class ControlContractsTest(unittest.TestCase):
    def test_validate_atomic_checks_requires_contains_syntax(self):
        with self.assertRaisesRegex(ValueError, "contains:"):
            _validate_atomic_checks(
                [{"check": "remove Google", "rewrite": "不要提 Google"}],
                "outputControl",
                "Verifier",
            )

    def test_validate_process_constraints_rejects_natural_language_when(self):
        with self.assertRaisesRegex(ValueError, "when"):
            _validate_process_constraints(
                [
                    {
                        "when": "user requests academic paper search",
                        "then": "require:arxiv_search",
                        "reason": "bad natural language when",
                    }
                ],
                "Verifier",
            )

    def test_validate_rule_text_fields_requires_inject_or_rewrite(self):
        with self.assertRaisesRegex(ValueError, "inject"):
            _validate_rule_text_fields(
                [{"check": "contains:arxiv", "reason": "wrong field"}],
                "inputControl",
                "inject",
                "Verifier",
            )
        with self.assertRaisesRegex(ValueError, "rewrite"):
            _validate_rule_text_fields(
                [{"check": "!contains:Perplexity", "reason": "wrong field"}],
                "outputControl",
                "rewrite",
                "Verifier",
            )

    def test_validate_tools_contract_requires_runtime_fields(self):
        with self.assertRaisesRegex(ValueError, "mockResponse"):
            _validate_tools_contract(
                [{"name": "web_search", "description": "desc", "parameters": {"type": "object"}}],
                "Verifier",
            )

    def test_normalize_controls_fills_missing_sections(self):
        self.assertEqual(
            normalize_controls({"outputControl": [{"check": "!contains:Google", "rewrite": "不要提 Google"}]}),
            {
                "inputControl": [],
                "processControl": [],
                "outputControl": [{"check": "!contains:Google", "rewrite": "不要提 Google"}],
                "tools": [],
            },
        )

    def test_build_live_assets_session_key_uses_stable_internal_namespace(self):
        self.assertEqual(
            build_live_assets_session_key("verify"),
            "agent:main:live-assets-verify",
        )


if __name__ == "__main__":
    unittest.main()
