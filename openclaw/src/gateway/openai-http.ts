import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context, TextContent, ToolCall } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { getApiKeyForModel } from "../agents/model-auth.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
import { extractAssistantText } from "../agents/pi-embedded-utils.js";
import { applyExtraParamsToAgent } from "../agents/pi-embedded-runner/extra-params.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import type { ImageContent } from "../commands/agent/types.js";
import { loadConfig } from "../config/config.js";
import type { GatewayHttpChatCompletionsConfig } from "../config/types.gateway.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { logWarn } from "../logger.js";
import { estimateBase64DecodedBytes } from "../media/base64.js";
import {
  DEFAULT_INPUT_IMAGE_MAX_BYTES,
  DEFAULT_INPUT_IMAGE_MIMES,
  DEFAULT_INPUT_MAX_REDIRECTS,
  DEFAULT_INPUT_TIMEOUT_MS,
  extractImageContentFromSource,
  normalizeMimeList,
  type InputImageLimits,
  type InputImageSource,
} from "../media/input-files.js";
import { defaultRuntime } from "../runtime.js";
import { resolveAssistantStreamDeltaText } from "./agent-event-assistant-text.js";
import {
  buildAgentMessageFromConversationEntries,
  type ConversationEntry,
} from "./agent-prompt.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson, setSseHeaders, writeDone } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import { getHeader, resolveGatewayRequestContext } from "./http-utils.js";
import { normalizeInputHostnameAllowlist } from "./input-allowlist.js";

type OpenAiHttpOptions = {
  auth: ResolvedGatewayAuth;
  config?: GatewayHttpChatCompletionsConfig;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type OpenAiChatMessage = {
  role?: unknown;
  content?: unknown;
  name?: unknown;
  tool_call_id?: unknown;
  tool_calls?: unknown;
};

type OpenAiChatCompletionRequest = {
  model?: unknown;
  stream?: unknown;
  messages?: unknown;
  user?: unknown;
  response_format?: unknown;
};

type RequestedResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema";
      json_schema: {
        name: string;
        schema: Record<string, unknown>;
        description?: string;
        strict?: boolean | null;
      };
    };

const DEFAULT_OPENAI_CHAT_COMPLETIONS_BODY_BYTES = 20 * 1024 * 1024;
const IMAGE_ONLY_USER_MESSAGE = "User sent image(s) with no text.";
const DEFAULT_OPENAI_MAX_IMAGE_PARTS = 8;
const DEFAULT_OPENAI_MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_OPENAI_IMAGE_LIMITS: InputImageLimits = {
  allowUrl: false,
  allowedMimes: new Set(DEFAULT_INPUT_IMAGE_MIMES),
  maxBytes: DEFAULT_INPUT_IMAGE_MAX_BYTES,
  maxRedirects: DEFAULT_INPUT_MAX_REDIRECTS,
  timeoutMs: DEFAULT_INPUT_TIMEOUT_MS,
};

type ResolvedOpenAiChatCompletionsLimits = {
  maxBodyBytes: number;
  maxImageParts: number;
  maxTotalImageBytes: number;
  images: InputImageLimits;
};

function resolveOpenAiChatCompletionsLimits(
  config: GatewayHttpChatCompletionsConfig | undefined,
): ResolvedOpenAiChatCompletionsLimits {
  const imageConfig = config?.images;
  return {
    maxBodyBytes: config?.maxBodyBytes ?? DEFAULT_OPENAI_CHAT_COMPLETIONS_BODY_BYTES,
    maxImageParts:
      typeof config?.maxImageParts === "number"
        ? Math.max(0, Math.floor(config.maxImageParts))
        : DEFAULT_OPENAI_MAX_IMAGE_PARTS,
    maxTotalImageBytes:
      typeof config?.maxTotalImageBytes === "number"
        ? Math.max(1, Math.floor(config.maxTotalImageBytes))
        : DEFAULT_OPENAI_MAX_TOTAL_IMAGE_BYTES,
    images: {
      allowUrl: imageConfig?.allowUrl ?? DEFAULT_OPENAI_IMAGE_LIMITS.allowUrl,
      urlAllowlist: normalizeInputHostnameAllowlist(imageConfig?.urlAllowlist),
      allowedMimes: normalizeMimeList(imageConfig?.allowedMimes, DEFAULT_INPUT_IMAGE_MIMES),
      maxBytes: imageConfig?.maxBytes ?? DEFAULT_INPUT_IMAGE_MAX_BYTES,
      maxRedirects: imageConfig?.maxRedirects ?? DEFAULT_INPUT_MAX_REDIRECTS,
      timeoutMs: imageConfig?.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS,
    },
  };
}

