/**
 * plugin.ts — LiveAssets OpenClaw plugin
 *
 * Transforms user corrections into executable behavioral rules for LLM agents.
 *
 * Hooks: before_prompt_build, before_tool_call, after_tool_call, assistant_response, session_end
 * Tools: registered from asset JSON, execute returns scenario data directly
 * Commands: /liveassets-generate, /liveassets-feedback, /liveassets-status, /liveassets-viz, /liveassets-reload
 * HTTP routes: /live-assets/assets, /live-assets/sessions, /live-assets/reload, /live-assets/save
 */

import path from "node:path";
import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { LiveAssetsRuntime } from "./runtime.js";
import { spawnPython } from "./spawn.js";
import {
  buildInput,
  buildInputAugmentation,
  findMatchingAsset,
  stripInputAugmentationFromKnownAssets,
  type LiveAsset,
} from "./system.js";

type OpenClawPluginApi = {
  pluginConfig?: Record<string, unknown>;
  logger: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
  resolvePath: (input: string) => string;
  registerCommand?: (command: unknown) => void;
  registerHttpRoute?: (params: {
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void> | boolean | void;
    auth: "gateway" | "plugin";
    match?: "exact" | "prefix";
    replaceExisting?: boolean;
  }) => void;
  registerTool?: (tool: {
    name: string;
    label?: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
  }) => void;
  on: (hookName: string, handler: unknown, opts?: { priority?: number }) => void;
};

function resolveAssetsDir(api: OpenClawPluginApi): string {
  const config = api.pluginConfig ?? {};
  if (typeof config.assetsDir === "string" && config.assetsDir.trim()) {
    return api.resolvePath(config.assetsDir);
  }
  const stateDir = process.env.OPENCLAW_STATE_DIR
    ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".openclaw");
  return path.join(stateDir, "live-assets");
}

function resolveGatewayConfigPath(api: OpenClawPluginApi): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR
    ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".openclaw");
  return api.resolvePath(path.join(stateDir, "openclaw.json"));
}

function resolveConfiguredPythonBin(api: OpenClawPluginApi): string {
  const config = api.pluginConfig ?? {};
  const configured = typeof config.pythonBin === "string" ? config.pythonBin.trim() : "";
  if (configured) {
    return configured;
  }
  const envPython = process.env.PYTHON_BIN?.trim();
  if (envPython) {
    return envPython;
  }
  return "python3";
}

function isLoopbackGatewayUrl(raw: string): boolean {
  try {
    const hostname = new URL(raw).hostname.trim().toLowerCase();
    return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
  } catch {
    return false;
  }
}

function normalizeGatewayToken(raw: unknown): string | undefined {
  const token = typeof raw === "string" ? raw.trim() : "";
  if (!token || /^\$\{[^}]+\}$/.test(token)) {
    return undefined;
  }
  return token;
}

export function resolveGatewayTokenForInternalCalls(params: {
  api: OpenClawPluginApi;
  gatewayUrl?: string;
  envToken?: string;
  configPath?: string;
}): string {
  const gatewayUrl = params.gatewayUrl?.trim() || process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789";
  const envToken = params.envToken ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  if (!isLoopbackGatewayUrl(gatewayUrl)) {
    return envToken.trim();
  }

  const configPath = params.configPath ?? resolveGatewayConfigPath(params.api);
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as { gateway?: { auth?: { token?: unknown } } };
    const configToken = normalizeGatewayToken(parsed.gateway?.auth?.token);
    if (configToken) {
      return configToken;
    }
  } catch {
    // Keep env token as the only remaining source when config is unavailable.
  }
  return envToken.trim();
}

function assetFilePath(assetsDir: string, assetId: string): string {
  return path.join(assetsDir, `${assetId}.json`);
}

const VALID_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const AGENT_SESSION_KEY_RE = /^agent:(?<agentId>[a-z0-9][a-z0-9_-]{0,63}):/i;

function normalizeLiveAssetsAgentId(raw: unknown): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return "main";
  }
  if (VALID_AGENT_ID_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  return normalized || "main";
}

export function resolveLiveAssetsAgentId(params: {
  sessionKey?: string;
  agentId?: unknown;
}): string {
  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
  if (sessionKey) {
    const matched = sessionKey.match(AGENT_SESSION_KEY_RE);
    const sessionAgentId = matched?.groups?.agentId;
    if (sessionAgentId) {
      return normalizeLiveAssetsAgentId(sessionAgentId);
    }
  }
  return normalizeLiveAssetsAgentId(params.agentId);
}

function buildInternalLiveAssetsSessionKey(agentId: string, purpose: string): string {
  const token = purpose
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return `agent:${normalizeLiveAssetsAgentId(agentId)}:live-assets-${token || "internal"}`;
}

function isInternalLiveAssetsSessionKey(sessionKey: string | undefined): boolean {
  return typeof sessionKey === "string" && sessionKey.includes(":live-assets-");
}

class BadRequestError extends Error {}

type GenerateConversationMessage = {
  role: string;
  content: string;
  toolCalls?: Array<{ name: string; params?: unknown }>;
  toolResult?: { name: string; isError: boolean };
};

export function resolvePluginSessionKey(ctx: Record<string, unknown>): string {
  return String(ctx?.sessionKey ?? ctx?.sessionId ?? "default");
}

function normalizeHookSessionToken(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveRuntimeSessionKeyFromHookContext(
  ctx: Record<string, unknown>,
  params: {
    sessionKeyById: Map<string, string>;
    hasRuntimeSession: (candidate: string) => boolean;
    defaultSessionKey: string;
  },
): string {
  const sessionKey = normalizeHookSessionToken(ctx?.sessionKey);
  const sessionId = normalizeHookSessionToken(ctx?.sessionId);

  if (sessionKey) {
    if (sessionId) {
      params.sessionKeyById.set(sessionId, sessionKey);
    }
    return sessionKey;
  }

  if (sessionId) {
    const mapped = params.sessionKeyById.get(sessionId);
    if (mapped) {
      return mapped;
    }
    if (params.hasRuntimeSession(sessionId)) {
      return sessionId;
    }
  }

  return params.defaultSessionKey;
}

/** Session JSONL often has multiple lines per logical turn (e.g. several assistant bubbles). */
function mergeConsecutiveSameRole(
  messages: GenerateConversationMessage[],
): GenerateConversationMessage[] {
  const out: GenerateConversationMessage[] = [];
  for (const m of messages) {
    const role = m.role;
    const content = m.content.trim();
    const toolCalls = m.toolCalls;
    const toolResult = m.toolResult;
    if (!content && !toolCalls?.length && !toolResult) continue;
    // Never merge toolResult messages with adjacent messages
    if (role === "toolResult") {
      out.push({ role, content, ...(toolResult ? { toolResult } : {}) });
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content = `${last.content}\n\n${content}`.trim();
      if (toolCalls?.length) {
        last.toolCalls = [...(last.toolCalls ?? []), ...toolCalls];
      }
    } else {
      out.push({ role, content, ...(toolCalls?.length ? { toolCalls } : {}) });
    }
  }
  return out;
}

const REWRITE_TOOL_CALL_TYPES = new Set(["toolCall", "toolUse", "functionCall"]);

function cleanRewriteUserMessage(text: string): string {
  const metaRe =
    /^(?:(?:Conversation info \(untrusted metadata\)|Sender \(untrusted metadata\)|Thread starter \(untrusted, for context\)|Replied message \(untrusted, for context\)|Forwarded message context \(untrusted metadata\)|Chat history since last reply \(untrusted, for context\)):\s*```json[\s\S]*?```\s*)+/i;
  let cleaned = text.replace(metaRe, "").trim();
  cleaned = cleaned.replace(
    /^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?[^\]]*\]\s*/u,
    "",
  ).trim();
  return cleaned;
}

function cleanRewriteAssistantMessage(text: string): string {
  const traceIdx = text.indexOf("\n\n---\n**LiveAsset**");
  return traceIdx >= 0 ? text.slice(0, traceIdx).trim() : text;
}

