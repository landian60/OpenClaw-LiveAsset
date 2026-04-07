import { describe, expect, it } from "vitest";
import type { LiveAssetRuntimeState } from "../app-view-state.ts";
const { renderLiveAssetRuntime } = await import("./chat.ts");

describe("chat live asset runtime trace", () => {
  it("renders process-control and rewrite details inside the LiveAsset runtime trace", () => {
    const runtimeState: LiveAssetRuntimeState = {
      key: "agent:main:main",
      activeAsset: "arxiv-paper-search",
      preparedInputOriginal: "今天 arXiv 上有什么 multimodal 论文",
      archived: true,
      updatedAt: 6,
      done: ["arxiv_search"],
      errors: {},
      log: [
        { tool: "arxiv_search", ok: true, time: 4 },
        { tool: "browser", ok: false, time: 5 },
      ],
      constraints: { require: ["arxiv_search"], forbid: [] },
      activeConstraintDetails: [
        {
          action: "require:arxiv_search",
          reason: "回答论文问题前必须先查 arXiv",
          when: "!done:arxiv_search",
        },
      ],
      events: [
        {
          kind: "process_requirement_blocked",
          time: 1,
          assetId: "arxiv-paper-search",
          reason: "arxiv_search（回答论文问题前必须先查 arXiv）",
          pendingTools: ["arxiv_search"],
          constraintDetails: [
            {
              action: "require:arxiv_search",
              reason: "回答论文问题前必须先查 arXiv",
              when: "!done:arxiv_search",
            },
          ],
        },
        {
          kind: "output_rewrite_started",
          time: 2,
          assetId: "arxiv-paper-search",
          reason: "禁止包含 Perplexity",
          rewritePrompt: "对话历史:\n[user]: 今天 arXiv 上有什么 multimodal 论文",
        },
        {
          kind: "output_rewrite_passed",
          time: 3,
          assetId: "arxiv-paper-search",
          rewrittenText: "这是通过约束后的最终回复。",
        },
      ],
    };
    const template = renderLiveAssetRuntime(runtimeState);
    const serialized = JSON.stringify(template);

    expect(serialized).toContain("Active Process Rules");
    expect(serialized).toContain("captured trace");
    expect(serialized).toContain("Tool Calls");
    expect(serialized).toContain("Timeline");
    expect(serialized).toContain("✓ arxiv_search");
    expect(serialized).toContain("✗ browser");
    expect(serialized).toContain("require:arxiv_search");
    expect(serialized).toContain("回答论文问题前必须先查 arXiv");
    expect(serialized).toContain("final reply blocked: missing arxiv_search");
    expect(serialized).toContain("Missing Tools");
    expect(serialized).toContain("Triggered Rules");
    expect(serialized).toContain("output rewrite started: 禁止包含 Perplexity");
    expect(serialized).toContain("Rewrite Prompt");
    expect(serialized).toContain("今天 arXiv 上有什么 multimodal 论文");
    expect(serialized).toContain("Rewrite Output");
    expect(serialized).toContain("这是通过约束后的最终回复。");
  });
});
