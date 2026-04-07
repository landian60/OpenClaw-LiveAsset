import { describe, expect, it } from "vitest";
import { __testOnlyOpenAiHttp } from "./openai-http.js";

describe("openai passthrough response_format", () => {
  it("normalizes json_object requests", () => {
    expect(
      __testOnlyOpenAiHttp.normalizePassthroughResponseFormat({
        type: "json_object",
      }),
    ).toEqual({ type: "json_object" });
  });

  it("rejects invalid json_schema requests", () => {
    expect(() =>
      __testOnlyOpenAiHttp.normalizePassthroughResponseFormat({
        type: "json_schema",
        json_schema: { schema: {} },
      }),
    ).toThrow(/response_format\.json_schema\.name/);
  });

  it("maps response_format to openai-completions payloads", () => {
    const payload: Record<string, unknown> = {
      model: "qwen-plus",
      messages: [],
    };
    const responseFormat = __testOnlyOpenAiHttp.normalizePassthroughResponseFormat({
      type: "json_object",
    });
    expect(responseFormat).toBeDefined();
    __testOnlyOpenAiHttp.applyPassthroughResponseFormat(
      payload,
      responseFormat!,
      "openai-completions",
    );
    expect(payload.response_format).toEqual({ type: "json_object" });
  });

  it("maps chat-completions json_schema to responses text.format", () => {
    const payload: Record<string, unknown> = {
      model: "gpt-5",
      input: [],
      text: { verbosity: "low" },
    };
    const responseFormat = __testOnlyOpenAiHttp.normalizePassthroughResponseFormat({
      type: "json_schema",
      json_schema: {
        name: "asset",
        schema: { type: "object", additionalProperties: false },
        strict: true,
      },
    });
    expect(responseFormat).toBeDefined();
    __testOnlyOpenAiHttp.applyPassthroughResponseFormat(payload, responseFormat!, "openai-responses");
    expect(payload.text).toEqual({
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "asset",
        schema: { type: "object", additionalProperties: false },
        strict: true,
      },
    });
  });

  it("rejects unsupported passthrough model apis", () => {
    const responseFormat = __testOnlyOpenAiHttp.normalizePassthroughResponseFormat({
      type: "json_object",
    });
    expect(responseFormat).toBeDefined();
    expect(() =>
      __testOnlyOpenAiHttp.applyPassthroughResponseFormat({}, responseFormat!, "anthropic-messages"),
    ).toThrow(/response_format passthrough is not supported/);
  });

  it("normalizes fenced JSON when structured output was requested", () => {
    const responseFormat = __testOnlyOpenAiHttp.normalizePassthroughResponseFormat({
      type: "json_object",
    });
    expect(responseFormat).toBeDefined();
    expect(
      __testOnlyOpenAiHttp.normalizePassthroughResponseText(
        '```json\n{"ok":true}\n```',
        responseFormat!,
      ),
    ).toBe('{"ok":true}');
  });

  it("rejects non-JSON structured responses", () => {
    const responseFormat = __testOnlyOpenAiHttp.normalizePassthroughResponseFormat({
      type: "json_object",
    });
    expect(responseFormat).toBeDefined();
    expect(() =>
      __testOnlyOpenAiHttp.normalizePassthroughResponseText("hello", responseFormat!),
    ).toThrow(/Model violated response_format contract/);
  });
});