function extractRewriteTextFromMessageContent(content: unknown): string {
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
      const record = part as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractRewriteToolCallsFromMessageContent(
  content: unknown,
): Array<{ name: string; params?: unknown }> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter((part): part is Record<string, unknown> => typeof part === "object" && part !== null)
    .filter((part) => typeof part.type === "string" && REWRITE_TOOL_CALL_TYPES.has(part.type) && part.name)
    .map((part) => ({
      name: String(part.name),
      params: part.input ?? part.arguments ?? part.params,
    }));
}

export function buildRewriteConversationSnapshot(
  messages: unknown[],
): GenerateConversationMessage[] {
  const filtered = messages
    .filter((message): message is Record<string, unknown> => typeof message === "object" && message !== null)
    .map((message) => {
      const role = String(message.role ?? "");
      const content = extractRewriteTextFromMessageContent(message.content);
      if (role === "assistant") {
        const toolCalls = extractRewriteToolCallsFromMessageContent(message.content);
        const cleaned = cleanRewriteAssistantMessage(content);
        if (!cleaned && toolCalls.length === 0) {
          return null;
        }
        return {
          role,
          content: cleaned,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        };
      }
      if (role === "user") {
        const cleaned = cleanRewriteUserMessage(content);
        return cleaned ? { role, content: cleaned } : null;
      }
      if (role === "toolResult") {
        const toolName = String(message.toolName ?? message.tool_name ?? "").trim();
        const isError = Boolean(message.isError ?? message.is_error);
        if (!content && !toolName) {
          return null;
        }
        return {
          role,
          content,
          ...(toolName ? { toolResult: { name: toolName, isError } } : {}),
        };
      }
      return null;
    })
    .filter((message): message is GenerateConversationMessage => message !== null)
    .filter((message) => message.content.trim().length > 0 || (message.toolCalls?.length ?? 0) > 0 || Boolean(message.toolResult));

  const merged = mergeConsecutiveSameRole(filtered);
  return merged[0]?.role === "assistant" ? merged.slice(1) : merged;
}

function formatRewriteConversationForPrompt(
  conversation: Array<{
    role: string;
    content: string;
    toolCalls?: Array<{ name: string; params?: unknown }>;
    toolResult?: { name: string; isError: boolean };
  }>,
): string {
  const lines: string[] = [];
  for (const message of conversation) {
    const role = typeof message.role === "string" && message.role.trim() ? message.role.trim() : "unknown";
    const text = typeof message.content === "string" ? message.content.trim() : "";

    if (role === "assistant") {
      if (text) {
        lines.push(`[assistant]: ${text}`);
      }
      for (const toolCall of message.toolCalls ?? []) {
        const toolName = typeof toolCall.name === "string" && toolCall.name.trim()
          ? toolCall.name.trim()
          : "unknown";
        const params = toolCall.params;
        const noParams =
          params == null
          || (typeof params === "object" && !Array.isArray(params) && Object.keys(params).length === 0);
        if (noParams) {
          lines.push(`[tool_call]: ${toolName}()`);
          continue;
        }
        lines.push(`[tool_call]: ${toolName}(${JSON.stringify(params)})`);
      }
      continue;
    }

    if (role === "toolResult") {
      const name = typeof message.toolResult?.name === "string" ? message.toolResult.name.trim() : "";
      const status = message.toolResult?.isError ? " ERROR" : "";
      const label = name || "unknown";
      if (text) {
        lines.push(`[tool_result]${label}${status}: ${text.slice(0, 200)}`);
      } else {
        lines.push(`[tool_result]${label}${status}`);
      }
      continue;
    }

    if (text) {
      lines.push(`[${role}]: ${text}`);
    }
  }
  return lines.join("\n");
}

function formatRewriteOutputRules(asset: LiveAsset): string {
  const lines: string[] = [];
  for (const rule of asset.outputControl ?? []) {
    const check = typeof rule?.check === "string" ? rule.check.trim() : "";
    const rewrite = typeof rule?.rewrite === "string" ? rule.rewrite.trim() : "";

    let checkText = "";
    if (check.startsWith("contains:")) {
      const keyword = check.slice("contains:".length).trim();
      if (keyword) {
        checkText = `- Must include "${keyword}"`;
      }
    } else if (check.startsWith("!contains:")) {
      const keyword = check.slice("!contains:".length).trim();
      if (keyword) {
        checkText = `- Must not include "${keyword}"`;
      }
    }

    if (checkText) {
      lines.push(checkText);
      if (rewrite) {
        lines.push(`  → ${rewrite}`);
      }
    }
  }
  return lines.join("\n");
}

function buildRewriteUserPrompt(params: {
  conversation: Array<{
    role: string;
    content: string;
    toolCalls?: Array<{ name: string; params?: unknown }>;
    toolResult?: { name: string; isError: boolean };
  }>;
  asset: LiveAsset;
  draft: string;
  reason: string;
}): string {
  const convText = formatRewriteConversationForPrompt(params.conversation);
  const rulesText = formatRewriteOutputRules(params.asset);
  const draft = params.draft.trim();
  if (!rulesText.trim()) {
    throw new Error("rewrite prompt requires non-empty outputControl");
  }
  if (!draft) {
    throw new Error("rewrite prompt requires non-empty draft");
  }
  return (
    `Conversation history:\n${convText || "(empty)"}\n\n`
    + `Current assistant draft:\n${draft}\n\n`
    + `Output constraints:\n${rulesText}\n\n`
    + `Current failure reason:\n${params.reason.trim() || "(not provided)"}\n\n`
    + "Output only the final rewritten assistant response."
  );
}

function normalizeGenerateMessages(
  raw: unknown,
): GenerateConversationMessage[] {
  if (!Array.isArray(raw)) {
    throw new BadRequestError("messages must be an array");
  }
  const normalized: GenerateConversationMessage[] = [];
  for (const msg of raw) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = (msg as { role?: unknown }).role;
    const contentValue = (msg as { content?: unknown }).content;
    const toolCallsRaw = (msg as { toolCalls?: unknown }).toolCalls;
    const toolResultValue = (msg as { toolResult?: unknown }).toolResult;
    const toolNameValue =
      (msg as { toolName?: unknown }).toolName
      ?? (msg as { tool_name?: unknown }).tool_name;
    const isErrorValue =
      (msg as { isError?: unknown }).isError
      ?? (msg as { is_error?: unknown }).is_error;
    if (role !== "user" && role !== "assistant" && role !== "toolResult") {
      continue;
    }
    const content = typeof contentValue === "string" ? contentValue : "";
    if (role === "toolResult") {
      const rawToolResult =
        toolResultValue && typeof toolResultValue === "object"
          ? toolResultValue as { name?: unknown; isError?: unknown }
          : undefined;
      const toolName =
        typeof rawToolResult?.name === "string" && rawToolResult.name.trim()
          ? rawToolResult.name.trim()
          : typeof toolNameValue === "string" && toolNameValue.trim()
            ? toolNameValue.trim()
            : "";
      const toolResult = toolName || typeof rawToolResult?.isError === "boolean" || typeof isErrorValue === "boolean"
        ? {
            name: toolName,
            isError: Boolean(
              typeof rawToolResult?.isError === "boolean" ? rawToolResult.isError : isErrorValue,
            ),
          }
        : undefined;
      if (!content.trim() && !toolResult) {
        continue;
      }
      normalized.push({ role, content, ...(toolResult ? { toolResult } : {}) });
      continue;
    }
    if (typeof contentValue !== "string" || !content.trim()) {
      if (role !== "assistant" || !Array.isArray(toolCallsRaw)) {
        continue;
      }
    }
    const entry: GenerateConversationMessage = {
      role,
      content,
    };
    if (Array.isArray(toolCallsRaw)) {
      const toolCalls = toolCallsRaw
        .map((tc: Record<string, unknown>) => ({
          name: String(tc.name ?? ""),
          params: tc.params ?? tc.arguments,
        }))
        .filter(tc => tc.name);
      if (toolCalls.length > 0) {
        entry.toolCalls = toolCalls;
      }
    }
    if (!entry.content.trim() && !entry.toolCalls?.length) {
      continue;
    }
    normalized.push(entry);
  }
  return normalized;
}

