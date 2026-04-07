import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import type {
  LiveAssetConstraintTrace,
  LiveAssetMatchTrace,
  LiveAssetPanelState,
  LiveAssetRuntimeEvent,
  LiveAssetRuntimeState,
} from "../app-view-state.ts";
import {
  renderMessageGroup,
  renderReadingIndicatorGroup,
  renderStreamingGroup,
} from "../chat/grouped-render.ts";
import { normalizeMessage, normalizeRoleForGrouping } from "../chat/message-normalizer.ts";
import { icons } from "../icons.ts";
import type { LiveAssetUserInputOption } from "../live-asset-messages.ts";
import { detectTextDirection } from "../text-direction.ts";
import type { SessionsListResult } from "../types.ts";
import type { ChatItem, MessageGroup } from "../types/chat-types.ts";
import type { ChatAttachment, ChatQueueItem } from "../ui-types.ts";
import { t } from "../../i18n/index.ts";
import { renderMarkdownSidebar } from "./markdown-sidebar.ts";
import "../components/resizable-divider.ts";

export type CompactionIndicatorStatus = {
  active: boolean;
  startedAt: number | null;
  completedAt: number | null;
};

export type FallbackIndicatorStatus = {
  phase?: "active" | "cleared";
  selected: string;
  active: string;
  previous?: string;
  reason?: string;
  attempts: string[];
  occurredAt: number;
};

export type ChatProps = {
  sessionKey: string;
  onSessionKeyChange: (next: string) => void;
  thinkingLevel: string | null;
  showThinking: boolean;
  loading: boolean;
  sending: boolean;
  canAbort?: boolean;
  compactionStatus?: CompactionIndicatorStatus | null;
  fallbackStatus?: FallbackIndicatorStatus | null;
  messages: unknown[];
  toolMessages: unknown[];
  streamSegments: Array<{ text: string; ts: number }>;
  stream: string | null;
  streamStartedAt: number | null;
  assistantAvatarUrl?: string | null;
  draft: string;
  queue: ChatQueueItem[];
  connected: boolean;
  canSend: boolean;
  disabledReason: string | null;
  error: string | null;
  sessions: SessionsListResult | null;
  // Focus mode
  focusMode: boolean;
  // Sidebar state
  sidebarOpen?: boolean;
  sidebarContent?: string | null;
  sidebarError?: string | null;
  splitRatio?: number;
  assistantName: string;
  assistantAvatar: string | null;
  // Image attachments
  attachments?: ChatAttachment[];
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  // Scroll control
  showNewMessages?: boolean;
  onScrollToBottom?: () => void;
  // Event handlers
  onRefresh: () => void;
  onToggleFocusMode: () => void;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  onAbort?: () => void;
  onQueueRemove: (id: string) => void;
  onNewSession: () => void;
  onOpenSidebar?: (content: string) => void;
  onSaveAsAsset?: () => void;
  onInspectAsset?: () => void;
  liveAssetPanel?: LiveAssetPanelState | null;
  liveAssetSavePromptOpen?: boolean;
  liveAssetUserInputs?: LiveAssetUserInputOption[];
  liveAssetStartUserInputIndex?: number | null;
  liveAssetScopeRuntimeState?: LiveAssetRuntimeState | null;
  onLiveAssetStartUserInputIndexChange?: (next: number) => void;
  onConfirmSaveAsAsset?: () => void;
  onCancelSaveAsAsset?: () => void;
  onCloseLiveAssetPanel?: () => void;
  onRefreshLiveAssetPanel?: () => void;
  onDeleteLiveAsset?: (assetId: string) => void;
  onLiveAssetDraftChange?: (next: string) => void;
  onSaveLiveAssetDraft?: () => void;
  onCloseSidebar?: () => void;
  onSplitRatioChange?: (ratio: number) => void;
  onChatScroll?: (event: Event) => void;
};

const COMPACTION_TOAST_DURATION_MS = 5000;
const FALLBACK_TOAST_DURATION_MS = 8000;

function adjustTextareaHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function renderCompactionIndicator(status: CompactionIndicatorStatus | null | undefined) {
  if (!status) {
    return nothing;
  }

  // Show "compacting..." while active
  if (status.active) {
    return html`
      <div class="compaction-indicator compaction-indicator--active" role="status" aria-live="polite">
        ${icons.loader} Compacting context...
      </div>
    `;
  }

  // Show "compaction complete" briefly after completion
  if (status.completedAt) {
    const elapsed = Date.now() - status.completedAt;
    if (elapsed < COMPACTION_TOAST_DURATION_MS) {
      return html`
        <div class="compaction-indicator compaction-indicator--complete" role="status" aria-live="polite">
          ${icons.check} Context compacted
        </div>
      `;
    }
  }

  return nothing;
}

/** Find augmentation info for a user message by looking up "matched" events. */
function findAugmentationForOption(
  option: LiveAssetUserInputOption,
  events: LiveAssetRuntimeEvent[],
): { originalInput: string; augmentation: string } | null {
  const contentNorm = option.content.replace(/\s+/g, " ").trim();
  for (const event of events) {
    if (event.kind !== "matched") continue;
    if (!event.userInput || !event.inputAugmentation) {
      console.log("[findAug] skipped matched event: userInput=", !!event.userInput, "aug=", !!event.inputAugmentation);
      continue;
    }
    const origNorm = event.userInput.replace(/\s+/g, " ").trim();
    const startsWith = origNorm ? contentNorm.startsWith(origNorm) : false;
    console.log("[findAug] option:", contentNorm.slice(0, 60), "| event.userInput:", origNorm.slice(0, 60), "| startsWith:", startsWith);
    if (startsWith) {
      return { originalInput: event.userInput, augmentation: event.inputAugmentation };
    }
  }
  return null;
}

function truncate(text: string, max: number): string {
  const norm = text.replace(/\s+/g, " ").trim();
  return norm.length <= max ? norm : `${norm.slice(0, max - 3)}...`;
}

function renderOptionPreview(
  option: LiveAssetUserInputOption,
  events: LiveAssetRuntimeEvent[],
) {
  const match = findAugmentationForOption(option, events);
  if (!match) {
    return html`<span class="chat-live-asset-scope__option-text">${option.preview}</span>`;
  }
  const origPreview = truncate(match.originalInput, 100);
  const augPreview = truncate(match.augmentation, 80);
  return html`
    <span class="chat-live-asset-scope__option-text">
      ${origPreview}
      ${augPreview
        ? html`<span class="chat-live-asset-scope__augmented" title="Injected by LiveAsset">${augPreview}</span>`
        : nothing}
    </span>`;
}

