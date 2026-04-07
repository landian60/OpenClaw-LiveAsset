import assert from "node:assert/strict";
import test from "node:test";
import { buildRewriteConversationSnapshot } from "../src/plugin.js";

test("buildRewriteConversationSnapshot preserves tool-only assistant turns and tool results", () => {
  const messages = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            'Sender (untrusted metadata):\n```json\n{"label":"openclaw-control-ui","id":"openclaw-control-ui"}\n```\n\n[Sat 2026-03-28 00:17 GMT+8] 你要去网络查啊',
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "web_search",
          arguments: { query: "recent research on memory in AI agents 2026" },
        },
      ],
    },
    {
      role: "toolResult",
      toolName: "web_search",
      isError: false,
      content: [{ type: "text", text: '{"status":"error","tool":"web_search"}' }],
    },
  ];

  assert.deepEqual(buildRewriteConversationSnapshot(messages), [
    { role: "user", content: "你要去网络查啊" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          name: "web_search",
          params: { query: "recent research on memory in AI agents 2026" },
        },
      ],
    },
    {
      role: "toolResult",
      content: '{"status":"error","tool":"web_search"}',
      toolResult: { name: "web_search", isError: false },
    },
  ]);
});
