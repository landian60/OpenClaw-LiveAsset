import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import plugin, { resetLiveAssetsPluginRuntimeForTests } from "../src/plugin.ts";

test("assistant_response stops at unmet process requirements before output rewrite", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "live-assets-plugin-assistant-"));
  const warnings: string[] = [];
  const hooks = new Map<string, (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown>();

  try {
    await writeFile(
      path.join(tempDir, "product-comparison-search-en.json"),
      JSON.stringify({
        assetId: "product-comparison-search-en",
        scenarioId: "comparison_before_recommendation",
        matching: {
          any: ["alternatives", "reviews", "all options"],
          all: ["compare"],
          not: ["flight", "hotel", "travel booking"],
        },
        inputControl: [],
        processControl: [
          {
            when: "!done:web_search",
            then: "require:web_search",
            reason: "The user asked for comparison grounded in current options, so the agent must search before answering.",
          },
        ],
        outputControl: [
          { check: "contains:Price", rewrite: "Include price information in the comparison." },
          { check: "contains:http", rewrite: "Include source URLs in the comparison output." },
        ],
        tools: [],
        version: 1,
      }, null, 2),
      "utf8",
    );

    resetLiveAssetsPluginRuntimeForTests();
    plugin.register({
      pluginConfig: { assetsDir: tempDir },
      logger: {
        info: () => {},
        warn: (message: string) => warnings.push(message),
      },
      resolvePath: (input: string) => input,
      registerCommand: () => {},
      registerHttpRoute: () => {},
      registerTool: () => {},
      on: (hookName: string, handler: unknown) => {
        hooks.set(hookName, handler as (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown);
      },
    });

    const beforePromptBuild = hooks.get("before_prompt_build");
    const assistantResponse = hooks.get("assistant_response");

    assert.ok(beforePromptBuild);
    assert.ok(assistantResponse);

    await beforePromptBuild?.(
      {
        prompt: "ignored",
        messages: [{ role: "user", content: "Compare wireless headphones on price and reviews." }],
      },
      { sessionKey: "agent:main:main" },
    );

    const result = await assistantResponse?.(
      {
        assistantText: "I need to search for current wireless headphone options before I can compare them.",
        messages: [
          { role: "user", content: "Compare wireless headphones on price and reviews." },
          {
            role: "assistant",
            content: "I need to search for current wireless headphone options before I can compare them.",
          },
        ],
      },
      { sessionKey: "agent:main:main" },
    );

    assert.deepEqual(result, {
      text:
        "I cannot send a final reply yet. These required steps must finish first: " +
        "web_search (The user asked for comparison grounded in current options, so the agent must search before answering.). " +
        "Please try again.",
    });
    assert.ok(warnings.some((message) => message.includes("process constraints not met before final response")));
    assert.ok(warnings.every((message) => !message.includes("output constraint not met")));
  } finally {
    resetLiveAssetsPluginRuntimeForTests();
    await rm(tempDir, { recursive: true, force: true });
  }
});