function writeSse(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function buildAgentCommandInput(params: {
  prompt: { message: string; extraSystemPrompt?: string; images?: ImageContent[] };
  sessionKey: string;
  runId: string;
  messageChannel: string;
}) {
  return {
    message: params.prompt.message,
    extraSystemPrompt: params.prompt.extraSystemPrompt,
    images: params.prompt.images,
    sessionKey: params.sessionKey,
    runId: params.runId,
    deliver: false as const,
    messageChannel: params.messageChannel,
    bestEffortDeliver: false as const,
    // HTTP API callers are authenticated operator clients for this gateway context.
    senderIsOwner: true as const,
  };
}

function writeAssistantRoleChunk(res: ServerResponse, params: { runId: string; model: string }) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [{ index: 0, delta: { role: "assistant" } }],
  });
}

function writeAssistantContentChunk(
  res: ServerResponse,
  params: { runId: string; model: string; content: string; finishReason: "stop" | null },
) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        delta: { content: params.content },
        finish_reason: params.finishReason,
      },
    ],
  });
}

function asMessages(val: unknown): OpenAiChatMessage[] {
  return Array.isArray(val) ? (val as OpenAiChatMessage[]) : [];
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }
        const type = (part as { type?: unknown }).type;
        const text = (part as { text?: unknown }).text;
        const inputText = (part as { input_text?: unknown }).input_text;
        if (type === "text" && typeof text === "string") {
          return text;
        }
        if (type === "input_text" && typeof text === "string") {
          return text;
        }
        if (typeof inputText === "string") {
          return inputText;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function resolveImageUrlPart(part: unknown): string | undefined {
  if (!part || typeof part !== "object") {
    return undefined;
  }
  const imageUrl = (part as { image_url?: unknown }).image_url;
  if (typeof imageUrl === "string") {
    const trimmed = imageUrl.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!imageUrl || typeof imageUrl !== "object") {
    return undefined;
  }
  const rawUrl = (imageUrl as { url?: unknown }).url;
  if (typeof rawUrl !== "string") {
    return undefined;
  }
  const trimmed = rawUrl.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractImageUrls(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const urls: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    if ((part as { type?: unknown }).type !== "image_url") {
      continue;
    }
    const url = resolveImageUrlPart(part);
    if (url) {
      urls.push(url);
    }
  }
  return urls;
}

type ActiveTurnContext = {
  activeTurnIndex: number;
  activeUserMessageIndex: number;
  urls: string[];
};

function parseImageUrlToSource(url: string): InputImageSource {
  const dataUriMatch = /^data:([^,]*?),(.*)$/is.exec(url);
  if (dataUriMatch) {
    const metadata = dataUriMatch[1]?.trim() ?? "";
    const data = dataUriMatch[2] ?? "";
    const metadataParts = metadata
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean);
    const isBase64 = metadataParts.some((part) => part.toLowerCase() === "base64");
    if (!isBase64) {
      throw new Error("image_url data URI must be base64 encoded");
    }
    if (!data.trim()) {
      throw new Error("image_url data URI is missing payload data");
    }
    const mediaTypeRaw = metadataParts.find((part) => part.includes("/"));
    return {
      type: "base64",
      mediaType: mediaTypeRaw,
      data,
    };
  }
  return { type: "url", url };
}

function resolveActiveTurnContext(messagesUnknown: unknown): ActiveTurnContext {
  const messages = asMessages(messagesUnknown);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = typeof msg.role === "string" ? msg.role.trim() : "";
    const normalizedRole = role === "function" ? "tool" : role;
    if (normalizedRole !== "user" && normalizedRole !== "tool") {
      continue;
    }
    return {
      activeTurnIndex: i,
      activeUserMessageIndex: normalizedRole === "user" ? i : -1,
      urls: normalizedRole === "user" ? extractImageUrls(msg.content) : [],
    };
  }
  return { activeTurnIndex: -1, activeUserMessageIndex: -1, urls: [] };
}

