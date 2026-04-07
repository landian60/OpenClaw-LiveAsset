import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { extractAssistantText } from "./pi-embedded-utils.js";

type PersistedSessionEntry = {
  type?: string;
  message?: AgentMessage;
};

type RewriteCapableSessionManager = {
  fileEntries?: PersistedSessionEntry[];
  _rewriteFile?: () => void;
};

export function resolveAssistantResponseText(params: {
  assistantTexts: string[];
  lastAssistant?: AssistantMessage;
}): string {
  const combined = params.assistantTexts.map((text) => text.trim()).filter(Boolean).join("\n\n");
  if (combined) {
    return combined;
  }
  if (!params.lastAssistant) {
    return "";
  }
  return extractAssistantText(params.lastAssistant).trim();
}

export function replaceAssistantMessageText(
  message: Extract<AgentMessage, { role: "assistant" }>,
  text: string,
): Extract<AgentMessage, { role: "assistant" }> {
  return {
    ...message,
    content: [{ type: "text", text }],
  };
}

export function rewriteLastAssistantMessageInPlace(
  messages: AgentMessage[],
  text: string,
): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "assistant") {
      continue;
    }
    const rewritten = replaceAssistantMessageText(message, text);
    messages[i] = rewritten;
    return rewritten;
  }
  return undefined;
}

export function rewriteLastAssistantInSessionManager(sessionManager: unknown, text: string): boolean {
  const manager = sessionManager as RewriteCapableSessionManager;
  if (!Array.isArray(manager.fileEntries) || typeof manager._rewriteFile !== "function") {
    return false;
  }

  for (let i = manager.fileEntries.length - 1; i >= 0; i -= 1) {
    const entry = manager.fileEntries[i];
    if (entry?.type !== "message" || entry.message?.role !== "assistant") {
      continue;
    }
    entry.message = replaceAssistantMessageText(
      entry.message,
      text,
    );
    manager._rewriteFile();
    return true;
  }

  return false;
}
