import { describe, expect, it } from "vitest";
import { resolveLiveAssetTraceQuery } from "./live-asset-messages.ts";

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

  it("falls back to runtime matched events and then chat history", () => {
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