function renderLiveAssetScope(props: ChatProps) {
  if (!props.liveAssetSavePromptOpen) {
    return nothing;
  }
  const options = props.liveAssetUserInputs ?? [];
  const startUserInputIndex = props.liveAssetStartUserInputIndex ?? null;
  const onChange = props.onLiveAssetStartUserInputIndexChange;
  const onConfirm = props.onConfirmSaveAsAsset;
  if (!onChange || !onConfirm || options.length === 0) {
    return nothing;
  }
  const saving =
    props.liveAssetPanel?.status === "loading" || props.liveAssetPanel?.savePending === true;
  const selectionValid = options.some((option) => option.userInputIndex === startUserInputIndex);
  const matchedEvents = props.liveAssetScopeRuntimeState?.events ?? [];
  console.log("[LiveAsset Choose] runtimeState:", props.liveAssetScopeRuntimeState ? "loaded" : "null",
    "events:", matchedEvents.length,
    "matched events with augmentation:", matchedEvents.filter(e => e.kind === "matched" && e.inputAugmentation).length,
    "options:", options.map(o => o.content.slice(0, 50)));
  return html`
    <div class="chat-live-asset-scope" role="group" aria-label="Choose where LiveAsset generation starts">
      <div class="chat-live-asset-scope__header">
        <div class="chat-live-asset-scope__title">Choose the first user message to include</div>
        <div class="chat-live-asset-scope__hint">
          This thread has ${options.length} user messages. Generation will keep the conversation starting from the selected message.
        </div>
      </div>
      <div class="chat-live-asset-scope__options" role="radiogroup" aria-label="Start from user input">
        ${options.map(
          (option) => html`
          <label
            class="chat-live-asset-scope__option"
            data-selected=${startUserInputIndex === option.userInputIndex ? "true" : "false"}
          >
            <input
              class="chat-live-asset-scope__radio"
              type="radio"
              name="chat-live-asset-start-user-input"
              .value=${String(option.userInputIndex)}
              .checked=${startUserInputIndex === option.userInputIndex}
              ?disabled=${saving}
              @change=${() => onChange(option.userInputIndex)}
            />
            <span class="chat-live-asset-scope__option-round">Turn ${option.userInputIndex + 1}</span>
            ${renderOptionPreview(option, matchedEvents)}
          </label>
        `,
        )}
      </div>
      <div class="chat-live-asset-scope__actions">
        ${
          props.onCancelSaveAsAsset
            ? html`<button
              class="btn btn-secondary"
              type="button"
              ?disabled=${saving}
              @click=${props.onCancelSaveAsAsset}
            >Cancel</button>`
            : nothing
        }
        <button
          class="btn"
          type="button"
          ?disabled=${saving || !selectionValid}
          @click=${onConfirm}
        >${saving ? "Generating…" : "Generate LiveAssets"}</button>
      </div>
    </div>
  `;
}

function renderTraceKeywordGroup(
  label: string,
  items: Array<{ kw: string; hit: boolean }>,
  mode: "any" | "all" | "not",
) {
  if (items.length === 0) {
    return nothing;
  }
  return html`
    <div class="chat-live-asset-panel__meta-block">
      <span class="chat-live-asset-panel__meta-label">${label}</span>
      <div class="chat-live-asset-panel__chips">
        ${items.map((item) => {
          const stateClass =
            mode === "not" ? (item.hit ? "blocked" : "miss") : item.hit ? "hit" : "miss";
          return html`<span class="chat-live-asset-panel__chip trace-${stateClass}">${item.kw}</span>`;
        })}
      </div>
    </div>
  `;
}

function renderLiveAssetMatchTrace(trace: LiveAssetMatchTrace) {
  return html`
    <div class="chat-live-asset-panel__section">
      <div class="chat-live-asset-panel__section-title">Why Matched</div>
      <div class="chat-live-asset-panel__meta">
        <div class="chat-live-asset-panel__meta-block">
          <span class="chat-live-asset-panel__meta-label">Query</span>
          <code>${trace.query}</code>
        </div>
        ${renderTraceKeywordGroup("ALL", trace.trigger.all, "all")}
        ${renderTraceKeywordGroup("ANY", trace.trigger.any, "any")}
        ${renderTraceKeywordGroup("NOT", trace.trigger.not, "not")}
        ${
          trace.firedInputRules.length > 0
            ? html`<div class="chat-live-asset-panel__meta-block">
                <span class="chat-live-asset-panel__meta-label">Input Rules</span>
                <div class="chat-live-asset-panel__chips">
                  ${trace.firedInputRules.map(
                    (rule) => html`<code class="chat-live-asset-panel__chip">${rule}</code>`,
                  )}
                </div>
              </div>`
            : nothing
        }
        ${
          trace.processConstraints.length > 0
            ? html`<div class="chat-live-asset-panel__meta-block">
                <span class="chat-live-asset-panel__meta-label">Process Control</span>
                <div class="chat-live-asset-panel__chips">
                  ${trace.processConstraints.map((constraint) => {
                    const tone = constraint.action.startsWith("require") ? "require" : "forbid";
                    return html`<span class="chat-live-asset-panel__chip trace-${tone}">${constraint.action}</span>`;
                  })}
                </div>
              </div>`
            : nothing
        }
        ${
          trace.tools.length > 0
            ? html`<div class="chat-live-asset-panel__meta-block">
                <span class="chat-live-asset-panel__meta-label">Tools</span>
                <div class="chat-live-asset-panel__chips">
                  ${trace.tools.map((tool) => html`<code class="chat-live-asset-panel__chip">${tool}</code>`)}
                </div>
              </div>`
            : nothing
        }
        ${
          trace.outputRules.length > 0
            ? html`<div class="chat-live-asset-panel__meta-block">
                <span class="chat-live-asset-panel__meta-label">Output Checks</span>
                <div class="chat-live-asset-panel__chips">
                  ${trace.outputRules.map(
                    (rule) => html`<code class="chat-live-asset-panel__chip">${rule.check}</code>`,
                  )}
                </div>
              </div>`
            : nothing
        }
      </div>
      ${
        trace.inputAugmentation
          ? html`<details class="chat-live-asset-panel__details">
              <summary>Input Augmentation</summary>
              <pre class="chat-live-asset-panel__pre">${trace.inputAugmentation}</pre>
            </details>`
          : nothing
      }
      ${
        trace.processConstraints.length > 0
          ? renderConstraintDetailsSection("Process Rules", trace.processConstraints)
          : nothing
      }
      ${
        trace.outputRules.length > 0
          ? html`<details class="chat-live-asset-panel__details">
              <summary>Output Rewrite</summary>
              ${trace.outputRules.map(
                (rule) => html`
                  <div class="chat-live-asset-panel__meta-block">
                    <span class="chat-live-asset-panel__meta-label">Check</span>
                    <code>${rule.check}</code>
                  </div>
                  <div class="chat-live-asset-panel__meta-block">
                    <span class="chat-live-asset-panel__meta-label">Rewrite</span>
                    <pre class="chat-live-asset-panel__pre">${rule.rewrite}</pre>
                  </div>
                `,
              )}
            </details>`
          : nothing
      }
    </div>
  `;
}

function renderConstraintDetailList(constraints: LiveAssetConstraintTrace[]) {
  return html`
    ${constraints.map(
      (constraint, index) => html`
        <div class="chat-live-asset-panel__meta-block">
          <span class="chat-live-asset-panel__meta-label">Rule ${index + 1}</span>
          <code>${constraint.action}</code>
        </div>
        ${
          constraint.reason
            ? html`<div class="chat-live-asset-panel__meta-block">
                <span class="chat-live-asset-panel__meta-label">Reason</span>
                <pre class="chat-live-asset-panel__pre">${constraint.reason}</pre>
              </div>`
            : nothing
        }
        ${
          constraint.when
            ? html`<div class="chat-live-asset-panel__meta-block">
                <span class="chat-live-asset-panel__meta-label">When</span>
                <pre class="chat-live-asset-panel__pre">${constraint.when}</pre>
              </div>`
            : nothing
        }
        ${
          constraint.whenParams
            ? html`<div class="chat-live-asset-panel__meta-block">
                <span class="chat-live-asset-panel__meta-label">When Params</span>
                <pre class="chat-live-asset-panel__pre">${constraint.whenParams}</pre>
              </div>`
            : nothing
        }
      `,
    )}
  `;
}

function renderConstraintDetailsSection(
  title: string,
  constraints: LiveAssetConstraintTrace[],
  opts: { open?: boolean } = {},
) {
  if (constraints.length === 0) {
    return nothing;
  }
  return html`
    <details class="chat-live-asset-panel__details" ?open=${opts.open === true}>
      <summary>${title}</summary>
      ${renderConstraintDetailList(constraints)}
    </details>
  `;
}