async function resolveImagesForRequest(
  activeTurnContext: Pick<ActiveTurnContext, "urls">,
  limits: ResolvedOpenAiChatCompletionsLimits,
): Promise<ImageContent[]> {
  const urls = activeTurnContext.urls;
  if (urls.length === 0) {
    return [];
  }
  if (urls.length > limits.maxImageParts) {
    throw new Error(`Too many image_url parts (${urls.length}; limit ${limits.maxImageParts})`);
  }

  const images: ImageContent[] = [];
  let totalBytes = 0;
  for (const url of urls) {
    const source = parseImageUrlToSource(url);
    if (source.type === "base64") {
      const sourceBytes = estimateBase64DecodedBytes(source.data);
      if (totalBytes + sourceBytes > limits.maxTotalImageBytes) {
        throw new Error(
          `Total image payload too large (${totalBytes + sourceBytes}; limit ${limits.maxTotalImageBytes})`,
        );
      }
    }

    const image = await extractImageContentFromSource(source, limits.images);
    totalBytes += estimateBase64DecodedBytes(image.data);
    if (totalBytes > limits.maxTotalImageBytes) {
      throw new Error(
        `Total image payload too large (${totalBytes}; limit ${limits.maxTotalImageBytes})`,
      );
    }
    images.push(image);
  }
  return images;
}

export const __testOnlyOpenAiHttp = {
  resolveImagesForRequest,
  resolveOpenAiChatCompletionsLimits,
  isPassthroughRequest,
  buildPassthroughContext,
  resolvePassthroughTarget,
  normalizePassthroughResponseFormat,
  applyPassthroughResponseFormat,
  normalizePassthroughResponseText,
};

function buildAgentPrompt(
  messagesUnknown: unknown,
  activeUserMessageIndex: number,
): {
  message: string;
  extraSystemPrompt?: string;
} {
  const messages = asMessages(messagesUnknown);

  const systemParts: string[] = [];
  const conversationEntries: ConversationEntry[] = [];

  for (const [i, msg] of messages.entries()) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = typeof msg.role === "string" ? msg.role.trim() : "";
    const content = extractTextContent(msg.content).trim();
    const hasImage = extractImageUrls(msg.content).length > 0;
    if (!role) {
      continue;
    }
    if (role === "system" || role === "developer") {
      if (content) {
        systemParts.push(content);
      }
      continue;
    }

    const normalizedRole = role === "function" ? "tool" : role;
    if (normalizedRole !== "user" && normalizedRole !== "assistant" && normalizedRole !== "tool") {
      continue;
    }

    // Keep the image-only placeholder scoped to the active user turn so we don't
    // mention historical image-only turns whose bytes are intentionally not replayed.
    const messageContent =
      normalizedRole === "user" && !content && hasImage && i === activeUserMessageIndex
        ? IMAGE_ONLY_USER_MESSAGE
        : content;
    if (!messageContent) {
      continue;
    }

    const name = typeof msg.name === "string" ? msg.name.trim() : "";
    const sender =
      normalizedRole === "assistant"
        ? "Assistant"
        : normalizedRole === "user"
          ? "User"
          : name
            ? `Tool:${name}`
            : "Tool";

    conversationEntries.push({
      role: normalizedRole,
      entry: { sender, body: messageContent },
    });
  }

  const message = buildAgentMessageFromConversationEntries(conversationEntries);

  return {
    message,
    extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

function coerceRequest(val: unknown): OpenAiChatCompletionRequest {
  if (!val || typeof val !== "object") {
    return {};
  }
  return val as OpenAiChatCompletionRequest;
}

function resolveAgentResponseText(result: unknown): string {
  const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return "No response from OpenClaw.";
  }
  const content = payloads
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n\n");
  return content || "No response from OpenClaw.";
}

