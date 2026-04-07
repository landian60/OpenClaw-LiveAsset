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
requests_stub.request = lambda *args, **kwargs: None
requests_stub.Session = lambda: None
sys.modules.setdefault("requests", requests_stub)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import lib


class FakeResponse:
    ok = True
    status_code = 200
    text = ""

    def json(self):
        return {"choices": [{"message": {"content": "rewritten"}}]}


class FakeSession:
    def __init__(self):
        self.trust_env = True
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append(
            {
                "method": method,
                "url": url,
                "trust_env": self.trust_env,
                "kwargs": kwargs,
            }
        )
        return FakeResponse()

    def close(self):
        return None


class GatewayProxyTest(unittest.TestCase):
    def test_openclaw_chat_bypasses_env_proxy_for_loopback_gateway(self):
        original_url = lib.OPENCLAW_GATEWAY_URL
        original_session = getattr(lib.http_requests, "Session", None)
        fake_session = FakeSession()
        try:
            lib.OPENCLAW_GATEWAY_URL = "http://127.0.0.1:18789"
            lib.http_requests.Session = lambda: fake_session

            output = lib.openclaw_chat([{"role": "user", "content": "hi"}], purpose="rewrite")

            self.assertEqual(output, "rewritten")
            self.assertEqual(len(fake_session.calls), 1)
            self.assertFalse(fake_session.calls[0]["trust_env"])
            self.assertEqual(fake_session.calls[0]["url"], "http://127.0.0.1:18789/v1/chat/completions")
        finally:
            lib.OPENCLAW_GATEWAY_URL = original_url
            if original_session is not None:
                lib.http_requests.Session = original_session


if __name__ == "__main__":
    unittest.main()