function formatRuntimeEvent(event: LiveAssetRuntimeEvent): string {
  if (event.kind === "matched") {
    return `matched ${event.assetId ?? "LiveAsset"}${event.userInput ? ` for "${event.userInput}"` : ""}`;
  }
  if (event.kind === "tool_blocked") {
    return `blocked ${event.tool ?? "tool"}${event.reason ? `: ${event.reason}` : ""}`;
  }
  if (event.kind === "tool_ok") {
    return `ran ${event.tool ?? "tool"}`;
  }
  if (event.kind === "tool_error") {
    return `${event.tool ?? "tool"} failed${event.message ? `: ${event.message}` : ""}`;
  }
  if (event.kind === "process_requirement_blocked") {
    const missing = event.pendingTools?.length ? `: missing ${event.pendingTools.join(", ")}` : "";
    return `final reply blocked${missing}`;
  }
  if (event.kind === "output_rewrite_started") {
    return `output rewrite started${event.reason ? `: ${event.reason}` : ""}`;
  }
  if (event.kind === "output_rewrite_passed") {
    return "output rewrite passed";
  }
  if (event.kind === "output_rewrite_failed") {
    return `output rewrite failed${event.reason ? `: ${event.reason}` : ""}`;
  }
  return event.kind;
}

function renderRuntimeEventDetails(event: LiveAssetRuntimeEvent) {
  const rewritePrompt = event.rewritePrompt?.trim() ?? "";
  const rewrittenText = event.rewrittenText?.trim() ?? "";
  const constraintDetails = event.constraintDetails ?? [];
  const pendingTools = event.pendingTools ?? [];
  const hasProcessDetails = constraintDetails.length > 0 || pendingTools.length > 0;
  if (!rewritePrompt && !rewrittenText && !hasProcessDetails) {
    return nothing;
  }
  return html`
    <div class="chat-live-asset-panel__event-details">
      ${
        pendingTools.length > 0
          ? html`<div class="chat-live-asset-panel__meta-block">
              <span class="chat-live-asset-panel__meta-label">Missing Tools</span>
              <div class="chat-live-asset-panel__chips">
                ${pendingTools.map((tool) => html`<span class="chat-live-asset-panel__chip trace-require">${tool}</span>`)}
              </div>
            </div>`
          : nothing
      }
      ${
        constraintDetails.length > 0
          ? renderConstraintDetailsSection("Triggered Rules", constraintDetails, {
              open: event.kind === "tool_blocked" || event.kind === "process_requirement_blocked",
            })
          : nothing
      }
      ${
        rewritePrompt
          ? html`<details class="chat-live-asset-panel__details" open>
              <summary>Rewrite Prompt</summary>
              <pre class="chat-live-asset-panel__pre">${rewritePrompt}</pre>
            </details>`
          : nothing
      }
      ${
        rewrittenText
          ? html`<details class="chat-live-asset-panel__details" ?open=${event.kind === "output_rewrite_failed"}>
              <summary>${event.kind === "output_rewrite_failed" ? "Rejected Rewrite Output" : "Rewrite Output"}</summary>
              <pre class="chat-live-asset-panel__pre">${rewrittenText}</pre>
            </details>`
          : nothing
      }
    </div>
  `;
}

function renderRuntimeEvents(runtime: LiveAssetRuntimeState) {
  return html`
    <details class="chat-live-asset-panel__details chat-live-asset-panel__details--runtime" ?open=${runtime.events.length > 0}>
      <summary>Timeline ${runtime.events.length > 0 ? `(${runtime.events.length})` : ""}</summary>
      ${
        runtime.events.length === 0
          ? html`
              <div class="muted">No runtime events recorded for this session.</div>
            `
          : html`<div class="chat-live-asset-panel__event-list">
              ${runtime.events.map(
                (event) => html`
                <div class="chat-live-asset-panel__event">
                  <span class="chat-live-asset-panel__event-time">
                    ${
                      Number.isFinite(event.time)
                        ? new Date(event.time).toLocaleTimeString([], {
                            hour: "numeric",
                            minute: "2-digit",
                            second: "2-digit",
                          })
                        : "--:--:--"
                    }
                  </span>
                  <div class="chat-live-asset-panel__event-body">
                    <span class="chat-live-asset-panel__event-text">${formatRuntimeEvent(event)}</span>
                    ${renderRuntimeEventDetails(event)}
                  </div>
                </div>
              `,
              )}
            </div>`
      }
    </details>
  `;
}

function renderRuntimeLog(runtime: LiveAssetRuntimeState) {
  return html`
    <details class="chat-live-asset-panel__details chat-live-asset-panel__details--runtime">
      <summary>Tool Calls ${runtime.log.length > 0 ? `(${runtime.log.length})` : ""}</summary>
      ${
        runtime.log.length === 0
          ? html`
              <div class="muted">No tool calls were recorded for this session.</div>
            `
          : html`<div class="chat-live-asset-panel__meta-block">
              <div class="chat-live-asset-panel__chips">
                ${runtime.log.map((entry) => {
                  const label = `${entry.ok ? "✓" : "✗"} ${entry.tool}`;
                  const title = Number.isFinite(entry.time)
                    ? `${label} @ ${new Date(entry.time).toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit",
                        second: "2-digit",
                      })}`
                    : label;
                  return html`
                    <span
                      class="chat-live-asset-panel__chip ${entry.ok ? "trace-hit" : "trace-blocked"}"
                      title=${title}
                    >${label}</span>
                  `;
                })}
              </div>
            </div>`
      }
    </details>
  `;
}

export function renderLiveAssetRuntime(runtime: LiveAssetRuntimeState) {
  const updatedAtLabel =
    Number.isFinite(runtime.updatedAt) && runtime.updatedAt > 0
      ? new Date(runtime.updatedAt).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        })
      : null;
  return html`
    <div class="chat-live-asset-panel__section">
      <div class="chat-live-asset-panel__section-title">Runtime Trace</div>
      <div class="chat-live-asset-panel__meta">
        <div class="chat-live-asset-panel__meta-block">
          <span class="chat-live-asset-panel__meta-label">Session</span>
          <code>${runtime.key}</code>
        </div>
        <div class="chat-live-asset-panel__meta-block">
          <span class="chat-live-asset-panel__meta-label">Active LiveAsset</span>
          <code>${runtime.activeAsset ?? "(none)"}</code>
        </div>
        <div class="chat-live-asset-panel__meta-block">
          <span class="chat-live-asset-panel__meta-label">State</span>
          <div class="chat-live-asset-panel__chips">
            <span class="chat-live-asset-panel__chip ${runtime.archived ? "trace-miss" : "trace-hit"}">
              ${runtime.archived ? "captured trace" : "live trace"}
            </span>
            ${
              updatedAtLabel
                ? html`<span class="chat-live-asset-panel__chip">${updatedAtLabel}</span>`
                : nothing
            }
          </div>
        </div>
        ${
          runtime.done.length > 0
            ? html`<div class="chat-live-asset-panel__meta-block">
                <span class="chat-live-asset-panel__meta-label">Done</span>
                <div class="chat-live-asset-panel__chips">
                  ${runtime.done.map((tool) => html`<span class="chat-live-asset-panel__chip trace-hit">${tool}</span>`)}
                </div>
              </div>`
            : nothing
        }
        ${
          runtime.constraints.require.length > 0
            ? html`<div class="chat-live-asset-panel__meta-block">
                <span class="chat-live-asset-panel__meta-label">Require</span>
                <div class="chat-live-asset-panel__chips">
                  ${runtime.constraints.require.map(
                    (tool) =>
                      html`<span class="chat-live-asset-panel__chip trace-require">${tool}</span>`,
                  )}
                </div>
              </div>`
            : nothing
        }
        ${
          runtime.constraints.forbid.length > 0
            ? html`<div class="chat-live-asset-panel__meta-block">
                <span class="chat-live-asset-panel__meta-label">Forbid</span>
                <div class="chat-live-asset-panel__chips">
                  ${runtime.constraints.forbid.map(
                    (tool) =>
                      html`<span class="chat-live-asset-panel__chip trace-forbid">${tool}</span>`,
                  )}
                </div>
              </div>`
            : nothing
        }
      </div>
      ${
        runtime.activeConstraintDetails.length > 0
          ? renderConstraintDetailsSection("Active Process Rules", runtime.activeConstraintDetails)
          : nothing
      }
      ${renderRuntimeLog(runtime)}
      ${renderRuntimeEvents(runtime)}
    </div>
  `;
}