function isTruthyHeaderValue(raw: string | undefined): boolean {
  const normalized = raw?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isPassthroughRequest(req: IncomingMessage): boolean {
  return isTruthyHeaderValue(getHeader(req, "x-openclaw-passthrough"));
}

function normalizePassthroughResponseFormat(
  value: unknown,
): RequestedResponseFormat | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid response_format: expected an object");
  }
  const type =
    typeof (value as { type?: unknown }).type === "string"
      ? (value as { type: string }).type
      : "";
  if (type === "text" || type === "json_object") {
    return { type };
  }
  if (type !== "json_schema") {
    throw new Error(`Invalid response_format type: ${type || "<missing>"}`);
  }
  const rawSchema = (value as { json_schema?: unknown }).json_schema;
  if (!rawSchema || typeof rawSchema !== "object" || Array.isArray(rawSchema)) {
    throw new Error("Invalid response_format.json_schema: expected an object");
  }
  const name =
    typeof (rawSchema as { name?: unknown }).name === "string"
      ? (rawSchema as { name: string }).name.trim()
      : "";
  if (!name) {
    throw new Error("Invalid response_format.json_schema.name: expected a non-empty string");
  }
  const schema = (rawSchema as { schema?: unknown }).schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("Invalid response_format.json_schema.schema: expected an object");
  }
  const description =
    typeof (rawSchema as { description?: unknown }).description === "string"
      ? (rawSchema as { description: string }).description
      : undefined;
  const strict = (rawSchema as { strict?: unknown }).strict;
  if (strict !== undefined && strict !== null && typeof strict !== "boolean") {
    throw new Error("Invalid response_format.json_schema.strict: expected boolean or null");
  }
  return {
    type: "json_schema",
    json_schema: {
      name,
      schema: schema as Record<string, unknown>,
      ...(description !== undefined ? { description } : {}),
      ...(strict !== undefined ? { strict: strict as boolean | null } : {}),
    },
  };
}

function applyPassthroughResponseFormat(
  payload: unknown,
  responseFormat: RequestedResponseFormat,
  api: string,
): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid passthrough payload: expected an object");
  }
  const payloadRecord = payload as Record<string, unknown>;
  if (api === "openai-completions") {
    payloadRecord.response_format = responseFormat;
    return;
  }
  if (api === "openai-responses" || api === "openai-codex-responses") {
    const textConfig =
      payloadRecord.text && typeof payloadRecord.text === "object" && !Array.isArray(payloadRecord.text)
        ? { ...(payloadRecord.text as Record<string, unknown>) }
        : {};
    textConfig.format =
      responseFormat.type === "json_schema"
        ? {
            type: "json_schema",
            name: responseFormat.json_schema.name,
            schema: responseFormat.json_schema.schema,
            ...(responseFormat.json_schema.description !== undefined
              ? { description: responseFormat.json_schema.description }
              : {}),
            ...(responseFormat.json_schema.strict !== undefined
              ? { strict: responseFormat.json_schema.strict }
              : {}),
          }
        : responseFormat;
    payloadRecord.text = textConfig;
    return;
  }
  throw new Error(`response_format passthrough is not supported for model api ${api}`);
}

function normalizePassthroughResponseText(
  text: string,
  responseFormat: RequestedResponseFormat | undefined,
): string {
  if (!responseFormat || responseFormat.type === "text") {
    return text;
  }

  const requireStructuredValue = (candidate: string): string => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      throw new Error("Model violated response_format contract: returned non-JSON content");
    }
    if (responseFormat.type === "json_object") {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Model violated response_format contract: expected a JSON object");
      }
    }
    return candidate;
  };

  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Model violated response_format contract: returned empty content");
  }
  try {
    return requireStructuredValue(trimmed);
  } catch (err) {
    const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    if (!match) {
      throw err;
    }
    return requireStructuredValue(match[1]?.trim() ?? "");
  }
}

type PassthroughImageBudget = {
  totalBytes: number;
  parts: number;
};

function normalizeToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const typed = entry as {
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown } | null;
      };
      const name =
        typeof typed.function?.name === "string" ? typed.function.name.trim() : "";
      if (!name) {
        return null;
      }
      const id = typeof typed.id === "string" ? typed.id.trim() : "";
      if (!id) {
        throw new Error(`Assistant tool_call for "${name}" is missing id`);
      }
      const rawArguments = typed.function?.arguments;
      let args: Record<string, unknown> = {};
      if (typeof rawArguments === "string") {
        const trimmed = rawArguments.trim();
        if (trimmed) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            throw new Error(`Assistant tool_call arguments for "${name}" are not valid JSON`);
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error(`Assistant tool_call arguments for "${name}" must be a JSON object`);
          }
          args = parsed as Record<string, unknown>;
        }
      } else if (rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)) {
        args = rawArguments as Record<string, unknown>;
      } else if (rawArguments !== undefined && rawArguments !== null) {
        throw new Error(`Assistant tool_call arguments for "${name}" must be an object`);
      }
      return {
        type: "toolCall" as const,
        id,
        name,
        arguments: args,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

async function convertContentToPassthroughParts(
  content: unknown,
  limits: ResolvedOpenAiChatCompletionsLimits,
  imageBudget: PassthroughImageBudget,
  options?: { allowImages?: boolean },
): Promise<string | Array<{ type: "text"; text: string } | ImageContent>> {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: Array<{ type: "text"; text: string } | ImageContent> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const type = (part as { type?: unknown }).type;
    const text = (part as { text?: unknown }).text;
    const inputText = (part as { input_text?: unknown }).input_text;
    if ((type === "text" || type === "input_text") && typeof text === "string") {
      parts.push({ type: "text", text });
      continue;
    }
    if (typeof inputText === "string") {
      parts.push({ type: "text", text: inputText });
      continue;
    }
    if (type !== "image_url") {
      continue;
    }
    if (options?.allowImages === false) {
      throw new Error("Only user messages may contain image_url parts in passthrough mode");
    }
    const url = resolveImageUrlPart(part);
    if (!url) {
      continue;
    }
    imageBudget.parts += 1;
    if (imageBudget.parts > limits.maxImageParts) {
      throw new Error(`Too many image_url parts (${imageBudget.parts}; limit ${limits.maxImageParts})`);
    }
    const source = parseImageUrlToSource(url);
    if (source.type === "base64") {
      const sourceBytes = estimateBase64DecodedBytes(source.data);
      if (imageBudget.totalBytes + sourceBytes > limits.maxTotalImageBytes) {
        throw new Error(
          `Total image payload too large (${imageBudget.totalBytes + sourceBytes}; limit ${limits.maxTotalImageBytes})`,
        );
      }
    }
    const image = await extractImageContentFromSource(source, limits.images);
    imageBudget.totalBytes += estimateBase64DecodedBytes(image.data);
    if (imageBudget.totalBytes > limits.maxTotalImageBytes) {
      throw new Error(
        `Total image payload too large (${imageBudget.totalBytes}; limit ${limits.maxTotalImageBytes})`,
      );
    }
    parts.push(image);
  }

  if (parts.length === 0) {
    return "";
  }
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => part.text).join("\n");
  }
  return parts;
}

