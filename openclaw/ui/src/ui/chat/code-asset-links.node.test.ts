import { describe, expect, it } from "vitest";
import type { CodeAssetEntry } from "../controllers/code-assets.ts";
import type { MessageGroup } from "../types/chat-types.ts";
import { attachCodeAssetLinks, matchCodeAssetsForText } from "./code-asset-links.ts";

function createAsset(overrides: Partial<CodeAssetEntry> = {}): CodeAssetEntry {
  return {
    id: "be_direct_skip_fluff",
    name: "be_direct_skip_fluff",
    scenarioType: "behavioral_guidance",
    utility: 0.8,
    examples: 0,
    keywords: ["直接"],
    instruction: "",
    scope: { users: [], channels: [], agents: [], taskTypes: [] },
    trigger: { keywords: ["直接", "别解释"], regex: [], contextSignals: [] },
    controls: {
      replyRules: [],
      processRules: [],
      requiredChecks: [],
      outputShape: { tone: "", verbosity: "", format: "", structure: "" },
    },
    runtime: { enabled: false, mode: "advisory", conditions: [], sequence: [] },
    analysis: {
      lastFeedbackType: "",
      rootCause: "",
      reason: "",
      expandedKeywords: [],
      updatedAt: null,
    },
    artifacts: [],
    evalCases: [],
    history: [],
    lastUpdated: null,
    ...overrides,
  };
}

function createGroup(role: string, text: string, key: string): MessageGroup {
  return {
    kind: "group",
    key,
    role,
    messages: [{ key: `${key}:0`, message: { role, content: text, timestamp: 1000 } }],
    timestamp: 1000,
    isStreaming: false,
  };
}

describe("code asset chat links", () => {
  it("matches assets from trigger keywords", () => {
    const matches = matchCodeAssetsForText("别解释，直接给我下一步。", [createAsset()]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe("be_direct_skip_fluff");
  });

  it("inherits the triggering asset from the preceding user turn", () => {
    const assets = [createAsset()];
    const items = attachCodeAssetLinks(
      [
        createGroup("user", "别解释，直接给我下一步。", "user-1"),
        createGroup("assistant", "先执行这条命令。", "assistant-1"),
      ],
      assets,
    );

    expect(items[0]).toMatchObject({
      kind: "group",
      codeAssetOrigin: "direct",
    });
    expect(items[1]).toMatchObject({
      kind: "group",
      codeAssetOrigin: "turn",
    });
  });

  it("supports regex triggers when keywords are absent", () => {
    const asset = createAsset({
      id: "document_analysis_depth",
      name: "document_analysis_depth",
      keywords: [],
      trigger: {
        keywords: [],
        regex: ["proposal|supervisor feedback"],
        contextSignals: [],
      },
    });
    const matches = matchCodeAssetsForText(
      "帮我 review 这个 proposal，重点总结 supervisor feedback。",
      [asset],
    );
    expect(matches[0]?.id).toBe("document_analysis_depth");
  });

  it("does not match assets from internal asset ids alone", () => {
    const asset = createAsset({
      id: "document_analysis_depth",
      name: "document_analysis_depth",
      keywords: [],
      trigger: {
        keywords: [],
        regex: [],
        contextSignals: [],
      },
    });
    const matches = matchCodeAssetsForText("三个月前我随口说：别用depth。", [asset]);
    expect(matches).toHaveLength(0);
  });
});