// ─── Structured Asset Editor ────────────────────────────────────────────────

/** Parse draft string and apply a mutation, returning new JSON string. */
function patchDraft(
  draft: string,
  updater: (a: Record<string, unknown>) => void,
): string {
  try {
    const a = JSON.parse(draft) as Record<string, unknown>;
    updater(a);
    return JSON.stringify(a, null, 2);
  } catch {
    return draft;
  }
}

function renderKwGroup(
  label: string,
  kws: string[],
  field: "any" | "all" | "not",
  panel: LiveAssetPanelState,
  props: ChatProps,
  busy: boolean,
) {
  return html`
    <div class="lae-kw-group">
      <span class="lae-kw-mode lae-kw-mode--${field}">${label}</span>
      <div class="lae-kw-chips">
        ${kws.map(
          (kw, i) => html`
            <span class="lae-kw-chip lae-kw-chip--${field}">
              <input
                class="lae-kw-chip-input"
                .value=${kw}
                size=${Math.max(kw.length, 3)}
                ?disabled=${busy}
                @change=${(e: Event) => {
                  const v = (e.currentTarget as HTMLInputElement).value.trim();
                  props.onLiveAssetDraftChange?.(
                    patchDraft(panel.draft, (a) => {
                      const m = a.matching as Record<string, string[]>;
                      if (!Array.isArray(m[field])) m[field] = [];
                      if (v) m[field][i] = v;
                      else m[field].splice(i, 1);
                    }),
                  );
                }}
              /><button
                class="lae-kw-del"
                type="button"
                title="Remove keyword"
                ?disabled=${busy}
                @click=${() =>
                  props.onLiveAssetDraftChange?.(
                    patchDraft(panel.draft, (a) => {
                      (a.matching as Record<string, string[]>)[field].splice(i, 1);
                    }),
                  )}
              >×</button>
            </span>
          `,
        )}
        <button
          class="lae-add-kw"
          type="button"
          ?disabled=${busy}
          @click=${() =>
            props.onLiveAssetDraftChange?.(
              patchDraft(panel.draft, (a) => {
                const m = a.matching as Record<string, unknown>;
                if (!Array.isArray(m[field])) m[field] = [];
                (m[field] as string[]).push("keyword");
              }),
            )}
        >+ keyword</button>
      </div>
    </div>
  `;
}

function renderAssetMatchingEditor(
  asset: Record<string, unknown>,
  panel: LiveAssetPanelState,
  props: ChatProps,
  busy: boolean,
) {
  const m = (asset.matching ?? {}) as Record<string, unknown>;
  const any = Array.isArray(m.any) ? (m.any as string[]) : [];
  const all = Array.isArray(m.all) ? (m.all as string[]) : [];
  const not = Array.isArray(m.not) ? (m.not as string[]) : [];
  const total = any.length + all.length + not.length;
  return html`
    <div class="lae-section">
      <div class="lae-section-head">
        <span class="lae-section-name">Matching</span>
        <span class="lae-section-count">${total} keyword${total !== 1 ? "s" : ""}</span>
      </div>
      ${renderKwGroup("ANY", any, "any", panel, props, busy)}
      ${renderKwGroup("ALL", all, "all", panel, props, busy)}
      ${renderKwGroup("NOT", not, "not", panel, props, busy)}
    </div>
  `;
}

/** Split "contains:foo" / "!contains:foo" / "" into [mode, keyword]. */
function splitCheck(raw: string): [string, string] {
  const s = String(raw ?? "").trim();
  if (!s) return ["always", ""];
  if (s.startsWith("!contains:")) return ["!contains", s.slice(10)];
  if (s.startsWith("contains:")) return ["contains", s.slice(9)];
  return ["contains", s]; // fallback: treat whole string as keyword
}

/** Split "require:tool" / "forbid:tool" into [action, tool]. */
function splitAction(raw: string): [string, string] {
  const s = String(raw ?? "").trim();
  if (s.startsWith("require:")) return ["require", s.slice(8)];
  if (s.startsWith("forbid:")) return ["forbid", s.slice(7)];
  return ["require", s];
}

/** Split "done:X" / "!done:X" / "error:X" / "" into [cond, tool]. */
function splitWhen(raw: string): [string, string] {
  const s = String(raw ?? "").trim();
  if (!s) return ["", ""];
  if (s.startsWith("!done:")) return ["!done", s.slice(6)];
  if (s.startsWith("done:")) return ["done", s.slice(5)];
  if (s.startsWith("error:")) return ["error", s.slice(6)];
  return ["", s]; // unrecognised → treat as always with raw label
}

function renderAssetRulesEditor(
  rules: Record<string, unknown>[],
  title: string,
  checkField: string,
  textField: string,
  textLabel: string,
  sectionKey: string,
  panel: LiveAssetPanelState,
  props: ChatProps,
  busy: boolean,
) {
  /** Write back a composed check string for rule i. */
  const setCheck = (i: number, mode: string, keyword: string) => {
    props.onLiveAssetDraftChange?.(
      patchDraft(panel.draft, (a) => {
        (a[sectionKey] as Record<string, unknown>[])[i][checkField] =
          mode === "always" ? "" : `${mode}:${keyword}`;
      }),
    );
  };

  return html`
    <div class="lae-section">
      <div class="lae-section-head">
        <span class="lae-section-name">${title}</span>
        <span class="lae-section-count">${rules.length} rule${rules.length !== 1 ? "s" : ""}</span>
      </div>
      ${rules.length === 0
        ? html`<div class="lae-empty">No rules added yet.</div>`
        : rules.map((rule, i) => {
            const [mode, keyword] = splitCheck(String(rule[checkField] ?? ""));
            return html`
              <div class="lae-rule-card">
                <div class="lae-rule-field">
                  <label class="lae-rule-label">Check</label>
                  <div class="lae-compound-input">
                    <select
                      class="lae-select"
                      .value=${mode}
                      ?disabled=${busy}
                      @change=${(e: Event) => setCheck(i, (e.currentTarget as HTMLSelectElement).value, keyword)}
                    >
                      <option value="always" ?selected=${mode === "always"}>always</option>
                      <option value="contains" ?selected=${mode === "contains"}>contains</option>
                      <option value="!contains" ?selected=${mode === "!contains"}>NOT contains</option>
                    </select>
                    ${mode !== "always" ? html`<input
                      class="lae-rule-input"
                      .value=${keyword}
                      placeholder="keyword"
                      ?disabled=${busy}
                      @change=${(e: Event) => setCheck(i, mode, (e.currentTarget as HTMLInputElement).value.trim())}
                    />` : nothing}
                  </div>
                </div>
                <div class="lae-rule-field">
                  <label class="lae-rule-label">${textLabel}</label>
                  <textarea
                    class="lae-rule-textarea"
                    .value=${String(rule[textField] ?? "")}
                    ?disabled=${busy}
                    @change=${(e: Event) => {
                      const v = (e.currentTarget as HTMLTextAreaElement).value;
                      props.onLiveAssetDraftChange?.(
                        patchDraft(panel.draft, (a) => {
                          (a[sectionKey] as Record<string, unknown>[])[i][textField] = v;
                        }),
                      );
                    }}
                  ></textarea>
                </div>
                <div class="lae-rule-actions">
                  <button
                    class="lae-del-btn"
                    type="button"
                    ?disabled=${busy}
                    @click=${() =>
                      props.onLiveAssetDraftChange?.(
                        patchDraft(panel.draft, (a) => {
                          (a[sectionKey] as unknown[]).splice(i, 1);
                        }),
                      )}
                  >Delete rule</button>
                </div>
              </div>
            `;
          })}
      <button
        class="lae-add-btn"
        type="button"
        ?disabled=${busy}
        @click=${() =>
          props.onLiveAssetDraftChange?.(
            patchDraft(panel.draft, (a) => {
              if (!Array.isArray(a[sectionKey])) a[sectionKey] = [];
              const r: Record<string, unknown> = {};
              r[checkField] = "contains:";
              r[textField] = "";
              (a[sectionKey] as unknown[]).push(r);
            }),
          )}
      >+ Add rule</button>
    </div>
  `;
}