async function buildPassthroughContext(
  messagesUnknown: unknown,
  limits: ResolvedOpenAiChatCompletionsLimits,
): Promise<Context> {
  const messages = asMessages(messagesUnknown);
  const systemParts: string[] = [];
  const passthroughMessages: Array<Record<string, unknown>> = [];
  const imageBudget: PassthroughImageBudget = { totalBytes: 0, parts: 0 };
  const toolNameById = new Map<string, string>();

  for (const [index, msg] of messages.entries()) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = typeof msg.role === "string" ? msg.role.trim() : "";
    if (!role) {
      continue;
    }
    if (role === "system" || role === "developer") {
      const content = extractTextContent(msg.content).trim();
      if (content) {
        systemParts.push(content);
      }
      continue;
    }

    const normalizedRole = role === "function" ? "tool" : role;
    const timestamp = Date.now() + index;
    if (normalizedRole === "user") {
      const content = await convertContentToPassthroughParts(msg.content, limits, imageBudget, {
        allowImages: true,
      });
      if (!content || (Array.isArray(content) && content.length === 0)) {
        continue;
      }
      passthroughMessages.push({ role: "user", content, timestamp });
      continue;
    }

    if (normalizedRole === "assistant") {
      const content = await convertContentToPassthroughParts(msg.content, limits, imageBudget, {
        allowImages: false,
      });
      const toolCalls = normalizeToolCalls(msg.tool_calls);
      for (const toolCall of toolCalls) {
        if (toolCall.id) {
          toolNameById.set(toolCall.id, toolCall.name);
        }
      }
      let textParts: TextContent[] = [];
      if (Array.isArray(content)) {
        if (content.some((part) => part.type !== "text")) {
          throw new Error("Assistant passthrough content may only contain text parts");
        }
        textParts = content as TextContent[];
      } else if (typeof content === "string" && content.trim()) {
        textParts = [{ type: "text", text: content }];
      }
      const assistantContent: Array<TextContent | ToolCall> =
        textParts.length > 0 || toolCalls.length > 0 ? [...textParts, ...toolCalls] : [];
      if (assistantContent.length === 0) {
        continue;
      }
      passthroughMessages.push({
        role: "assistant",
        content: assistantContent,
        timestamp,
      });
      continue;
    }

    if (normalizedRole !== "tool") {
      continue;
    }

    const content = await convertContentToPassthroughParts(msg.content, limits, imageBudget, {
      allowImages: false,
    });
    const inlineToolName = typeof msg.name === "string" ? msg.name.trim() : "";
    const toolCallId = typeof msg.tool_call_id === "string" ? msg.tool_call_id.trim() : "";
    if (!toolCallId) {
      throw new Error("Tool messages require tool_call_id in passthrough mode");
    }
    const toolName = inlineToolName || toolNameById.get(toolCallId) || "";
    if (!toolName) {
      throw new Error(`Tool message missing name for tool_call_id ${toolCallId}`);
    }
    let toolContent: TextContent[] = [];
    if (Array.isArray(content)) {
      if (content.some((part) => part.type !== "text")) {
        throw new Error("Tool passthrough content may only contain text parts");
      }
      toolContent = content as TextContent[];
    } else if (typeof content === "string" && content.trim()) {
      toolContent = [{ type: "text", text: content }];
    }
    passthroughMessages.push({
      role: "toolResult",
      toolCallId,
      toolName,
      content: toolContent,
      isError: false,
      timestamp,
    });
  }

  return {
    ...(systemParts.length > 0 ? { systemPrompt: systemParts.join("\n\n") } : {}),
    messages: passthroughMessages as unknown as Context["messages"],
  };
}

function resolvePassthroughTarget(params: {
  requestedModel: string;
  agentId: string;
}) {
  const cfg = loadConfig();
  const defaultRef = resolveDefaultModelForAgent({
    cfg,
    agentId: params.agentId,
  });
  const { model: rawModel, profile } = splitTrailingAuthProfile(params.requestedModel);
  const normalizedRequested = rawModel.trim().toLowerCase();
  const ref =
    normalizedRequested === "" ||
    normalizedRequested === "openclaw" ||
    normalizedRequested.startsWith("openclaw:") ||
    normalizedRequested.startsWith("openclaw/")
      ? defaultRef
      : (() => {
          const aliasIndex = buildModelAliasIndex({
            cfg,
            defaultProvider: defaultRef.provider,
          });
          const resolved = resolveModelRefFromString({
            raw: rawModel,
            defaultProvider: defaultRef.provider,
            aliasIndex,
          });
          if (!resolved) {
            throw new Error(`Invalid passthrough model selection: ${params.requestedModel}`);
          }
          return resolved.ref;
        })();
  const agentDir = resolveAgentDir(cfg, params.agentId);
  const resolved = resolveModel(ref.provider, ref.model, agentDir, cfg);
  if (!resolved.model) {
    throw new Error(resolved.error ?? `Unknown model: ${ref.provider}/${ref.model}`);
  }
  return {
    cfg,
    agentDir,
    profileId: profile,
    provider: ref.provider,
    model: resolved.model,
    authStorage: resolved.authStorage,
  };
}

