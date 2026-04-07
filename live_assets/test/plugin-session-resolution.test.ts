import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  normalizeGenerateRequestBody,
  resolveGatewayTokenForInternalCalls,
  resolveLiveAssetsAgentId,
  resolveRuntimeSessionKeyFromHookContext,
} from "../src/plugin.ts";

test("resolveRuntimeSessionKeyFromHookContext reuses stable sessionKey for later tool hooks", () => {
  const sessionKeyById = new Map<string, string>();

  const first = resolveRuntimeSessionKeyFromHookContext(
    { sessionKey: "agent:main:webchat:abc", sessionId: "uuid-1" },
    {
      sessionKeyById,
      hasRuntimeSession: () => false,
      defaultSessionKey: "default",
    },
  );
  assert.equal(first, "agent:main:webchat:abc");
  assert.equal(sessionKeyById.get("uuid-1"), "agent:main:webchat:abc");

  const later = resolveRuntimeSessionKeyFromHookContext(
    { sessionId: "uuid-1" },
    {
      sessionKeyById,
      hasRuntimeSession: () => false,
      defaultSessionKey: "default",
    },
  );
  assert.equal(later, "agent:main:webchat:abc");
});

test("resolveRuntimeSessionKeyFromHookContext does not invent a runtime session from an unknown sessionId", () => {
  const resolved = resolveRuntimeSessionKeyFromHookContext(
    { sessionId: "uuid-unknown" },
    {
      sessionKeyById: new Map<string, string>(),
      hasRuntimeSession: () => false,
      defaultSessionKey: "default",
    },
  );
  assert.equal(resolved, "default");
});

test("resolveRuntimeSessionKeyFromHookContext preserves explicit runtime sessions keyed by sessionId", () => {
  const resolved = resolveRuntimeSessionKeyFromHookContext(
    { sessionId: "runtime-keyed-by-id" },
    {
      sessionKeyById: new Map<string, string>(),
      hasRuntimeSession: (candidate) => candidate === "runtime-keyed-by-id",
      defaultSessionKey: "default",
    },
  );
  assert.equal(resolved, "runtime-keyed-by-id");
});

test("resolveLiveAssetsAgentId prefers the agent encoded in sessionKey", () => {
  assert.equal(
    resolveLiveAssetsAgentId({
      sessionKey: "agent:beta:webchat:abc",
      agentId: "main",
    }),
    "beta",
  );
});

test("resolveLiveAssetsAgentId falls back to a normalized agentId", () => {
  assert.equal(resolveLiveAssetsAgentId({ agentId: "Research Agent" }), "research-agent");
  assert.equal(resolveLiveAssetsAgentId({}), "main");
});

test("normalizeGenerateRequestBody prefers explicit session transcript over flattened UI messages", () => {
  const body = normalizeGenerateRequestBody({
    parsed: {
      sessionKey: "agent:main:live-assets-ui:test",
      messages: [
        { role: "user", content: "查一下最热门的skill" },
        { role: "assistant", content: "信用额度不够，没法直接查。不过我可以换个方式帮你找。" },
      ],
    },
    transcriptMessages: [
      { role: "user", content: "查一下最热门的skill" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ name: "web_search", params: { query: "Popular OpenClaw Skills" } }],
      },
      {
        role: "toolResult",
        content: "{\"status\":\"error\"}",
        toolResult: { name: "web_search", isError: false },
      },
      { role: "assistant", content: "信用额度不够，没法直接查。不过我可以换个方式帮你找。" },
    ],
  });

  const normalizedMessages = body.messages as Array<{
    role: string;
    content: string;
    toolCalls?: Array<{ name: string; params?: unknown }>;
    toolResult?: { name: string; isError: boolean };
  }>;

  assert.equal(body.sessionKey, "agent:main:live-assets-ui:test");
  assert.equal(normalizedMessages.length, 4);
  assert.equal(normalizedMessages[1]?.toolCalls?.[0]?.name, "web_search");
  assert.deepEqual(normalizedMessages[1]?.toolCalls?.[0]?.params, { query: "Popular OpenClaw Skills" });
  assert.equal(normalizedMessages[2]?.role, "toolResult");
  assert.equal(normalizedMessages[2]?.toolResult?.name, "web_search");
  assert.equal(normalizedMessages[3]?.content, "信用额度不够，没法直接查。不过我可以换个方式帮你找。");
});