function renderAssetProcessEditor(
  constraints: Record<string, unknown>[],
  panel: LiveAssetPanelState,
  props: ChatProps,
  busy: boolean,
) {
  const setThen = (i: number, action: string, tool: string) => {
    props.onLiveAssetDraftChange?.(
      patchDraft(panel.draft, (a) => {
        (a.processControl as Record<string, unknown>[])[i].then = `${action}:${tool}`;
      }),
    );
  };
  const setWhen = (i: number, cond: string, tool: string) => {
    props.onLiveAssetDraftChange?.(
      patchDraft(panel.draft, (a) => {
        const row = (a.processControl as Record<string, unknown>[])[i];
        if (!cond) delete row.when;
        else row.when = `${cond}:${tool}`;
      }),
    );
  };

  return html`
    <div class="lae-section">
      <div class="lae-section-head">
        <span class="lae-section-name">Process Control</span>
        <span class="lae-section-count">${constraints.length} constraint${constraints.length !== 1 ? "s" : ""}</span>
      </div>
      ${constraints.length === 0
        ? html`<div class="lae-empty">No tool-order constraints.</div>`
        : constraints.map((c, i) => {
            const [action, actionTool] = splitAction(String(c.then ?? ""));
            const [cond, condTool] = splitWhen(String(c.when ?? ""));
            return html`
              <div class="lae-rule-card">
                <div class="lae-process-summary">
                  <span class="lae-then-badge lae-then-badge--${action}">${c.then || "(no action)"}</span>
                  ${c.when ? html`<span class="lae-when-label">when <code>${c.when}</code></span>` : html`<span class="lae-when-label">always active</span>`}
                </div>
                <div class="lae-rule-field">
                  <label class="lae-rule-label">Action</label>
                  <div class="lae-compound-input">
                    <select
                      class="lae-select"
                      .value=${action}
                      ?disabled=${busy}
                      @change=${(e: Event) => setThen(i, (e.currentTarget as HTMLSelectElement).value, actionTool)}
                    >
                      <option value="require" ?selected=${action === "require"}>require</option>
                      <option value="forbid" ?selected=${action === "forbid"}>forbid</option>
                    </select>
                    <input
                      class="lae-rule-input"
                      .value=${actionTool}
                      placeholder="tool_name"
                      ?disabled=${busy}
                      @change=${(e: Event) => setThen(i, action, (e.currentTarget as HTMLInputElement).value.trim())}
                    />
                  </div>
                </div>
                <div class="lae-rule-field">
                  <label class="lae-rule-label">When</label>
                  <div class="lae-compound-input">
                    <select
                      class="lae-select"
                      .value=${cond}
                      ?disabled=${busy}
                      @change=${(e: Event) => {
                        const v = (e.currentTarget as HTMLSelectElement).value;
                        setWhen(i, v, condTool || "tool_name");
                      }}
                    >
                      <option value="" ?selected=${cond === ""}>always</option>
                      <option value="done" ?selected=${cond === "done"}>done</option>
                      <option value="!done" ?selected=${cond === "!done"}>!done</option>
                      <option value="error" ?selected=${cond === "error"}>error</option>
                    </select>
                    ${cond
                      ? html`<input
                          class="lae-rule-input"
                          .value=${condTool}
                          placeholder="tool_name"
                          ?disabled=${busy}
                          @change=${(e: Event) => setWhen(i, cond, (e.currentTarget as HTMLInputElement).value.trim())}
                        />`
                      : nothing}
                  </div>
                </div>
                <div class="lae-rule-field">
                  <label class="lae-rule-label">Reason</label>
                  <input
                    class="lae-rule-input"
                    .value=${String(c.reason ?? "")}
                    ?disabled=${busy}
                    @change=${(e: Event) => {
                      const v = (e.currentTarget as HTMLInputElement).value;
                      props.onLiveAssetDraftChange?.(
                        patchDraft(panel.draft, (a) => {
                          (a.processControl as Record<string, unknown>[])[i].reason = v;
                        }),
                      );
                    }}
                  />
                </div>
                <div class="lae-rule-actions">
                  <button
                    class="lae-del-btn"
                    type="button"
                    ?disabled=${busy}
                    @click=${() =>
                      props.onLiveAssetDraftChange?.(
                        patchDraft(panel.draft, (a) => {
                          (a.processControl as unknown[]).splice(i, 1);
                        }),
                      )}
                  >Delete</button>
                </div>
              </div>
            `;
          })}
      <button
        class="lae-add-btn"
        type="button"
        ?disabled=${busy}
        @click=${() =>
          props.onLiveAssetDraftChange?.(
            patchDraft(panel.draft, (a) => {
              if (!Array.isArray(a.processControl)) a.processControl = [];
              (a.processControl as unknown[]).push({ then: "require:", reason: "" });
            }),
          )}
      >+ Add constraint</button>
    </div>
  `;
}

function renderAssetToolsEditor(
  tools: Record<string, unknown>[],
  panel: LiveAssetPanelState,
  props: ChatProps,
  busy: boolean,
) {
  return html`
    <div class="lae-section">
      <div class="lae-section-head">
        <span class="lae-section-name">Tools</span>
        <span class="lae-section-count">${tools.length} registered</span>
      </div>
      ${tools.length === 0
        ? html`<div class="lae-empty">No tools registered by this LiveAsset.</div>`
        : tools.map(
            (tool, i) => html`
              <details class="lae-tool-card" open>
                <summary class="lae-tool-summary">
                  <code class="lae-tool-name">${tool.name ?? "(unnamed)"}</code>
                  <span class="lae-tool-desc-preview">${tool.description ?? ""}</span>
                </summary>
                <div class="lae-rule-field">
                  <label class="lae-rule-label">Name</label>
                  <input
                    class="lae-rule-input lae-rule-input--mono"
                    .value=${String(tool.name ?? "")}
                    ?disabled=${busy}
                    @change=${(e: Event) => {
                      const v = (e.currentTarget as HTMLInputElement).value;
                      props.onLiveAssetDraftChange?.(
                        patchDraft(panel.draft, (a) => {
                          (a.tools as Record<string, unknown>[])[i].name = v;
                        }),
                      );
                    }}
                  />
                </div>
                <div class="lae-rule-field">
                  <label class="lae-rule-label">Description</label>
                  <input
                    class="lae-rule-input"
                    .value=${String(tool.description ?? "")}
                    ?disabled=${busy}
                    @change=${(e: Event) => {
                      const v = (e.currentTarget as HTMLInputElement).value;
                      props.onLiveAssetDraftChange?.(
                        patchDraft(panel.draft, (a) => {
                          (a.tools as Record<string, unknown>[])[i].description = v;
                        }),
                      );
                    }}
                  />
                </div>
                <div class="lae-rule-field">
                  <label class="lae-rule-label">Mock Response</label>
                  <textarea
                    class="lae-rule-textarea lae-rule-textarea--mono"
                    .value=${String(tool.mockResponse ?? "")}
                    ?disabled=${busy}
                    @change=${(e: Event) => {
                      const v = (e.currentTarget as HTMLTextAreaElement).value;
                      props.onLiveAssetDraftChange?.(
                        patchDraft(panel.draft, (a) => {
                          (a.tools as Record<string, unknown>[])[i].mockResponse = v;
                        }),
                      );
                    }}
                  ></textarea>
                </div>
                <div class="lae-rule-actions">
                  <button
                    class="lae-del-btn"
                    type="button"
                    ?disabled=${busy}
                    @click=${() =>
                      props.onLiveAssetDraftChange?.(
                        patchDraft(panel.draft, (a) => {
                          (a.tools as unknown[]).splice(i, 1);
                        }),
                      )}
                  >Remove tool</button>
                </div>
              </details>
            `,
          )}
    </div>
  `;
}