async function runPassthroughChat(params: {
  requestedModel: string;
  agentId: string;
  context: Context;
  requestedResponseFormat?: unknown;
}): Promise<{
  text: string;
  usage: { input: number; output: number; totalTokens: number };
}> {
  const target = resolvePassthroughTarget({
    requestedModel: params.requestedModel,
    agentId: params.agentId,
  });
  const responseFormat = normalizePassthroughResponseFormat(params.requestedResponseFormat);
  const auth = await getApiKeyForModel({
    model: target.model,
    cfg: target.cfg,
    profileId: target.profileId,
    agentDir: target.agentDir,
  });
  const apiKey = auth.apiKey?.trim() || undefined;
  if (apiKey) {
    target.authStorage.setRuntimeApiKey(target.model.provider, apiKey);
  }

  const agent = { streamFn: streamSimple };
  applyExtraParamsToAgent(
    agent,
    target.cfg,
    target.provider,
    target.model.id,
    undefined,
    undefined,
    params.agentId,
  );

  const stream = (agent.streamFn ?? streamSimple)(target.model, params.context, {
    ...(apiKey ? { apiKey } : {}),
    ...(responseFormat
      ? {
          onPayload: (payload: unknown, payloadModel: { api: string }) => {
            applyPassthroughResponseFormat(payload, responseFormat, payloadModel.api);
            return payload;
          },
        }
      : {}),
  });
  for await (const event of stream) {
    if (event.type === "error") {
      throw new Error(event.error?.errorMessage ?? event.reason ?? "passthrough stream failed");
    }
    if (event.type === "done") {
      const text = normalizePassthroughResponseText(
        extractAssistantText(event.message).trim(),
        responseFormat,
      );
      return {
        text,
        usage: {
          input: event.message.usage?.input ?? 0,
          output: event.message.usage?.output ?? 0,
          totalTokens: event.message.usage?.totalTokens ?? 0,
        },
      };
    }
  }
  throw new Error("passthrough stream ended without a final assistant message");
}