test("normalizeGenerateRequestBody prefers runtime session messages over polluted transcript messages", () => {
  const body = normalizeGenerateRequestBody({
    parsed: {
      sessionKey: "agent:zhn:main",
      messages: [{ role: "user", content: "最近有点烦，事情多" }],
    },
    runtimeMessages: [
      { role: "user", content: "最近有点烦，事情多" },
      { role: "assistant", content: "你说得对——我不该猜，而该先问。" },
      { role: "user", content: "不是啊，是让你问我的个人的事情来推理，而不是身外的事情" },
    ],
    transcriptMessages: [
      {
        role: "user",
        content:
          "最近有点烦，事情多\n\n请帮我理解我最近的情绪状态，不要猜测具体事件，而是通过我的表达方式和习惯来了解我的特质。",
      },
      { role: "assistant", content: "你说得对——我不该猜，而该先问。" },
      { role: "user", content: "不是啊，是让你问我的个人的事情来推理，而不是身外的事情" },
    ],
  });

  const normalizedMessages = body.messages as Array<{ role: string; content: string }>;

  assert.equal(normalizedMessages[0]?.content, "最近有点烦，事情多");
  assert.equal(normalizedMessages[1]?.content, "你说得对——我不该猜，而该先问。");
  assert.equal(
    normalizedMessages[2]?.content,
    "不是啊，是让你问我的个人的事情来推理，而不是身外的事情",
  );
});

test("normalizeGenerateRequestBody rejects sessionKey requests without transcript messages", () => {
  assert.throws(
    () => normalizeGenerateRequestBody({
      parsed: { sessionKey: "agent:main:live-assets-ui:missing", messages: [] },
    }),
    /transcript messages required/,
  );
});

test("normalizeGenerateRequestBody keeps request-body messages when sessionKey is absent", () => {
  const body = normalizeGenerateRequestBody({
    parsed: {
      messages: [
        { role: "user", content: "直接告诉我天气" },
        { role: "assistant", content: "我可以先解释几种查询方式。" },
        { role: "user", content: "别解释，直接给结果" },
      ],
    },
    transcriptMessages: [
      {
        role: "user",
        content:
          "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats.",
      },
    ],
  });

  const normalizedMessages = body.messages as Array<{ role: string; content: string }>;

  assert.equal(normalizedMessages.length, 3);
  assert.equal(normalizedMessages[0]?.content, "直接告诉我天气");
  assert.equal(normalizedMessages[1]?.content, "我可以先解释几种查询方式。");
  assert.equal(normalizedMessages[2]?.content, "别解释，直接给结果");
});

test("resolveGatewayTokenForInternalCalls prefers local config token over drifted env token", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "live-assets-plugin-"));
  const configPath = path.join(tempDir, "openclaw.json");
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        gateway: {
          auth: {
            token: "config-token",
          },
        },
      }),
      "utf8",
    );

    const token = resolveGatewayTokenForInternalCalls({
      api: { resolvePath: (input: string) => input } as never,
      gatewayUrl: "http://127.0.0.1:18789",
      envToken: "env-token",
      configPath,
    });

    assert.equal(token, "config-token");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveGatewayTokenForInternalCalls falls back to env token for remote or templated config", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "live-assets-plugin-"));
  const configPath = path.join(tempDir, "openclaw.json");
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        gateway: {
          auth: {
            token: "${OPENCLAW_GATEWAY_TOKEN}",
          },
        },
      }),
      "utf8",
    );

    assert.equal(
      resolveGatewayTokenForInternalCalls({
        api: { resolvePath: (input: string) => input } as never,
        gatewayUrl: "http://127.0.0.1:18789",
        envToken: "env-token",
        configPath,
      }),
      "env-token",
    );
    assert.equal(
      resolveGatewayTokenForInternalCalls({
        api: { resolvePath: (input: string) => input } as never,
        gatewayUrl: "https://gateway.example.com",
        envToken: "env-token",
        configPath,
      }),
      "env-token",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