function renderStructuredAssetEditor(panel: LiveAssetPanelState, props: ChatProps) {
  const busy = panel.status === "loading" || panel.savePending;
  let asset: Record<string, unknown> | null = null;
  try {
    asset = JSON.parse(panel.draft) as Record<string, unknown>;
  } catch { /* fallback to raw */ }

  const footer = html`
    <div class="lae-footer">
      <span class="lae-dirty">${panel.dirty ? "Unsaved changes" : "Saved"}</span>
      ${props.onSaveLiveAssetDraft
        ? html`<button
            class="btn"
            type="button"
            ?disabled=${busy || !panel.dirty}
            @click=${props.onSaveLiveAssetDraft}
          >${panel.savePending ? "Saving…" : t("assets.saveButton")}</button>`
        : nothing}
    </div>
  `;

  if (!asset) {
    return html`
      <div class="lae-section">
        <div class="lae-section-head">
          <span class="lae-section-name">Raw JSON</span>
          <span class="lae-section-count lae-section-count--warn">Invalid JSON</span>
        </div>
        <textarea
          class="chat-live-asset-panel__editor"
          .value=${panel.draft}
          ?disabled=${busy}
          @input=${(e: Event) =>
            props.onLiveAssetDraftChange?.((e.currentTarget as HTMLTextAreaElement).value)}
        ></textarea>
      </div>
      ${footer}
    `;
  }

  const inputControl = (Array.isArray(asset.inputControl) ? asset.inputControl : []) as Record<string, unknown>[];
  const processControl = (Array.isArray(asset.processControl) ? asset.processControl : []) as Record<string, unknown>[];
  const outputControl = (Array.isArray(asset.outputControl) ? asset.outputControl : []) as Record<string, unknown>[];
  const tools = (Array.isArray(asset.tools) ? asset.tools : []) as Record<string, unknown>[];

  return html`
    ${renderAssetMatchingEditor(asset, panel, props, busy)}
    ${renderAssetRulesEditor(inputControl, "Input Control", "check", "inject", "Inject", "inputControl", panel, props, busy)}
    ${renderAssetProcessEditor(processControl, panel, props, busy)}
    ${renderAssetRulesEditor(outputControl, "Output Control", "check", "rewrite", "Rewrite", "outputControl", panel, props, busy)}
    ${renderAssetToolsEditor(tools, panel, props, busy)}
    <details class="lae-section lae-raw-json">
      <summary class="lae-raw-json-summary">Raw JSON</summary>
      <textarea
        class="chat-live-asset-panel__editor"
        style="min-height:180px;margin-top:8px"
        .value=${panel.draft}
        ?disabled=${busy}
        @input=${(e: Event) =>
          props.onLiveAssetDraftChange?.((e.currentTarget as HTMLTextAreaElement).value)}
      ></textarea>
    </details>
    ${footer}
  `;
}

// ─────────────────────────────────────────────────────────────────────────────

function renderLiveAssetRuntimePlaceholder(assetId: string | null) {
  return html`
    <div class="chat-live-asset-panel__section">
      <div class="chat-live-asset-panel__section-title">Runtime Trace</div>
      <div class="chat-live-asset-panel__meta">
        <div class="chat-live-asset-panel__meta-block">
          <span class="chat-live-asset-panel__meta-label">Active LiveAsset</span>
          <code>${assetId ?? "(unknown)"}</code>
        </div>
        <div class="chat-live-asset-panel__meta-block">
          <span class="chat-live-asset-panel__meta-label">State</span>
          <div class="chat-live-asset-panel__chips">
            <span class="chat-live-asset-panel__chip trace-miss">no trace</span>
          </div>
        </div>
      </div>
      <details class="chat-live-asset-panel__details chat-live-asset-panel__details--runtime">
        <summary>Tool Calls</summary>
        <div class="muted">No tool calls were captured for this session.</div>
      </details>
      <details class="chat-live-asset-panel__details chat-live-asset-panel__details--runtime">
        <summary>Timeline</summary>
        <div class="muted">No runtime events were captured for this session.</div>
      </details>
    </div>
  `;
}

function renderLiveAssetPanel(props: ChatProps) {
  const panel = props.liveAssetPanel;
  if (!panel) {
    return nothing;
  }
  const icon =
    panel.status === "loading" ? icons.loader : panel.status === "error" ? icons.x : icons.check;
  const busy = panel.status === "loading" || panel.savePending;
  const hasDraft = !!panel.draft;

  return html`
    <section class="chat-live-asset-panel chat-live-asset-panel--${panel.status}">
      <div class="chat-live-asset-panel__header">
        <div class="chat-live-asset-panel__summary">
          <span class="chat-live-asset-panel__icon">${icon}</span>
          <div class="chat-live-asset-panel__copy">
            <div class="chat-live-asset-panel__title">
              ${panel.assetId ? `LiveAsset: ${panel.assetId}` : "LiveAsset"}
            </div>
            <div class="chat-live-asset-panel__message">${panel.message}</div>
          </div>
        </div>
        <div class="chat-live-asset-panel__actions">
          ${
            props.onRefreshLiveAssetPanel
              ? html`<button
                  class="btn btn-secondary"
                  type="button"
                  ?disabled=${busy}
                  @click=${props.onRefreshLiveAssetPanel}
                >Reload Trace</button>`
              : nothing
          }
          ${
            props.onDeleteLiveAsset && panel.assetId
              ? html`<button
                  class="btn btn-secondary"
                  type="button"
                  style="color:var(--danger,#dc2626);border-color:var(--danger,#dc2626)"
                  ?disabled=${busy}
                  @click=${() => props.onDeleteLiveAsset!(panel.assetId!)}
                >Delete</button>`
              : nothing
          }
          ${
            props.onCloseLiveAssetPanel
              ? html`<button
                  class="btn btn-secondary"
                  type="button"
                  ?disabled=${busy}
                  @click=${props.onCloseLiveAssetPanel}
                >Close</button>`
              : nothing
          }
        </div>
      </div>

      ${
        panel.assetPath
          ? html`<div class="chat-live-asset-panel__path"><code>${panel.assetPath}</code></div>`
          : nothing
      }

      <!-- CSS radio-button tabs: inputs must precede tabbar and panels as siblings -->
      <input class="lae-tab-radio" type="radio" name="lae-tabs" id="lae-t-asset" ?checked=${hasDraft} />
      <input class="lae-tab-radio" type="radio" name="lae-tabs" id="lae-t-trace" ?checked=${!hasDraft} />
      <input class="lae-tab-radio" type="radio" name="lae-tabs" id="lae-t-runtime" />
      <div class="lae-tabbar">
        ${hasDraft ? html`<label class="lae-tab" for="lae-t-asset">LiveAssets</label>` : nothing}
        <label class="lae-tab" for="lae-t-trace">
          LiveAssets Trace${panel.matchTrace ? "" : html`<span class="lae-tab-dim"> (none)</span>`}
        </label>
        <label class="lae-tab" for="lae-t-runtime">
          Runtime${panel.runtimeState ? "" : html`<span class="lae-tab-dim"> (none)</span>`}
        </label>
      </div>

      ${
        hasDraft
          ? html`<div class="lae-tabpanel lae-tabpanel--asset">${renderStructuredAssetEditor(panel, props)}</div>`
          : nothing
      }
      <div class="lae-tabpanel lae-tabpanel--trace">
        ${
          panel.matchTrace
            ? renderLiveAssetMatchTrace(panel.matchTrace)
            : html`<div class="lae-empty lae-empty--centered">No trace data — interact with LiveAssets to generate a trace.</div>`
        }
      </div>
      <div class="lae-tabpanel lae-tabpanel--runtime">
        ${
          panel.runtimeState
            ? renderLiveAssetRuntime(panel.runtimeState)
            : renderLiveAssetRuntimePlaceholder(panel.assetId)
        }
      </div>
    </section>
  `;
}

