import type { LiveAssetRuntimeState } from "./app-view-state.ts";

/**
 * Normalize OpenClaw chat messages for LiveAsset /generate.
 */
export type LiveAssetToolCall = {
  name: string;
  arguments?: unknown;
};

export type LiveAssetMessage = {
  role: "user" | "assistant";
  content: string;
  toolCalls?: LiveAssetToolCall[];
};

export type LiveAssetUserInputOption = {
  userInputIndex: number;
  content: string;
  preview: string;
};

function extractTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const record = part as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

const TOOL_CALL_TYPES = new Set(["tool_use", "tool_call", "tooluse", "toolcall"]);

function extractToolCallsFromContent(content: unknown): LiveAssetToolCall[] {
  if (!Array.isArray(content)) return [];
  const calls: LiveAssetToolCall[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    const kind = typeof record.type === "string" ? record.type.toLowerCase() : "";
    if (!TOOL_CALL_TYPES.has(kind)) continue;
    const name = typeof record.name === "string" ? record.name : "unknown";
    const args = record.arguments ?? record.args;
    calls.push(args !== undefined ? { name, arguments: args } : { name });
  }
  return calls;
}

export function normalizeChatMessagesForLiveAsset(
  messages: unknown[],
): LiveAssetMessage[] {
  return (messages ?? [])
    .filter((m: unknown) => {
      const r = (m as Record<string, unknown>)?.role;
      return r === "user" || r === "assistant";
    })
    .map((m: unknown) => {
      const rec = m as Record<string, unknown>;
      const content = extractTextFromMessageContent(rec.content);
      const toolCalls = extractToolCallsFromContent(rec.content);
      const msg: LiveAssetMessage = { role: rec.role as LiveAssetMessage["role"], content };
      if (toolCalls.length > 0) msg.toolCalls = toolCalls;
      return msg;
    })
    .filter((m) => m.content.trim() || (m.toolCalls && m.toolCalls.length > 0));
}

function isEnvironmentMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.startsWith("a new session was started") || lower.includes("execute your session startup sequence");
}

function buildLiveAssetUserInputPreview(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= 140) {
    return normalized;
  }
  return `${normalized.slice(0, 137)}...`;
}

export function extractLastUserTextForLiveAsset(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as Record<string, unknown>;
    if (message?.role !== "user") {
      continue;
    }
    const content = extractTextFromMessageContent(message.content);
    if (content) {
      return content;
    }
  }
  return "";
}

export function resolveLiveAssetTraceQuery(params: {
  runtimeState: LiveAssetRuntimeState | null;
  messages: unknown[];
}): string {
  const originalInput = params.runtimeState?.preparedInputOriginal?.trim() ?? "";
  if (originalInput) {
    return originalInput;
  }
  const events = params.runtimeState?.events ?? [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.kind !== "matched") {
      continue;
    }
    const userInput = event.userInput?.trim() ?? "";
    if (userInput) {
      return userInput;
    }
  }
  return extractLastUserTextForLiveAsset(params.messages);
}

export function collectLiveAssetUserInputs(
  msgs: LiveAssetMessage[],
): LiveAssetUserInputOption[] {
  const options: LiveAssetUserInputOption[] = [];
  let userInputIndex = 0;
  for (const msg of msgs) {
    if (msg.role !== "user") {
      continue;
    }
    // Increment index for every user message (keeps alignment with sliceMessagesFromStartUserInput).
    // Only expose genuine user inputs in the selection list.
    if (!isEnvironmentMessage(msg.content)) {
      options.push({
        userInputIndex,
        content: msg.content,
        preview: buildLiveAssetUserInputPreview(msg.content),
      });
    }
    userInputIndex += 1;
  }
  return options;
}