function resolveRequestedGenerateSessionKey(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function sliceMessagesFromStartUserInput<T extends { role: string }>(
  messages: T[],
  startUserInputIndex: unknown,
): T[] {
  if (startUserInputIndex === undefined) {
    return messages;
  }
  if (
    typeof startUserInputIndex !== "number" ||
    !Number.isInteger(startUserInputIndex) ||
    startUserInputIndex < 0
  ) {
    throw new BadRequestError("startUserInputIndex must be a non-negative integer");
  }
  let userInputIndex = 0;
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].role !== "user") {
      continue;
    }
    if (userInputIndex === startUserInputIndex) {
      return messages.slice(i);
    }
    userInputIndex += 1;
  }
  throw new BadRequestError("startUserInputIndex is out of range");
}

export function normalizeGenerateRequestBody(params: {
  parsed: Record<string, unknown>;
  runtimeMessages?: GenerateConversationMessage[] | null;
  transcriptMessages?: GenerateConversationMessage[] | null;
}): Record<string, unknown> {
  const sessionKey = resolveRequestedGenerateSessionKey(params.parsed.sessionKey);

  if (sessionKey) {
    const sessionMessages =
      Array.isArray(params.runtimeMessages) && params.runtimeMessages.length > 0
        ? params.runtimeMessages
        : params.transcriptMessages;
    if (!Array.isArray(sessionMessages)) {
      throw new BadRequestError(`transcript messages required for sessionKey ${sessionKey}`);
    }
    const sliced = sliceMessagesFromStartUserInput(sessionMessages, params.parsed.startUserInputIndex);
    const merged = mergeConsecutiveSameRole(sliced);
    if (merged.length === 0) {
      throw new BadRequestError(`no transcript messages found for sessionKey ${sessionKey}`);
    }
    return {
      ...params.parsed,
      sessionKey,
      messages: merged,
    };
  }

  if (Array.isArray(params.parsed.messages)) {
    const normalized = normalizeGenerateMessages(params.parsed.messages);
    const sliced = sliceMessagesFromStartUserInput(normalized, params.parsed.startUserInputIndex);
    return {
      ...params.parsed,
      messages: mergeConsecutiveSameRole(sliced),
    };
  }

  return params.parsed;
}

function buildPythonEnv(api: OpenClawPluginApi, assetsDir: string): Record<string, string> {
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789";
  return {
    PYTHON_BIN: resolveConfiguredPythonBin(api),
    ASSETS_DIR: assetsDir,
    OPENCLAW_GATEWAY_URL: gatewayUrl,
    OPENCLAW_GATEWAY_TOKEN: resolveGatewayTokenForInternalCalls({ api, gatewayUrl }),
  };
}

// Singleton runtime: gateway may call register() multiple times (e.g. ensureRuntimePluginsLoaded).
// Reuse the same LiveAssetsRuntime to prevent stale-asset bugs where save updates one instance
// while hooks read from another.
let singletonRuntime: LiveAssetsRuntime | null = null;

export function resetLiveAssetsPluginRuntimeForTests(): void {
  singletonRuntime = null;
}