function renderFallbackIndicator(status: FallbackIndicatorStatus | null | undefined) {
  if (!status) {
    return nothing;
  }
  const phase = status.phase ?? "active";
  const elapsed = Date.now() - status.occurredAt;
  if (elapsed >= FALLBACK_TOAST_DURATION_MS) {
    return nothing;
  }
  const details = [
    `Selected: ${status.selected}`,
    phase === "cleared" ? `Active: ${status.selected}` : `Active: ${status.active}`,
    phase === "cleared" && status.previous ? `Previous fallback: ${status.previous}` : null,
    status.reason ? `Reason: ${status.reason}` : null,
    status.attempts.length > 0 ? `Attempts: ${status.attempts.slice(0, 3).join(" | ")}` : null,
  ]
    .filter(Boolean)
    .join(" • ");
  const message =
    phase === "cleared"
      ? `Fallback cleared: ${status.selected}`
      : `Fallback active: ${status.active}`;
  const className =
    phase === "cleared"
      ? "compaction-indicator compaction-indicator--fallback-cleared"
      : "compaction-indicator compaction-indicator--fallback";
  const icon = phase === "cleared" ? icons.check : icons.brain;
  return html`
    <div
      class=${className}
      role="status"
      aria-live="polite"
      title=${details}
    >
      ${icon} ${message}
    </div>
  `;
}

function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function handlePaste(e: ClipboardEvent, props: ChatProps) {
  const items = e.clipboardData?.items;
  if (!items || !props.onAttachmentsChange) {
    return;
  }

  const imageItems: DataTransferItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type.startsWith("image/")) {
      imageItems.push(item);
    }
  }

  if (imageItems.length === 0) {
    return;
  }

  e.preventDefault();

  for (const item of imageItems) {
    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const dataUrl = reader.result as string;
      const newAttachment: ChatAttachment = {
        id: generateAttachmentId(),
        dataUrl,
        mimeType: file.type,
      };
      const current = props.attachments ?? [];
      props.onAttachmentsChange?.([...current, newAttachment]);
    });
    reader.readAsDataURL(file);
  }
}

function renderAttachmentPreview(props: ChatProps) {
  const attachments = props.attachments ?? [];
  if (attachments.length === 0) {
    return nothing;
  }

  return html`
    <div class="chat-attachments">
      ${attachments.map(
        (att) => html`
          <div class="chat-attachment">
            <img
              src=${att.dataUrl}
              alt="Attachment preview"
              class="chat-attachment__img"
            />
            <button
              class="chat-attachment__remove"
              type="button"
              aria-label="Remove attachment"
              @click=${() => {
                const next = (props.attachments ?? []).filter((a) => a.id !== att.id);
                props.onAttachmentsChange?.(next);
              }}
            >
              ${icons.x}
            </button>
          </div>
        `,
      )}
    </div>
  `;
}

export function renderChat(props: ChatProps) {
  const canCompose = props.connected;
  const isBusy = props.sending || props.stream !== null;
  const canAbort = Boolean(props.canAbort && props.onAbort);
  const activeSession = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  const reasoningLevel = activeSession?.reasoningLevel ?? "off";
  const showReasoning = props.showThinking && reasoningLevel !== "off";
  const assistantIdentity = {
    name: props.assistantName,
    avatar: props.assistantAvatar ?? props.assistantAvatarUrl ?? null,
  };

  const hasAttachments = (props.attachments?.length ?? 0) > 0;
  const composePlaceholder = props.connected
    ? hasAttachments
      ? "Add a message or paste more images..."
      : "Message (↩ to send, Shift+↩ for line breaks, paste images)"
    : "Connect to the gateway to start chatting…";

  const splitRatio = props.splitRatio ?? 0.6;
  const sidebarOpen = Boolean(props.sidebarOpen && props.onCloseSidebar);
  const thread = html`
    <div
      class="chat-thread"
      role="log"
      aria-live="polite"
      @scroll=${props.onChatScroll}
    >
      ${
        props.loading
          ? html`
              <div class="muted">Loading chat…</div>
            `
          : nothing
      }
      ${repeat(
        buildChatItems(props),
        (item) => item.key,
        (item) => {
          if (item.kind === "divider") {
            return html`
              <div class="chat-divider" role="separator" data-ts=${String(item.timestamp)}>
                <span class="chat-divider__line"></span>
                <span class="chat-divider__label">${item.label}</span>
                <span class="chat-divider__line"></span>
              </div>
            `;
          }

          if (item.kind === "reading-indicator") {
            return renderReadingIndicatorGroup(assistantIdentity);
          }

          if (item.kind === "stream") {
            return renderStreamingGroup(
              item.text,
              item.startedAt,
              props.onOpenSidebar,
              assistantIdentity,
            );
          }

          if (item.kind === "group") {
            return renderMessageGroup(item, {
              onOpenSidebar: props.onOpenSidebar,
              onSaveAsAsset: props.onSaveAsAsset,
              onInspectAsset: props.onInspectAsset,
              showReasoning,
              assistantName: props.assistantName,
              assistantAvatar: assistantIdentity.avatar,
            });
          }

          return nothing;
        },
      )}
    </div>
  `;

  return html`
    <section class="card chat">
      ${props.disabledReason ? html`<div class="callout">${props.disabledReason}</div>` : nothing}

      ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}

      ${
        props.focusMode
          ? html`
            <button
              class="chat-focus-exit"
              type="button"
              @click=${props.onToggleFocusMode}
              aria-label="Exit focus mode"
              title="Exit focus mode"
            >
              ${icons.x}
            </button>
          `
          : nothing
      }

      <div
        class="chat-split-container ${sidebarOpen ? "chat-split-container--open" : ""}"
      >
        <div
          class="chat-main"
          style="flex: ${sidebarOpen ? `0 0 ${splitRatio * 100}%` : "1 1 100%"}"
        >
          ${thread}
        </div>

        ${
          sidebarOpen
            ? html`
              <resizable-divider
                .splitRatio=${splitRatio}
                @resize=${(e: CustomEvent) => props.onSplitRatioChange?.(e.detail.splitRatio)}
              ></resizable-divider>
              <div class="chat-sidebar">
                ${renderMarkdownSidebar({
                  content: props.sidebarContent ?? null,
                  error: props.sidebarError ?? null,
                  onClose: props.onCloseSidebar!,
                  onViewRawText: () => {
                    if (!props.sidebarContent || !props.onOpenSidebar) {
                      return;
                    }
                    props.onOpenSidebar(`\`\`\`\n${props.sidebarContent}\n\`\`\``);
                  },
                })}
              </div>
            `
            : nothing
        }
      </div>

      ${
        props.queue.length
          ? html`
            <div class="chat-queue" role="status" aria-live="polite">
              <div class="chat-queue__title">Queued (${props.queue.length})</div>
              <div class="chat-queue__list">
                ${props.queue.map(
                  (item) => html`
                    <div class="chat-queue__item">
                      <div class="chat-queue__text">
                        ${
                          item.text ||
                          (item.attachments?.length ? `Image (${item.attachments.length})` : "")
                        }
                      </div>
                      <button
                        class="btn chat-queue__remove"
                        type="button"
                        aria-label="Remove queued message"
                        @click=${() => props.onQueueRemove(item.id)}
                      >
                        ${icons.x}
                      </button>
                    </div>
                  `,
                )}
              </div>
            </div>
          `
          : nothing
      }

      ${renderFallbackIndicator(props.fallbackStatus)}
      ${renderCompactionIndicator(props.compactionStatus)}

      ${
        props.showNewMessages
          ? html`
            <button
              class="btn chat-new-messages"
              type="button"
              @click=${props.onScrollToBottom}
            >
              New messages ${icons.arrowDown}
            </button>
          `
          : nothing
      }

      ${renderLiveAssetPanel(props)}

      <div class="chat-compose">
        ${renderLiveAssetScope(props)}
        ${renderAttachmentPreview(props)}
        <div class="chat-compose__row">
          <label class="field chat-compose__field">
            <span>Message</span>
            <textarea
              ${ref((el) => el && adjustTextareaHeight(el as HTMLTextAreaElement))}
              .value=${props.draft}
              dir=${detectTextDirection(props.draft)}
              ?disabled=${!props.connected}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key !== "Enter") {
                  return;
                }
                if (e.isComposing || e.keyCode === 229) {
                  return;
                }
                if (e.shiftKey) {
                  return;
                } // Allow Shift+Enter for line breaks
                if (!props.connected) {
                  return;
                }
                e.preventDefault();
                if (canCompose) {
                  props.onSend();
                }
              }}
              @input=${(e: Event) => {
                const target = e.target as HTMLTextAreaElement;
                adjustTextareaHeight(target);
                props.onDraftChange(target.value);
              }}
              @paste=${(e: ClipboardEvent) => handlePaste(e, props)}
              placeholder=${composePlaceholder}
            ></textarea>
          </label>
          <div class="chat-compose__actions">
            <button
              class="btn"
              ?disabled=${!props.connected || (!canAbort && props.sending)}
              @click=${canAbort ? props.onAbort : props.onNewSession}
            >
              ${canAbort ? "Stop" : "New session"}
            </button>
            <button
              class="btn primary"
              ?disabled=${!props.connected}
              @click=${props.onSend}
            >
              ${isBusy ? "Queue" : "Send"}<kbd class="btn-kbd">↵</kbd>
            </button>
          </div>
        </div>
      </div>
    </section>
  `;
}