export async function handleOpenAiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiHttpOptions,
): Promise<boolean> {
  const limits = resolveOpenAiChatCompletionsLimits(opts.config);
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/chat/completions",
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: opts.maxBodyBytes ?? limits.maxBodyBytes,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }

  const payload = coerceRequest(handled.body);
  const stream = Boolean(payload.stream);
  const model = typeof payload.model === "string" ? payload.model : "openclaw";
  const user = typeof payload.user === "string" ? payload.user : undefined;

  const { agentId, sessionKey, messageChannel } = resolveGatewayRequestContext({
    req,
    model,
    user,
    sessionPrefix: "openai",
    defaultMessageChannel: "webchat",
    useMessageChannelHeader: true,
  });
  if (isPassthroughRequest(req)) {
    try {
      const context = await buildPassthroughContext(payload.messages, limits);
      if (context.messages.length === 0) {
        sendJson(res, 400, {
          error: {
            message: "Missing user message in `messages`.",
            type: "invalid_request_error",
          },
        });
        return true;
      }

      if (!stream) {
        const result = await runPassthroughChat({
          requestedModel: model,
          agentId,
          context,
          requestedResponseFormat: payload.response_format,
        });
        sendJson(res, 200, {
          id: `chatcmpl_${randomUUID()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: result.text },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: result.usage.input,
            completion_tokens: result.usage.output,
            total_tokens: result.usage.totalTokens,
          },
        });
        return true;
      }

      setSseHeaders(res);
      const passthroughRunId = `chatcmpl_${randomUUID()}`;
      try {
        const result = await runPassthroughChat({
          requestedModel: model,
          agentId,
          context,
          requestedResponseFormat: payload.response_format,
        });
        writeAssistantRoleChunk(res, {
          runId: passthroughRunId,
          model,
        });
        if (result.text) {
          writeAssistantContentChunk(res, {
            runId: passthroughRunId,
            model,
            content: result.text,
            finishReason: "stop",
          });
        }
      } catch (err) {
        logWarn(`openai-compat passthrough: streaming chat completion failed: ${String(err)}`);
        writeAssistantRoleChunk(res, {
          runId: passthroughRunId,
          model,
        });
        writeAssistantContentChunk(res, {
          runId: passthroughRunId,
          model,
          content: "Error: internal error",
          finishReason: "stop",
        });
      }
      writeDone(res);
      res.end();
      return true;
    } catch (err) {
      const message = String(err);
      const invalidImage = message.includes("image_url") || message.includes("image payload");
      const invalidResponseFormat = message.includes("response_format");
      if (invalidImage) {
        logWarn(`openai-compat passthrough: invalid image content: ${message}`);
        sendJson(res, 400, {
          error: {
            message: "Invalid image_url content in `messages`.",
            type: "invalid_request_error",
          },
        });
        return true;
      }
      if (invalidResponseFormat) {
        logWarn(`openai-compat passthrough: invalid response_format: ${message}`);
        sendJson(res, 400, {
          error: {
            message,
            type: "invalid_request_error",
          },
        });
        return true;
      }
      logWarn(`openai-compat passthrough: chat completion failed: ${message}`);
      sendJson(res, 500, {
        error: { message: "internal error", type: "api_error" },
      });
      return true;
    }
  }
  const activeTurnContext = resolveActiveTurnContext(payload.messages);
  const prompt = buildAgentPrompt(payload.messages, activeTurnContext.activeUserMessageIndex);
  let images: ImageContent[] = [];
  try {
    images = await resolveImagesForRequest(activeTurnContext, limits);
  } catch (err) {
    logWarn(`openai-compat: invalid image_url content: ${String(err)}`);
    sendJson(res, 400, {
      error: {
        message: "Invalid image_url content in `messages`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  if (!prompt.message && images.length === 0) {
    sendJson(res, 400, {
      error: {
        message: "Missing user message in `messages`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const runId = `chatcmpl_${randomUUID()}`;
  const deps = createDefaultDeps();
  const commandInput = buildAgentCommandInput({
    prompt: {
      message: prompt.message,
      extraSystemPrompt: prompt.extraSystemPrompt,
      images: images.length > 0 ? images : undefined,
    },
    sessionKey,
    runId,
    messageChannel,
  });

  if (!stream) {
    try {
      const result = await agentCommandFromIngress(commandInput, defaultRuntime, deps);

      const content = resolveAgentResponseText(result);

      sendJson(res, 200, {
        id: runId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (err) {
      logWarn(`openai-compat: chat completion failed: ${String(err)}`);
      sendJson(res, 500, {
        error: { message: "internal error", type: "api_error" },
      });
    }
    return true;
  }

  setSseHeaders(res);

  let wroteRole = false;
  let sawAssistantDelta = false;
  let closed = false;

  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== runId) {
      return;
    }
    if (closed) {
      return;
    }

    if (evt.stream === "assistant") {
      const content = resolveAssistantStreamDeltaText(evt) ?? "";
      if (!content) {
        return;
      }

      if (!wroteRole) {
        wroteRole = true;
        writeAssistantRoleChunk(res, { runId, model });
      }

      sawAssistantDelta = true;
      writeAssistantContentChunk(res, {
        runId,
        model,
        content,
        finishReason: null,
      });
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "end" || phase === "error") {
        closed = true;
        unsubscribe();
        writeDone(res);
        res.end();
      }
    }
  });

  req.on("close", () => {
    closed = true;
    unsubscribe();
  });

  void (async () => {
    try {
      const result = await agentCommandFromIngress(commandInput, defaultRuntime, deps);

      if (closed) {
        return;
      }

      if (!sawAssistantDelta) {
        if (!wroteRole) {
          wroteRole = true;
          writeAssistantRoleChunk(res, { runId, model });
        }

        const content = resolveAgentResponseText(result);

        sawAssistantDelta = true;
        writeAssistantContentChunk(res, {
          runId,
          model,
          content,
          finishReason: null,
        });
      }
    } catch (err) {
      logWarn(`openai-compat: streaming chat completion failed: ${String(err)}`);
      if (closed) {
        return;
      }
      writeAssistantContentChunk(res, {
        runId,
        model,
        content: "Error: internal error",
        finishReason: "stop",
      });
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "error" },
      });
    } finally {
      if (!closed) {
        closed = true;
        unsubscribe();
        writeDone(res);
        res.end();
      }
    }
  })();

  return true;
}
