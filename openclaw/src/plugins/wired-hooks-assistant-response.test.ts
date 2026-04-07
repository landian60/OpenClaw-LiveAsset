import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

describe("assistant_response hook runner", () => {
  it("runs hooks sequentially and passes rewritten text to the next handler", async () => {
    const first = vi.fn().mockResolvedValue({ text: "first rewrite" });
    const second = vi.fn().mockResolvedValue({ text: "final rewrite" });
    const registry = createMockPluginRegistry([
      { hookName: "assistant_response", handler: first },
      { hookName: "assistant_response", handler: second },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runAssistantResponse(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5",
        assistantText: "original",
        assistantTexts: ["original"],
        messages: [],
      },
      {
        agentId: "main",
        sessionId: "session-1",
      },
    );

    expect(first).toHaveBeenCalledWith(
      expect.objectContaining({ assistantText: "original" }),
      expect.objectContaining({ sessionId: "session-1" }),
    );
    expect(second).toHaveBeenCalledWith(
      expect.objectContaining({ assistantText: "first rewrite" }),
      expect.objectContaining({ sessionId: "session-1" }),
    );
    expect(result).toEqual({ text: "final rewrite" });
  });
});
