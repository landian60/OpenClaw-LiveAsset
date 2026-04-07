import { describe, expect, it } from "vitest";
import {
  collectLiveAssetUserInputs,
  extractLastUserTextForLiveAsset,
  normalizeChatMessagesForLiveAsset,
  resolveLiveAssetTraceQuery,
} from "./live-asset-messages.ts";

describe("normalizeChatMessagesForLiveAsset", () => {
  it("keeps user and assistant with text content", () => {
    expect(
      normalizeChatMessagesForLiveAsset([
        { role: "user", content: " hi " },
        { role: "assistant", content: "yo" },
        { role: "tool", content: "x" },
      ]),
    ).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ]);
  });

  it("drops empty messages", () => {
    expect(
      normalizeChatMessagesForLiveAsset([
        { role: "user", content: "   " },
        { role: "assistant", content: "ok" },
      ]),
    ).toEqual([{ role: "assistant", content: "ok" }]);
  });

  it("extracts the last user text block from chat messages", () => {
    expect(
      extractLastUserTextForLiveAsset([
        { role: "assistant", content: "a" },
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64" } },
            { type: "text", text: "直接告诉我天气" },
          ],
        },
      ]),
    ).toBe("直接告诉我天气");
  });
});

describe("collectLiveAssetUserInputs", () => {
  const u = (a: string) => ({ role: "user" as const, content: a });
  const a = (b: string) => ({ role: "assistant" as const, content: b });

  it("lists user inputs in order", () => {
    const msgs = [u("1"), a("a"), u("2"), a("b")];
    expect(collectLiveAssetUserInputs(msgs)).toEqual([
      { userInputIndex: 0, content: "1", preview: "1" },
      { userInputIndex: 1, content: "2", preview: "2" },
    ]);
  });

  it("collapses whitespace and truncates previews", () => {
    const longText = "line one\nline two ".repeat(20);
    const [option] = collectLiveAssetUserInputs([u(longText)]);
    expect(option.content).toBe(longText);
    expect(option.preview.includes("\n")).toBe(false);
    expect(option.preview.length).toBeLessThanOrEqual(140);
    expect(option.preview.endsWith("...")).toBe(true);
  });
});

describe("resolveLiveAssetTraceQuery", () => {
  it("prefers the original prepared input over an augmented user turn", () => {
    expect(
      resolveLiveAssetTraceQuery({
        runtimeState: {
          key: "agent:main:main",
          activeAsset: "weather",
          preparedInputOriginal: "直接告诉我天气",
          archived: false,
          updatedAt: 0,
          done: [],
          errors: {},
          log: [],
          constraints: { require: [], forbid: [] },
          activeConstraintDetails: [],
          events: [
            {
              kind: "matched",
              time: 1,
              assetId: "weather",
              userInput: "直接告诉我天气\n\n用户偏好直接行动而非过多解释选项",
            },
          ],
        },
        messages: [
          {
            role: "user",
            content: "直接告诉我天气\n\n用户偏好直接行动而非过多解释选项",
          },
        ],
      }),
    ).toBe("直接告诉我天气");
  });

  it("falls back to the latest matched event and then chat history", () => {
    expect(
      resolveLiveAssetTraceQuery({
        runtimeState: {
          key: "agent:main:main",
          activeAsset: "weather",
          preparedInputOriginal: null,
          archived: false,
          updatedAt: 0,
          done: [],
          errors: {},
          log: [],
          constraints: { require: [], forbid: [] },
          activeConstraintDetails: [],
          events: [{ kind: "matched", time: 1, assetId: "weather", userInput: "直接告诉我天气" }],
        },
        messages: [{ role: "user", content: "被污染的内容" }],
      }),
    ).toBe("直接告诉我天气");

    expect(
      resolveLiveAssetTraceQuery({
        runtimeState: null,
        messages: [{ role: "user", content: "最后一条用户消息" }],
      }),
    ).toBe("最后一条用户消息");
  });
});