const CHAT_HISTORY_RENDER_LIMIT = 200;

function groupMessages(items: ChatItem[]): Array<ChatItem | MessageGroup> {
  const result: Array<ChatItem | MessageGroup> = [];
  let currentGroup: MessageGroup | null = null;

  for (const item of items) {
    if (item.kind !== "message") {
      if (currentGroup) {
        result.push(currentGroup);
        currentGroup = null;
      }
      result.push(item);
      continue;
    }

    const normalized = normalizeMessage(item.message);
    const role = normalizeRoleForGrouping(normalized.role);
    const senderLabel = role.toLowerCase() === "user" ? (normalized.senderLabel ?? null) : null;
    const timestamp = normalized.timestamp || Date.now();

    if (
      !currentGroup ||
      currentGroup.role !== role ||
      (role.toLowerCase() === "user" && currentGroup.senderLabel !== senderLabel)
    ) {
      if (currentGroup) {
        result.push(currentGroup);
      }
      currentGroup = {
        kind: "group",
        key: `group:${role}:${item.key}`,
        role,
        senderLabel,
        messages: [{ message: item.message, key: item.key }],
        timestamp,
        isStreaming: false,
      };
    } else {
      currentGroup.messages.push({ message: item.message, key: item.key });
    }
  }

  if (currentGroup) {
    result.push(currentGroup);
  }
  return result;
}

function buildChatItems(props: ChatProps): Array<ChatItem | MessageGroup> {
  const items: ChatItem[] = [];
  const history = Array.isArray(props.messages) ? props.messages : [];
  const tools = Array.isArray(props.toolMessages) ? props.toolMessages : [];
  const historyStart = Math.max(0, history.length - CHAT_HISTORY_RENDER_LIMIT);
  if (historyStart > 0) {
    items.push({
      kind: "message",
      key: "chat:history:notice",
      message: {
        role: "system",
        content: `Showing last ${CHAT_HISTORY_RENDER_LIMIT} messages (${historyStart} hidden).`,
        timestamp: Date.now(),
      },
    });
  }
  for (let i = historyStart; i < history.length; i++) {
    const msg = history[i];
    const normalized = normalizeMessage(msg);
    const raw = msg as Record<string, unknown>;
    const marker = raw.__openclaw as Record<string, unknown> | undefined;
    if (marker && marker.kind === "compaction") {
      items.push({
        kind: "divider",
        key:
          typeof marker.id === "string"
            ? `divider:compaction:${marker.id}`
            : `divider:compaction:${normalized.timestamp}:${i}`,
        label: "Compaction",
        timestamp: normalized.timestamp ?? Date.now(),
      });
      continue;
    }

    if (!props.showThinking && normalized.role.toLowerCase() === "toolresult") {
      continue;
    }

    items.push({
      kind: "message",
      key: messageKey(msg, i),
      message: msg,
    });
  }
  // Interleave stream segments and tool cards in order. Each segment
  // contains text that was streaming before the corresponding tool started.
  // This ensures correct visual ordering: text → tool → text → tool → ...
  const segments = props.streamSegments ?? [];
  const maxLen = Math.max(segments.length, tools.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < segments.length && segments[i].text.trim().length > 0) {
      items.push({
        kind: "stream" as const,
        key: `stream-seg:${props.sessionKey}:${i}`,
        text: segments[i].text,
        startedAt: segments[i].ts,
      });
    }
    if (i < tools.length) {
      items.push({
        kind: "message",
        key: messageKey(tools[i], i + history.length),
        message: tools[i],
      });
    }
  }

  if (props.stream !== null) {
    const key = `stream:${props.sessionKey}:${props.streamStartedAt ?? "live"}`;
    if (props.stream.trim().length > 0) {
      items.push({
        kind: "stream",
        key,
        text: props.stream,
        startedAt: props.streamStartedAt ?? Date.now(),
      });
    } else {
      items.push({ kind: "reading-indicator", key });
    }
  }

  return groupMessages(items);
}

function messageKey(message: unknown, index: number): string {
  const m = message as Record<string, unknown>;
  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  if (toolCallId) {
    return `tool:${toolCallId}`;
  }
  const id = typeof m.id === "string" ? m.id : "";
  if (id) {
    return `msg:${id}`;
  }
  const messageId = typeof m.messageId === "string" ? m.messageId : "";
  if (messageId) {
    return `msg:${messageId}`;
  }
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  const role = typeof m.role === "string" ? m.role : "unknown";
  if (timestamp != null) {
    return `msg:${role}:${timestamp}:${index}`;
  }
  return `msg:${role}:${index}`;
}