export default {
  id: "live-assets",
  name: "LiveAssets",

  register(api: OpenClawPluginApi): void {
    const assetsDir = resolveAssetsDir(api);
    mkdir(assetsDir, { recursive: true }).catch(() => {});
    if (!singletonRuntime) {
      singletonRuntime = new LiveAssetsRuntime({ assetsDir });
    }
    const runtime = singletonRuntime;
    const pyEnvBase = buildPythonEnv(api, assetsDir);
    const buildScopedPythonEnv = (params: { sessionKey?: string; agentId?: unknown }) => ({
      ...pyEnvBase,
      LIVE_ASSETS_INTERNAL_AGENT_ID: resolveLiveAssetsAgentId(params),
    });
    const sessionKeyById = new Map<string, string>();
    const resolveRuntimeSessionKey = (ctx: Record<string, unknown>) =>
      runtime.resolveSessionKey(
        resolveRuntimeSessionKeyFromHookContext(ctx, {
          sessionKeyById,
          hasRuntimeSession: (candidate) => runtime.hasSession(candidate),
          defaultSessionKey: "default",
        }),
      );

    let internalGatewayCallDepth = 0;
    const hasInternalGatewayCallInFlight = () => internalGatewayCallDepth > 0;
    const withInternalGatewayCallBypass = async <T>(fn: () => Promise<T>): Promise<T> => {
      internalGatewayCallDepth += 1;
      try {
        return await fn();
      } finally {
        internalGatewayCallDepth -= 1;
      }
    };

    // Pending _meta for the next assistant message written to session JSONL.
    // Keyed by sessionKey so concurrent sessions don't collide.
    const pendingRewriteMeta = new Map<string, {
      rewritten: true;
      assetId: string;
      reason?: string;
      originalDraft: string;
    }>();

    // ══════════════════════════════════════════════
    //  Tools — registered from asset JSON, execute returns scenario data
    // ══════════════════════════════════════════════

    const registeredTools = new Set<string>();
    const toolDataMap = new Map<string, string>();

    async function syncAssetTools(): Promise<void> {
      const assets = await runtime.listAssets();
      for (const asset of assets) {
        for (const tool of asset.tools ?? []) {
          toolDataMap.set(tool.name, tool.mockResponse);
          if (registeredTools.has(tool.name)) continue;
          registeredTools.add(tool.name);
          const toolName = tool.name;
          api.registerTool?.({
            name: tool.name,
            label: tool.description,
            description: tool.description,
            parameters: tool.parameters ?? { type: "object", properties: {} },
            execute: async (_id, _params) => {
              const text = toolDataMap.get(toolName) ?? "No data available";
              return { content: [{ type: "text" as const, text }] };
            },
          });
          api.logger.info(`[live-assets] registered tool: ${tool.name}`);
        }
      }
    }

    syncAssetTools().catch(err => {
      api.logger.warn(`[live-assets] initial tool registration failed: ${err}`);
    });

    // ══════════════════════════════════════════════
    //  Commands
    // ══════════════════════════════════════════════

    const registerCommand = (
      name: string,
      params: {
        description: string;
        acceptsArgs: boolean;
        handler: (ctx: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }> | { text: string; isError?: boolean };
      },
    ): void => {
      api.registerCommand?.({
        name,
        description: params.description,
        acceptsArgs: params.acceptsArgs,
        handler: params.handler,
      });
    };

    registerCommand("liveassets-status", {
      description: "List all loaded LiveAssets.",
      acceptsArgs: false,
      handler: async () => {
        const assets = await runtime.listAssets();
        if (assets.length === 0) return { text: "No assets loaded." };
        const lines = assets.map(a =>
          `* ${a.assetId} (v${a.version ?? 1}) - ${a.scenarioId ?? "-"} - ${(a.tools ?? []).length} tools`,
        );
        return { text: lines.join("\n") };
      },
    });

    registerCommand("liveassets-viz", {
      description: "Visualize the active LiveAsset and process-control state.",
      acceptsArgs: true,
      handler: async (ctx: Record<string, unknown>) => {
        const sessionKey = resolveRuntimeSessionKey(ctx);
        return { text: runtime.visualize(sessionKey) };
      },
    });

    registerCommand("liveassets-reload", {
      description: "Hot reload LiveAssets from disk.",
      acceptsArgs: false,
      handler: async () => {
        const count = await runtime.reload();
        await syncAssetTools();
        return { text: `Reloaded ${count} assets. Tools are synced.` };
      },
    });

    registerCommand("liveassets-delete", {
      description: "Delete a LiveAsset. Usage: /liveassets-delete <assetId>",
      acceptsArgs: true,
      handler: async (ctx: Record<string, unknown>) => {
        const assetId = String(ctx?.args ?? "").trim();
        if (!assetId) {
          return { text: "Usage: /liveassets-delete <assetId>", isError: true };
        }
        const deleted = await runtime.deleteAsset(assetId);
        if (deleted) {
          await runtime.reload();
          await syncAssetTools();
          return { text: `Asset ${assetId} deleted.` };
        } else {
          return { text: `Delete failed: asset ${assetId} does not exist or delete errored.`, isError: true };
        }
      },
    });

    /** Strip OpenClaw metadata wrappers from user messages. */
    function cleanUserMessage(text: string): string {
      const metaRe =
        /^(?:(?:Conversation info \(untrusted metadata\)|Sender \(untrusted metadata\)|Thread starter \(untrusted, for context\)|Replied message \(untrusted, for context\)|Forwarded message context \(untrusted metadata\)|Chat history since last reply \(untrusted, for context\)):\s*```json[\s\S]*?```\s*)+/i;
      let cleaned = text.replace(metaRe, "").trim();
      cleaned = cleaned.replace(
        /^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?[^\]]*\]\s*/u,
        "",
      ).trim();
      return cleaned;
    }

    /** Strip LiveAsset inline trace from assistant messages. */
    function cleanAssistantMessage(text: string): string {
      const traceIdx = text.indexOf("\n\n---\n**LiveAsset**");
      return traceIdx >= 0 ? text.slice(0, traceIdx).trim() : text;
    }

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
          const record = part as { type?: unknown; text?: unknown };
          return record.type === "text" && typeof record.text === "string" ? record.text : "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();
    }

    const TOOL_CALL_TYPES = new Set(["toolCall", "toolUse", "functionCall"]);

    function extractToolCallsFromMessageContent(
      content: unknown,
    ): Array<{ name: string; params?: unknown }> {
      if (!Array.isArray(content)) {
        return [];
      }
      return content
        .filter((part): part is Record<string, unknown> => typeof part === "object" && part !== null)
        .filter((part) => typeof part.type === "string" && TOOL_CALL_TYPES.has(part.type) && part.name)
        .map((part) => ({
          name: String(part.name),
          params: part.input ?? part.arguments ?? part.params,
        }));
    }

    function snapshotToRewriteConversation(
      messages: unknown[],
    ): Array<{
      role: string;
      content: string;
      toolCalls?: Array<{ name: string; params?: unknown }>;
      toolResult?: { name: string; isError: boolean };
    }> {
      return buildRewriteConversationSnapshot(messages);
    }

    function buildRewriteFailureText(reason: string | undefined): string {
      const detail = reason?.trim() ? ` (${reason.trim()})` : "";
      return `I need to satisfy the active output controls, but the rewrite did not pass validation${detail}. Please try again.`;
    }

    function buildProcessFailureText(detail: string): string {
      return `I cannot send a final reply yet. These required steps must finish first: ${detail}. Please try again.`;
    }


    function formatGeneratedAssetTrace(
      assetId: string,
      asset: Record<string, unknown> | undefined,
      summaryLine: string,
    ): string {
      if (!asset) return `Generated LiveAsset: ${assetId}\n${summaryLine}`;

      const lines: string[] = [`**LiveAsset** \`${assetId}\` v${asset.version ?? 1}`, ""];
      if (summaryLine) lines.push(summaryLine);

      // Matching
      const m = (asset.matching ?? {}) as Record<string, string[]>;
      const matchParts: string[] = [];
      if (m.any?.length) matchParts.push(`any:[${m.any.join(", ")}]`);
      if (m.all?.length) matchParts.push(`all:[${m.all.join(", ")}]`);
      if (m.not?.length) matchParts.push(`not:[${m.not.join(", ")}]`);
      if (matchParts.length) lines.push(`**Matching** ${matchParts.join("  ")}`);

      // Input rules
      const ic = asset.inputControl as Array<Record<string, unknown>> | undefined;
      if (ic?.length) {
        lines.push(`**Input Control** ${ic.map(r => `\`${r.check}\` -> ${r.inject}`).join("; ")}`);
      }

      // Process constraints
      const constraints = (asset.processControl ?? []) as Array<Record<string, unknown>>;
      if (constraints.length) {
        lines.push(
          `**Process Control** ${constraints.map(c => `${c.then}${c.reason ? ` (${c.reason})` : ""}`).join("; ")}`,
        );
      }

      // Output rules
      const oc = asset.outputControl as Array<Record<string, unknown>> | undefined;
      if (oc?.length) {
        lines.push(`**Output Control** ${oc.map(r => `\`${r.check}\``).join("  ")}`);
      }

      // Tools
      const tools = asset.tools as Array<Record<string, unknown>> | undefined;
      if (tools?.length) {
        lines.push(`**Tools** ${tools.map(t => `\`${t.name}\``).join("  ")}`);
      }

      return lines.join("\n");
    }

    function pickMostRecentWebchatEntry(
      entries: Array<[string, Record<string, unknown>]>,
    ): [string, Record<string, unknown>] | undefined {
      let best: [string, Record<string, unknown>] | undefined;
      let bestTime = -1;
      for (const entry of entries) {
        if (entry[1].lastChannel !== "webchat") continue;
        const t = typeof entry[1].updatedAt === "number" ? entry[1].updatedAt : 0;
        if (t > bestTime) {
          bestTime = t;
          best = entry;
        }
      }
      return best ?? entries[0];
    }

    async function readOpenClawSessionMessages(
      params?: { sessionKey?: string },
    ): Promise<GenerateConversationMessage[]> {
      const stateDir = process.env.OPENCLAW_STATE_DIR
        ?? path.join(process.env.HOME ?? "", ".openclaw");
      const requestedSessionKey = params?.sessionKey?.trim();
      const readSessionStoreEntries = async (
        agentId: string,
      ): Promise<Array<[string, Record<string, unknown>]>> => {
        const sessionsJsonPath = path.join(
          stateDir,
          "agents",
          normalizeLiveAssetsAgentId(agentId),
          "sessions",
          "sessions.json",
        );
        const sessionsData = JSON.parse(
          await readFile(sessionsJsonPath, "utf-8"),
        ) as Record<string, Record<string, unknown>>;
        return Object.entries(sessionsData);
      };

      try {
        let matchedEntry: [string, Record<string, unknown>] | undefined;

        if (requestedSessionKey) {
          const entries = await readSessionStoreEntries(
            resolveLiveAssetsAgentId({ sessionKey: requestedSessionKey }),
          );
          matchedEntry = entries.find(
            ([key]) => key === requestedSessionKey || key.toLowerCase() === requestedSessionKey.toLowerCase(),
          );
        } else {
          const agentsDir = path.join(stateDir, "agents");
          const agentDirs = await readdir(agentsDir, { withFileTypes: true }).catch(() => []);
          let bestTime = -1;
          for (const dirent of agentDirs) {
            if (!dirent.isDirectory()) {
              continue;
            }
            try {
              const entries = await readSessionStoreEntries(dirent.name);
              const candidate = pickMostRecentWebchatEntry(entries);
              if (!candidate) {
                continue;
              }
              const candidateTime =
                typeof candidate[1].updatedAt === "number" ? candidate[1].updatedAt : 0;
              if (candidateTime > bestTime) {
                bestTime = candidateTime;
                matchedEntry = candidate;
              }
            } catch {
              continue;
            }
          }
        }
        if (!matchedEntry) {
          if (requestedSessionKey) {
            throw new BadRequestError(`sessionKey not found in OpenClaw sessions: ${requestedSessionKey}`);
          }
          return [];
        }
        const [resolvedSessionKey, entry] = matchedEntry;
        const sessionFile = entry?.sessionFile as string | undefined;
        if (!sessionFile) {
          if (requestedSessionKey) {
            throw new BadRequestError(`session ${resolvedSessionKey} has no sessionFile`);
          }
          return [];
        }

        const fileContent = await readFile(sessionFile, "utf-8");
        const raw: GenerateConversationMessage[] = [];

        for (const line of fileContent.split("\n")) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line) as Record<string, unknown>;
            if (record.type !== "message") continue;
            const msg = record.message as Record<string, unknown> | undefined;
            if (!msg) continue;
            const role = String(msg.role ?? "");
            if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;

            let text = extractTextFromMessageContent(msg.content);
            let toolCalls: Array<{ name: string; params?: unknown }> | undefined;
            let toolResult: { name: string; isError: boolean } | undefined;

            if (role === "assistant") {
              toolCalls = extractToolCallsFromMessageContent(msg.content);
              text = cleanAssistantMessage(text);
            } else if (role === "user") {
              text = cleanUserMessage(text);
            } else if (role === "toolResult") {
              const toolName = String(msg.toolName ?? msg.tool_name ?? "");
              const isError = Boolean(msg.isError);
              toolResult = { name: toolName, isError };
              if (!text && toolName) {
                text = `[Tool: ${toolName}${isError ? " ERROR" : ""}]`;
              }
            }

            if (text.trim() || toolCalls?.length || toolResult) {
              const entry: GenerateConversationMessage =
                { role, content: text };
              if (toolCalls?.length) entry.toolCalls = toolCalls;
              if (toolResult) entry.toolResult = toolResult;
              raw.push(entry);
            }
          } catch { /* skip malformed lines */ }
        }

        return mergeConsecutiveSameRole(raw);
      } catch (err) {
        if (params?.sessionKey) {
          throw err;
        }
        return [];
      }
    }

    async function readCurrentSessionMessages(
      sessionKey?: string,
    ): Promise<GenerateConversationMessage[]> {
      if (sessionKey) {
        const runtimeMessages = mergeConsecutiveSameRole(runtime.getSessionMessages(sessionKey));
        if (runtimeMessages.length > 0) {
          return runtimeMessages;
        }
      }
      if (sessionKey) {
        try {
          return await readOpenClawSessionMessages({ sessionKey });
        } catch {
          // Session key not found in sessions.json — fall back to default
          // heuristic (find most recent webchat session).
          api.logger.info(
            `[live-assets] readCurrentSessionMessages: sessionKey=${sessionKey} not found, falling back`,
          );
        }
      }
      return readOpenClawSessionMessages();
    }

    registerCommand("liveassets-generate", {
      description: "Generate a LiveAsset from the current conversation. Without args, it auto-reads current session history.",
      acceptsArgs: true,
      handler: async (ctx: Record<string, unknown>) => {
        const args = String(ctx?.args ?? "").trim();

        let sample: object;
        let liveAssetsGenerateSummaryLine = "";

        if (!args) {
          // Resolve the actual session key from command context so we read the
          // correct transcript (not just the first webchat session we find).
          const ctxSessionKey = resolveRuntimeSessionKey(ctx);
          const useKey = ctxSessionKey !== "default" ? ctxSessionKey : undefined;
          const messages = await readCurrentSessionMessages(useKey);
          const userTurns = messages.filter(m => m.role === "user").length;
          const toolCallCount = messages.filter(m => m.toolCalls?.length).length;
          if (messages.length < 2) {
            return {
              text: `Conversation too short (${messages.length} cleaned messages, ${userTurns} user turns). Please chat for a few rounds, then save as an asset.`,
              isError: true,
            };
          }
          sample = { messages };
          liveAssetsGenerateSummaryLine = `(${userTurns} user turns, system messages and metadata filtered)\n`;
          api.logger.info(
            `[live-assets] /liveassets-generate: session=${useKey ?? "(fallback)"}, ${messages.length} cleaned messages (${userTurns} user turns, ${toolCallCount} tool calls)`,
          );
        } else {
          try {
            sample = JSON.parse(args) as object;
          } catch {
            return { text: "Arguments are not valid JSON.", isError: true };
          }
        }

        try {
          const ctxSessionKey = resolveRuntimeSessionKey(ctx);
          const result = await spawnPython(
            "generate.py",
            sample,
            buildScopedPythonEnv({
              sessionKey: ctxSessionKey !== "default" ? ctxSessionKey : undefined,
              agentId: ctx.agentId,
            }),
            api.logger,
            300_000,
          );
          await runtime.reload();
          await syncAssetTools();
          const asset = (result as Record<string, unknown>).asset as Record<string, unknown> | undefined;
          const assetId = (result as Record<string, unknown>).assetId ?? "unknown";
          return { text: formatGeneratedAssetTrace(String(assetId), asset, liveAssetsGenerateSummaryLine) };
        } catch (err) {
          return { text: `Generation failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    });

    registerCommand("liveassets-feedback", {
      description: "Update the currently active asset based on feedback. Parameters: feedback text.",
      acceptsArgs: true,
      handler: async (ctx: Record<string, unknown>) => {
        const feedback = String(ctx?.args ?? "").trim();
        if (!feedback) {
          return { text: "Usage: /liveassets-feedback <feedback text>" };
        }

        const sessionKey = resolveRuntimeSessionKey(ctx);
        const active = runtime.getActiveAsset(sessionKey);
        if (!active) {
          return { text: "Current session has no active asset. Please send a message that matches the asset first.", isError: true };
        }
        const conversation = mergeConsecutiveSameRole(runtime.getSessionMessages(sessionKey));
        if (conversation.length < 2 || !conversation.some((m) => m.role === "user")) {
          return {
            text: "Current session has insufficient history for update validation. Please chat normally for a few rounds before providing feedback.",
            isError: true,
          };
        }

        const input = {
          asset_id: active.assetId,
          feedback,
          conversation,
        };

        try {
          const result = await spawnPython(
            "feedback.py",
            input,
            buildScopedPythonEnv({ sessionKey, agentId: ctx.agentId }),
            api.logger,
            300_000,
          );
          await runtime.reload();
          await syncAssetTools();
          const r = result as Record<string, unknown>;
          const reasoning = r.reasoning as Record<string, unknown> | undefined;
          const version = ((r.asset as Record<string, unknown>)?.version as number) ?? "?";
          const changes = reasoning?.changes ?? "";
          return { text: `Asset updated (v${version}): ${changes}\nattempt: ${r.attempt}` };
        } catch (err) {
          return { text: `Update failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    });

    registerCommand("liveassets-baseline", {
      description: "Compare: the original response from OpenClaw to the last user message when no assets are used.",
      acceptsArgs: true,
      handler: async (ctx: Record<string, unknown>) => {
        const sessionKey = resolveRuntimeSessionKey(ctx);
        const messages = runtime.getSessionMessages(sessionKey);
        const lastUser = [...messages].reverse().find(m => m.role === "user");
        if (!lastUser) {
          return { text: "Current session has no user messages. Please send a message first.", isError: true };
        }

        const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789";
        const gatewayToken = resolveGatewayTokenForInternalCalls({ api, gatewayUrl });
        const agentId = resolveLiveAssetsAgentId({ sessionKey, agentId: ctx.agentId });
        const baselineSessionKey = buildInternalLiveAssetsSessionKey(agentId, "baseline");

        api.logger.info("[live-assets] /liveassets-baseline: start (skipping all asset hooks)");
        try {
          const apiResp = await withInternalGatewayCallBypass(() =>
            fetch(`${gatewayUrl}/v1/chat/completions`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${gatewayToken}`,
                "x-openclaw-agent-id": agentId,
                "x-openclaw-session-key": baselineSessionKey,
              },
              body: JSON.stringify({
                model: `openclaw:${agentId}`,
                messages: [{ role: "user", content: lastUser.content }],
              }),
            }),
          );
          const data = (await apiResp.json()) as Record<string, unknown>;
          const choices = data.choices as Array<Record<string, unknown>> | undefined;
          const output = (choices?.[0]?.message as Record<string, string>)?.content ?? "(empty)";

          const active = runtime.getActiveAsset(sessionKey);
          let result = `**Baseline (OpenClaw without asset constraints)**\n\n${output}`;
          if (active) {
            result += `\n\n---\n*Current conversation is constrained by **${active.assetId}** (v${active.version ?? 1}). Above is the original response from OpenClaw when no assets are used.*`;
          }
          api.logger.info("[live-assets] /liveassets-baseline: completed");
          return { text: result };
        } catch (err) {
          return { text: `Baseline generation failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    });

    // ══════════════════════════════════════════════
    //  Hooks
    // ══════════════════════════════════════════════

    // Hook 1: before_prompt_build — match asset, augment the current prompt
    api.on(
      "before_prompt_build",
      async (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
        const sessionKey = resolveRuntimeSessionKey(ctx);
        if (hasInternalGatewayCallInFlight() || isInternalLiveAssetsSessionKey(sessionKey)) {
          return undefined;
        }
        const prompt = typeof event?.prompt === "string" ? event.prompt : undefined;
        const rawUserInput =
          typeof event?.rawUserInput === "string" ? event.rawUserInput : undefined;
        const messages = Array.isArray(event?.messages) ? event.messages : [];
        if (messages.length > 0) {
          runtime.setSessionMessages({
            sessionKey,
            messages: buildRewriteConversationSnapshot(messages),
          });
        }

        // ── diagnostic: trace first-message matching ──
        api.logger.info(
          `[live-assets][diag] before_prompt_build called | session=${sessionKey} | ` +
          `prompt=${prompt ? `"${prompt.slice(0, 60)}"` : "undefined"} | ` +
          `rawUserInput=${rawUserInput ? `"${rawUserInput.slice(0, 60)}"` : "undefined"} | ` +
          `messages.length=${messages.length} | ` +
          `internalCallDepth=${internalGatewayCallDepth} | ` +
          `eventKeys=${Object.keys(event ?? {}).join(",")}`,
        );
        // ── end diagnostic ──

        const consumed = runtime.consumePreparedInput({ sessionKey, messages, prompt });
        if (consumed) {
          api.logger.info(`[live-assets][diag] consumePreparedInput hit → aug=${consumed.inputAugmentation ? "yes" : "no"}`);
          return consumed.inputAugmentation
            ? { appendContext: consumed.inputAugmentation }
            : undefined;
        }
        const result = await runtime.matchAndActivateAsset({
          prompt,
          rawUserInput,
          messages,
          sessionKey,
        });

        if (!result) {
          api.logger.info(`[live-assets][diag] matchAndActivateAsset returned undefined`);
          return undefined;
        }

        api.logger.info(
          `[live-assets] matched asset: ${result.asset.assetId} (session: ${sessionKey}) | aug=${result.inputAugmentation ? "yes" : "no"}`,
        );

        return result.inputAugmentation
          ? { appendContext: result.inputAugmentation }
          : undefined;
      },
      { priority: 60 },
    );

    // Hook 2: before_tool_call — enforce processControl constraints
    api.on("before_tool_call", async (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
      const sessionKey = resolveRuntimeSessionKey(ctx);
      if (hasInternalGatewayCallInFlight() || isInternalLiveAssetsSessionKey(sessionKey)) {
        return undefined;
      }
      const decision = runtime.beforeToolCall({
        sessionKey,
        toolName: typeof event?.toolName === "string" ? event.toolName : undefined,
        toolParams: event?.params as Record<string, unknown> | undefined,
      });

      if (decision) {
        api.logger.info(`[live-assets] blocked tool: ${event?.toolName} — ${decision.blockReason}`);
      }

      return decision;
    });

    // Hook 3: after_tool_call — update done/errors state + log
    api.on("after_tool_call", async (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
      const sessionKey = resolveRuntimeSessionKey(ctx);
      if (hasInternalGatewayCallInFlight() || isInternalLiveAssetsSessionKey(sessionKey)) {
        return;
      }
      const toolName = typeof event?.toolName === "string" ? event.toolName : "";
      if (!toolName) return;

      // Detect error from event.error (transport-level) or from tool response content (business-level)
      let error = typeof event?.error === "string" ? event.error : undefined;
      if (!error) {
        const result = event?.result;
        if (typeof result === "object" && result !== null && typeof (result as Record<string, unknown>).error === "string") {
          error = (result as Record<string, unknown>).error as string;
        } else if (typeof result === "string") {
          try {
            const parsed = JSON.parse(result);
            if (typeof parsed?.error === "string") {
              error = parsed.error;
            }
          } catch { /* not JSON, ignore */ }
        }
      }
      runtime.afterToolCall({ sessionKey, toolName, error });

      const active = runtime.getActiveAsset(sessionKey);
      if (active) {
        const state = runtime.serializeSession(sessionKey) as Record<string, unknown> | null;
        const done = (state?.done ?? []) as string[];
        const constraints = state?.constraints as Record<string, string[]> | undefined;
        api.logger.info(
          `[live-assets] tool ${error ? "✗" : "✓"} ${toolName} | done=[${done.join(",")}] require=[${(constraints?.require ?? []).join(",")}] forbid=[${(constraints?.forbid ?? []).join(",")}]`,
        );
      }
    });

    // Hook 4: assistant_response — fail closed on unmet processControl, otherwise enforce outputControl
    api.on("assistant_response", async (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
      const sessionKey = resolveRuntimeSessionKey(ctx);
      if (hasInternalGatewayCallInFlight() || isInternalLiveAssetsSessionKey(sessionKey)) {
        return undefined;
      }
      const snapshotMessages = Array.isArray(event?.messages) ? event.messages : [];
      if (snapshotMessages.length > 0) {
        runtime.setSessionMessages({
          sessionKey,
          messages: buildRewriteConversationSnapshot(snapshotMessages),
        });
      }
      const assistantText = typeof event?.assistantText === "string" ? event.assistantText : "";
      if (!assistantText.trim()) return undefined;

      const pendingRequirements = runtime.getPendingRequiredTools({ sessionKey });
      if (pendingRequirements) {
        runtime.recordProcessRequirementBlocked({
          sessionKey,
          tools: pendingRequirements.tools,
          detail: pendingRequirements.detail,
          constraintDetails: pendingRequirements.constraintDetails,
        });
        api.logger.warn(
          `[live-assets] process constraints not met before final response (session: ${sessionKey}, asset: ${pendingRequirements.asset.assetId}, require: ${pendingRequirements.tools.join(",")})`,
        );
        return { text: buildProcessFailureText(pendingRequirements.detail) };
      }

      const violation = runtime.checkMessageOutput({ sessionKey, content: assistantText });
      if (!violation) return undefined;

      const conversation = snapshotToRewriteConversation(
        Array.isArray(event?.messages) ? event.messages : [],
      );
      const lastMessage = conversation[conversation.length - 1];
      const rewriteConversation =
        lastMessage?.role === "assistant" && lastMessage.content === assistantText
          ? conversation.slice(0, -1)
          : conversation;
      const rewritePrompt = buildRewriteUserPrompt({
        conversation: rewriteConversation,
        asset: violation.asset,
        draft: assistantText,
        reason: violation.reason ?? "",
      });

      api.logger.warn(
        `[live-assets] output constraint not met, starting rewrite (session: ${sessionKey}, asset: ${violation.asset.assetId})\n` +
        `  reason: ${violation.reason ?? "(no reason)"}\n` +
        `  original draft (${assistantText.length} chars): ${assistantText.slice(0, 200)}${assistantText.length > 200 ? "..." : ""}\n` +
        `  rewrite user prompt (${rewritePrompt.length} chars):\n${rewritePrompt}`,
      );
      runtime.recordOutputRewriteStarted({
        sessionKey,
        reason: violation.reason,
        originalDraft: assistantText,
        rewritePrompt,
      });

      try {
        const scopedPyEnv = buildScopedPythonEnv({ sessionKey, agentId: ctx.agentId });
        const rewriteResult = await withInternalGatewayCallBypass(() =>
          spawnPython(
            "rewrite.py",
            {
              conversation: rewriteConversation,
              asset: violation.asset,
              draft: assistantText,
              reason: violation.reason ?? "",
              userPrompt: rewritePrompt,
            },
            scopedPyEnv,
            api.logger,
            180_000,
          ),
        );
        const rewrittenText = String(rewriteResult.output ?? "").trim();
        api.logger.info(
          `[live-assets] rewrite output (${rewrittenText.length} chars): ${rewrittenText.slice(0, 300)}${rewrittenText.length > 300 ? "..." : ""}`,
        );
        if (!rewrittenText) {
          api.logger.warn(`[live-assets] rewrite returned empty output (session: ${sessionKey})`);
          runtime.recordOutputRewriteFailed({ sessionKey, reason: "empty output" });
          return { text: buildRewriteFailureText("rewrite returned empty output") };
        }

        const rewrittenViolation = runtime.checkMessageOutput({
          sessionKey,
          content: rewrittenText,
        });
        if (rewrittenViolation) {
          api.logger.warn(
            `[live-assets] rewrite still failed output constraint (session: ${sessionKey}, reason: ${rewrittenViolation.reason ?? "unknown"})`,
          );
          runtime.recordOutputRewriteFailed({
            sessionKey,
            reason: rewrittenViolation.reason,
            rewrittenText,
          });
          return { text: buildRewriteFailureText(rewrittenViolation.reason) };
        }

        api.logger.info(`[live-assets] rewrite passed output constraint (session: ${sessionKey})`);
        runtime.recordOutputRewritePassed({ sessionKey, rewrittenText });
        pendingRewriteMeta.set(sessionKey, {
          rewritten: true,
          assetId: violation.asset.assetId,
          reason: violation.reason,
          originalDraft: assistantText,
        });
        return { text: rewrittenText };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        api.logger.warn(`[live-assets] rewrite failed (session: ${sessionKey}): ${detail}`);
        runtime.recordOutputRewriteFailed({ sessionKey, reason: detail });
        return { text: buildRewriteFailureText(detail) };
      }
    });

    // Hook 5: before_message_write — attach _meta to rewritten assistant messages
    api.on("before_message_write", (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
      const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : undefined;
      if (!sessionKey) return;
      const meta = pendingRewriteMeta.get(sessionKey);
      if (!meta) return;
      pendingRewriteMeta.delete(sessionKey);

      const message = event?.message;
      if (!message || typeof message !== "object") return;
      const role = (message as Record<string, unknown>).role;
      if (role !== "assistant") return;

      (message as Record<string, unknown>)._meta = meta;
      return { message: message as never };
    });

    // Hook 6: session_end — clear session state
    api.on("session_end", async (_event: unknown, ctx: Record<string, unknown>) => {
      const sessionKey = resolveRuntimeSessionKey(ctx);
      runtime.clearSession(sessionKey);
      pendingRewriteMeta.delete(sessionKey);
    });

    // ══════════════════════════════════════════════
    //  HTTP Routes (for UI)
    // ══════════════════════════════════════════════

    const corsHeaders = (res: ServerResponse) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    };

    function readBody(req: IncomingMessage): Promise<string> {
      return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
    }

    // GET /live-assets/assets
    api.registerHttpRoute?.({
      path: "/live-assets/assets",
      auth: "plugin",
      handler: async (req, res) => {
        if (req.method === "OPTIONS") { corsHeaders(res); res.end(); return true; }
        corsHeaders(res);
        const assets = await runtime.listAssets();
        const data = assets.map((asset) => ({
          ...asset,
          version: asset.version ?? 1,
          filePath: assetFilePath(assetsDir, asset.assetId),
        }));
        res.end(JSON.stringify(data));
        return true;
      },
    });

    // GET /live-assets/sessions
    api.registerHttpRoute?.({
      path: "/live-assets/sessions",
      auth: "plugin",
      handler: async (req, res) => {
        if (req.method === "OPTIONS") { corsHeaders(res); res.end(); return true; }
        corsHeaders(res);
        const keys = runtime.listSessions();
        const data = keys.map(key => ({ key, ...runtime.serializeSession(key) }));
        res.end(JSON.stringify(data));
        return true;
      },
    });

    // POST /live-assets/reload
    api.registerHttpRoute?.({
      path: "/live-assets/reload",
      auth: "plugin",
      handler: async (req, res) => {
        if (req.method === "OPTIONS") { corsHeaders(res); res.end(); return true; }
        corsHeaders(res);
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: "Method Not Allowed" }));
          return true;
        }
        const count = await runtime.reload();
        await syncAssetTools();
        api.logger.info(`[live-assets] hot reload completed, loaded ${count} assets`);
        res.end(JSON.stringify({ reloaded: true, assetCount: count }));
        return true;
      },
    });

    // POST /live-assets/save — write asset JSON to disk, reload
    api.registerHttpRoute?.({
      path: "/live-assets/save",
      auth: "plugin",
      handler: async (req, res) => {
        if (req.method === "OPTIONS") { corsHeaders(res); res.end(); return true; }
        corsHeaders(res);
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: "Method Not Allowed" }));
          return true;
        }

        try {
          const body = await readBody(req);
          const asset = JSON.parse(body) as Record<string, unknown>;
          const assetId = String(asset.assetId ?? "unnamed");
          const filePath = assetFilePath(assetsDir, assetId);
          await writeFile(filePath, JSON.stringify(asset, null, 2), "utf-8");
          const count = await runtime.reload();
          await syncAssetTools();
          api.logger.info(`[live-assets] saved asset: ${assetId}, reloaded ${count} assets`);
          res.end(JSON.stringify({ saved: true, assetId, assetCount: count, filePath }));
        } catch (err) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: String(err) }));
        }
        return true;
      },
    });

    // POST /live-assets/delete — delete an asset by ID
    api.registerHttpRoute?.({
      path: "/live-assets/delete",
      auth: "plugin",
      handler: async (req, res) => {
        if (req.method === "OPTIONS") { corsHeaders(res); res.end(); return true; }
        corsHeaders(res);
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: "Method Not Allowed" }));
          return true;
        }

        try {
          const body = await readBody(req);
          const params = JSON.parse(body) as Record<string, unknown>;
          const assetId = String(params.assetId ?? "");
          if (!assetId) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "assetId required" }));
            return true;
          }

          const deleted = await runtime.deleteAsset(assetId);
          if (deleted) {
            const count = await runtime.reload();
            await syncAssetTools();
            api.logger.info(`[live-assets] deleted asset: ${assetId}, remaining ${count}`);
            res.end(JSON.stringify({ deleted: true, assetId, assetCount: count }));
          } else {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: `Asset ${assetId} not found` }));
          }
        } catch (err) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: String(err) }));
        }
        return true;
      },
    });

    // POST /live-assets/trace — show what asset matched + which input augmentation fired for a query
    api.registerHttpRoute?.({
      path: "/live-assets/trace",
      auth: "plugin",
      handler: async (req, res) => {
        if (req.method === "OPTIONS") { corsHeaders(res); res.end(); return true; }
        corsHeaders(res);
        if (req.method !== "POST") { res.statusCode = 405; res.end(JSON.stringify({ error: "POST only" })); return true; }

        try {
          const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
          const rawQuery = cleanUserMessage(String(body.query ?? ""));
          if (!rawQuery) { res.end(JSON.stringify({ matched: false })); return true; }

          await runtime.ensureLoaded();
          const assets = await runtime.listAssets();
          const query = stripInputAugmentationFromKnownAssets(assets, rawQuery);
          const matched = findMatchingAsset(assets, query);
          if (!matched) { res.end(JSON.stringify({ matched: false, query })); return true; }

          const inputAugmentation = buildInputAugmentation(matched.inputControl, query);
          const inputResult = buildInput(matched.inputControl, query);

          const lowerQuery = query.toLowerCase();
          const kwHit = (kw: string) => lowerQuery.includes(kw.toLowerCase());
          const matching = matched.matching ?? {};

          res.end(JSON.stringify({
            matched: true,
            query,
            assetId: matched.assetId,
            version: matched.version ?? 1,
            assetJson: matched,
            trigger: {
              any: (matching.any ?? []).map((kw: string) => ({ kw, hit: kwHit(kw) })),
              all: (matching.all ?? []).map((kw: string) => ({ kw, hit: kwHit(kw) })),
              not: (matching.not ?? []).map((kw: string) => ({ kw, hit: kwHit(kw) })),
            },
            inputAugmentation,
            firedInputRules: inputResult.prompts,
            processConstraints: (matched.processControl ?? []).map((constraint) => ({
              then: constraint.then,
              reason: constraint.reason,
              when: constraint.when ?? null,
            })),
            outputRules: (matched.outputControl ?? []).map(r => ({ check: r.check, rewrite: r.rewrite })),
            tools: (matched.tools ?? []).map(t => t.name),
          }));
        } catch (err) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: String(err) }));
        }
        return true;
      },
    });

    // POST /live-assets/baseline — generate a response via OpenClaw WITHOUT asset prompt augmentation
    api.registerHttpRoute?.({
      path: "/live-assets/baseline",
      auth: "plugin",
      handler: async (req, res) => {
        if (req.method === "OPTIONS") { corsHeaders(res); res.end(); return true; }
        corsHeaders(res);
        if (req.method !== "POST") { res.statusCode = 405; res.end(JSON.stringify({ error: "POST only" })); return true; }

        try {
          const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
          const sessionKey = resolveRequestedGenerateSessionKey(body.sessionKey);
          const agentId = resolveLiveAssetsAgentId({
            sessionKey,
            agentId: body.agentId,
          });
          const baselineSessionKey = buildInternalLiveAssetsSessionKey(agentId, "baseline");
          let chatMessages: Array<Record<string, string>>;
          if (typeof body.query === "string" && body.query.trim()) {
            chatMessages = [{ role: "user", content: body.query.trim() }];
          } else if (Array.isArray(body.messages) && body.messages.length > 0) {
            chatMessages = body.messages as Array<Record<string, string>>;
          } else {
            res.end(JSON.stringify({ error: "query or messages required" }));
            return true;
          }

          const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789";
          const gatewayToken = resolveGatewayTokenForInternalCalls({ api, gatewayUrl });

          api.logger.info("[live-assets] baseline: start (skipping all asset hooks)");
          const apiResp = await withInternalGatewayCallBypass(() =>
            fetch(`${gatewayUrl}/v1/chat/completions`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${gatewayToken}`,
                "x-openclaw-agent-id": agentId,
                "x-openclaw-session-key": baselineSessionKey,
              },
              body: JSON.stringify({
                model: `openclaw:${agentId}`,
                messages: chatMessages,
              }),
            }),
          );
          const data = await apiResp.json() as Record<string, unknown>;
          const choices = data.choices as Array<Record<string, unknown>> | undefined;
          const output = (choices?.[0]?.message as Record<string, string>)?.content ?? "";
          const model = String((data as Record<string, unknown>).model ?? "default");

          api.logger.info("[live-assets] baseline: completed");
          res.end(JSON.stringify({ output, model, via: "baseline-openclaw" }));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err) }));
        }
        return true;
      },
    });

    // GET /live-assets/ — serve standalone LiveAssets UI
    const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    api.registerHttpRoute?.({
      path: "/live-assets/",
      auth: "plugin",
      match: "prefix",
      handler: async (req, res) => {
        if (req.method === "OPTIONS") { corsHeaders(res); res.end(); return true; }
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        if (url.pathname === "/live-assets/" || url.pathname === "/live-assets") {
          const html = await readFile(path.join(pluginDir, "ui", "index.html"), "utf-8");
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(html);
          return true;
        }
        return false;
      },
    });

    // POST /live-assets/generate — generate asset from conversation messages (for UI Save as Asset)
    api.registerHttpRoute?.({
      path: "/live-assets/generate",
      auth: "plugin",
      handler: async (req, res) => {
        if (req.method === "OPTIONS") { corsHeaders(res); res.end(); return true; }
        corsHeaders(res);
        if (req.method !== "POST") { res.statusCode = 405; res.end(JSON.stringify({ error: "POST only" })); return true; }

        try {
          const rawBody = await readBody(req);
          const parsed = JSON.parse(rawBody) as Record<string, unknown>;
          const sessionKey = resolveRequestedGenerateSessionKey(parsed.sessionKey);
          const requestAgentId = resolveLiveAssetsAgentId({
            sessionKey,
            agentId: parsed.agentId,
          });
          api.logger.info(
            `[live-assets] generate: agent=${requestAgentId}, sessionKey=${sessionKey ?? "(none)"}, hasSessionKeyField=${"sessionKey" in parsed}, messages=${Array.isArray(parsed.messages) ? parsed.messages.length : 0}, bodyKeys=${Object.keys(parsed).join(",")}`,
          );
          // Always try to read the real transcript (with tool calls) from the
          // OpenClaw session. The webchat UI sends flat {role,content} messages
          // that lose tool call blocks, so the transcript is the only reliable
          // source of tool information.
          let transcriptMessages: GenerateConversationMessage[] | undefined;
          let runtimeMessages: GenerateConversationMessage[] | undefined;
          if (sessionKey) {
            const current = mergeConsecutiveSameRole(runtime.getSessionMessages(sessionKey));
            if (current.length > 0) {
              runtimeMessages = current;
            }
          }
          if (!runtimeMessages && sessionKey) {
            try {
              transcriptMessages = await readOpenClawSessionMessages({ sessionKey });
            } catch {
              api.logger.info(
                `[live-assets] generate: sessionKey=${sessionKey} not found, trying fallback`,
              );
            }
          }
          // Without an explicit sessionKey, trust only the request-body transcript.
          // Reading an arbitrary runtime/session fallback here couples generation
          // to ambient gateway state and breaks reproducibility.
          const effectiveSessionKey =
            sessionKey && (runtimeMessages || transcriptMessages) ? sessionKey : undefined;
          const normalizeInput = {
            ...parsed,
            ...(effectiveSessionKey ? { sessionKey: effectiveSessionKey } : { sessionKey: undefined }),
          };
          const body = normalizeGenerateRequestBody({
            parsed: normalizeInput,
            runtimeMessages,
            transcriptMessages,
          });
          if (runtimeMessages && Array.isArray(body.messages)) {
            const toolMsgCount = (body.messages as GenerateConversationMessage[])
              .filter(m => m.toolCalls?.length).length;
            api.logger.info(
              `[live-assets] generate: using runtime snapshot (${(body.messages as unknown[]).length} msgs, ${toolMsgCount} with tool calls)`,
            );
          } else if (transcriptMessages && Array.isArray(body.messages)) {
            const toolMsgCount = (body.messages as GenerateConversationMessage[])
              .filter(m => m.toolCalls?.length).length;
            api.logger.info(
              `[live-assets] generate: using transcript (${(body.messages as unknown[]).length} msgs, ${toolMsgCount} with tool calls)`,
            );
          } else {
            api.logger.info(
              `[live-assets] generate: no transcript available, using flat messages`,
            );
          }
          await mkdir(assetsDir, { recursive: true });
          const result = await spawnPython(
            "generate.py",
            body,
            buildScopedPythonEnv({ sessionKey, agentId: requestAgentId }),
            api.logger,
            300_000,
          );
          await runtime.reload();
          await syncAssetTools();
          if (typeof result.assetId === "string" && result.assetId.trim()) {
            result.assetPath = assetFilePath(assetsDir, result.assetId);
          }
          res.end(JSON.stringify(result));
        } catch (err) {
          res.statusCode = err instanceof BadRequestError ? 400 : 500;
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
        return true;
      },
    });

    const gatewayUrlRaw = process.env.OPENCLAW_GATEWAY_URL?.trim() ?? "";
    const gatewayUrl = gatewayUrlRaw.replace(/\/+$/, "");
    api.logger.info(`[live-assets] plugin registered, assets dir: ${assetsDir}`);
    api.logger.info(`[live-assets] UI: ${gatewayUrl ? `${gatewayUrl}/live-assets/` : "/live-assets/"}`);
  },
};
