import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type {
  CodeAssetArtifact,
  CodeAssetAnalysis,
  CodeAssetEntry,
  CodeAssetEvalCase,
  CodeAssetExample,
  CodeAssetRuntime,
} from "../controllers/code-assets.ts";
import { clampText, formatRelativeTimestamp } from "../format.ts";

export type CodeAssetsProps = {
  loading: boolean;
  error: string | null;
  assets: CodeAssetEntry[];
  filter: string;
  selected: string | null;
  onFilterChange: (next: string) => void;
  onSelect: (name: string) => void;
  onRefresh: () => void;
  saving: boolean;
  mutationError: string | null;
  mutationMessage: string | null;
  drafts: Record<string, string>;
  promptDrafts: Record<string, string>;
  onDraftChange: (assetId: string, value: string) => void;
  onPromptChange: (assetId: string, value: string) => void;
  onSave: (assetId: string) => void;
  onDelete: (assetId: string) => void;
  onGenerateUpdate: (assetId: string) => void;
  onGenerateEvalSet: (assetId: string) => void;
  onRunEval: (assetId: string) => void;
  onCreate: () => void;
};

function matchesFilter(asset: CodeAssetEntry, needle: string): boolean {
  if (!needle) {
    return true;
  }
  const haystack = [
    asset.id,
    asset.name,
    asset.scenarioType,
    asset.instruction,
    asset.keywords.join(" "),
    asset.trigger.regex.join(" "),
    asset.trigger.contextSignals.join(" "),
    asset.controls.replyRules.join(" "),
    asset.controls.processRules.join(" "),
    asset.controls.requiredChecks.join(" "),
    asset.artifacts.flatMap((artifact) => [
      artifact.id,
      artifact.type,
      artifact.language,
      artifact.when,
      artifact.content,
      artifact.verify.mode,
      artifact.verify.expected,
    ]),
    asset.evalCases.flatMap((entry) => [
      entry.prompt,
      entry.successCriteria,
      entry.lastResult.reason,
    ]),
    ...asset.history.flatMap((entry) => [
      entry.scenario,
      entry.output,
      entry.correction,
      entry.channel,
      entry.agentId,
      entry.sessionId,
    ]),
  ]
    .flat()
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

function formatScenarioType(value: string): string {
  if (!value.trim()) {
    return t("common.na");
  }
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return t("common.na");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function formatRelative(value: string | null): string {
  if (!value) {
    return t("common.na");
  }
  const timestamp = Date.parse(value);
  return formatRelativeTimestamp(Number.isFinite(timestamp) ? timestamp : null);
}

function utilityTone(utility: number): "chip-ok" | "chip-warn" | "chip-danger" {
  if (utility >= 0.7) {
    return "chip-ok";
  }
  if (utility >= 0.5) {
    return "chip-warn";
  }
  return "chip-danger";
}

function exampleTone(type: CodeAssetExample["type"]): "chip-ok" | "chip-warn" | "chip-danger" {
  if (type === "accept") {
    return "chip-ok";
  }
  if (type === "reject") {
    return "chip-danger";
  }
  return "chip-warn";
}

function exampleLabel(type: CodeAssetExample["type"]): string {
  if (type === "accept") {
    return t("assets.accept");
  }
  if (type === "reject") {
    return t("assets.reject");
  }
  return t("assets.correct");
}

function evalResultTone(
  result: CodeAssetEvalCase["lastResult"],
): "chip-ok" | "chip-warn" | "chip-danger" {
  if (result.pass === true) {
    return "chip-ok";
  }
  if (result.pass === false) {
    return "chip-danger";
  }
  return "chip-warn";
}

function evalResultLabel(result: CodeAssetEvalCase["lastResult"]): string {
  if (result.pass === true) {
    return t("assets.evalPassed");
  }
  if (result.pass === false) {
    return t("assets.evalFailed");
  }
  return t("assets.evalPending");
}

function statusLabel(status: CodeAssetExample["status"]): string {
  if (status === "validated") {
    return t("assets.validated");
  }
  if (status === "rejected") {
    return t("assets.rejectedStatus");
  }
  return t("assets.recorded");
}

function renderTokenList(items: string[]) {
  return items.length > 0
    ? items.map((item) => html`<span class="asset-keyword">${item}</span>`)
    : html`<span class="muted">${t("common.na")}</span>`;
}

export function renderCodeAssets(props: CodeAssetsProps) {
  const filter = props.filter.trim().toLowerCase();
  const filtered = filter
    ? props.assets.filter((asset) => matchesFilter(asset, filter))
    : props.assets;
  const selected =
    filtered.find((asset) => asset.name === props.selected) ??
    props.assets.find((asset) => asset.name === props.selected) ??
    filtered[0] ??
    null;
  const totalExamples = props.assets.reduce((sum, asset) => sum + asset.examples, 0);
  const averageUtility =
    props.assets.length > 0
      ? (props.assets.reduce((sum, asset) => sum + asset.utility, 0) / props.assets.length).toFixed(
          3,
        )
      : t("common.na");

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
        <div>
          <div class="card-title">${t("assets.title")}</div>
          <div class="card-sub">${t("assets.subtitle")}</div>
        </div>
        <div class="row" style="gap: 8px; align-items: center;">
          <button class="btn" ?disabled=${props.saving} @click=${props.onCreate}>
            ${t("assets.newButton")}
          </button>
          <button class="btn" ?disabled=${props.loading || props.saving} @click=${props.onRefresh}>
            ${props.loading ? "Loading…" : t("common.refresh")}
          </button>
        </div>
      </div>

      <div class="asset-summary-grid" style="margin-top: 14px;">
        <div class="stat">
          <div class="stat-label">${t("assets.summary.assets")}</div>
          <div class="stat-value">${props.assets.length}</div>
        </div>
        <div class="stat">
          <div class="stat-label">${t("assets.summary.examples")}</div>
          <div class="stat-value">${totalExamples}</div>
        </div>
        <div class="stat">
          <div class="stat-label">${t("assets.summary.utility")}</div>
          <div class="stat-value">${averageUtility}</div>
        </div>
      </div>

      <div class="filters" style="margin-top: 14px;">
        <label class="field" style="flex: 1;">
          <span>${t("assets.filter")}</span>
          <input
            .value=${props.filter}
            @input=${(event: Event) =>
              props.onFilterChange((event.target as HTMLInputElement).value)}
            placeholder=${t("assets.filterPlaceholder")}
          />
        </label>
        <div class="muted">
          ${t("assets.shown", {
            shown: String(filtered.length),
            total: String(props.assets.length),
          })}
        </div>
      </div>

      ${
        props.error
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
          : nothing
      }
      ${
        props.mutationError
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.mutationError}</div>`
          : nothing
      }
      ${
        props.mutationMessage
          ? html`<div class="callout info" style="margin-top: 12px;">${props.mutationMessage}</div>`
          : nothing
      }
      ${
        props.assets.length === 0
          ? html`<div class="callout info" style="margin-top: 12px;">${t("assets.empty")}</div>`
          : nothing
      }
      ${
        props.assets.length > 0 && filtered.length === 0
          ? html`<div class="callout info" style="margin-top: 12px;">${t("assets.noMatches")}</div>`
          : nothing
      }
    </section>

    <section class="assets-layout">
      <section class="card">
        <div class="card-title">${t("assets.catalog")}</div>
        <div class="card-sub">${t("assets.catalogSubtitle")}</div>

        <div class="list" style="margin-top: 14px;">
          ${filtered.map((asset) =>
            renderAssetListItem(asset, asset.name === selected?.name, props),
          )}
        </div>
      </section>

      <section class="card">
        ${
          selected
            ? renderAssetDetail(
                selected,
                props.drafts[selected.id] ?? "",
                props.promptDrafts[selected.id] ?? "",
                props,
              )
            : html`
                <div class="card-title">${t("assets.detail")}</div>
                <div class="card-sub">${t("assets.emptyDetail")}</div>
              `
        }
      </section>
    </section>
  `;
}

function renderAssetListItem(asset: CodeAssetEntry, selected: boolean, props: CodeAssetsProps) {
  return html`
    <button
      type="button"
      class="list-item list-item-clickable asset-list-item ${selected ? "list-item-selected" : ""}"
      @click=${() => props.onSelect(asset.name)}
    >
      <div class="list-main">
        <div class="row" style="justify-content: space-between; gap: 8px; align-items: flex-start;">
          <div class="list-title mono">${asset.name}</div>
          <span class="chip ${utilityTone(asset.utility)}"
            >${t("assets.utilityLabel", { value: asset.utility.toFixed(3) })}</span
          >
        </div>
        <div class="list-sub">${clampText(asset.instruction, 180)}</div>
        <div class="chip-row" style="margin-top: 6px;">
          <span class="chip">${formatScenarioType(asset.scenarioType)}</span>
          <span class="chip">${t("assets.examplesLabel", { count: String(asset.examples) })}</span>
          <span class="chip">${t("assets.artifactsLabel", { count: String(asset.artifacts.length) })}</span>
          <span class="chip">${t("assets.evalCasesLabel", { count: String(asset.evalCases.length) })}</span>
        </div>
        <div class="asset-keywords" style="margin-top: 8px;">
          ${asset.keywords.map((keyword) => html`<span class="asset-keyword">${keyword}</span>`)}
        </div>
      </div>
      <div class="list-meta asset-list-meta">
        <div>${t("assets.lastUpdated")}</div>
        <div class="mono">${formatRelative(asset.lastUpdated)}</div>
        <div>${formatTimestamp(asset.lastUpdated)}</div>
      </div>
    </button>
  `;
}

function renderAssetDetail(
  asset: CodeAssetEntry,
  draft: string,
  promptDraft: string,
  props: CodeAssetsProps,
) {
  return html`
    <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
      <div>
        <div class="card-title">${asset.name}</div>
        <div class="card-sub">${formatScenarioType(asset.scenarioType)}</div>
      </div>
      <div class="chip-row" style="justify-content: flex-end;">
        <span class="chip ${utilityTone(asset.utility)}"
          >${t("assets.utilityLabel", { value: asset.utility.toFixed(3) })}</span
        >
        <span class="chip">${t("assets.examplesLabel", { count: String(asset.examples) })}</span>
      </div>
    </div>

    <div class="asset-detail-grid" style="margin-top: 16px;">
      <section class="asset-panel">
        <div class="asset-panel__title">${t("assets.instruction")}</div>
        <pre class="asset-text">${asset.instruction || t("common.na")}</pre>
      </section>

      <section class="asset-panel">
        <div class="asset-panel__title">${t("assets.trigger")}</div>
        <div class="asset-keywords">${renderTokenList(asset.trigger.keywords)}</div>
        <div style="display: grid; gap: 10px; margin-top: 12px;">
          <div>
            <div class="asset-panel__title">${t("assets.regex")}</div>
            <div class="asset-keywords">${renderTokenList(asset.trigger.regex)}</div>
          </div>
          <div>
            <div class="asset-panel__title">${t("assets.contextSignals")}</div>
            <div class="asset-keywords">${renderTokenList(asset.trigger.contextSignals)}</div>
          </div>
        </div>
      </section>

      <section class="asset-panel">
        <div class="asset-panel__title">${t("assets.controls")}</div>
        <div style="display: grid; gap: 12px;">
          ${renderStringSection(t("assets.replyRules"), asset.controls.replyRules)}
          ${renderStringSection(t("assets.processRules"), asset.controls.processRules)}
          ${renderStringSection(t("assets.requiredChecks"), asset.controls.requiredChecks)}
          ${renderOutputShape(asset)}
        </div>
      </section>

      <section class="asset-panel">
        <div class="asset-panel__title">Runtime Policy</div>
        ${renderRuntime(asset.runtime)}
      </section>

      <section class="asset-panel">
        <div class="asset-panel__title">${t("assets.scope")}</div>
        <div style="display: grid; gap: 12px;">
          ${renderStringSection(t("assets.scopeUsers"), asset.scope.users)}
          ${renderStringSection(t("assets.scopeChannels"), asset.scope.channels)}
          ${renderStringSection(t("assets.scopeAgents"), asset.scope.agents)}
          ${renderStringSection(t("assets.scopeTaskTypes"), asset.scope.taskTypes)}
        </div>
        <div class="muted" style="margin-top: 12px;">
          ${t("assets.lastUpdated")}: ${formatTimestamp(asset.lastUpdated)}
        </div>
      </section>
    </div>

    <div style="margin-top: 18px;">
      <div class="card-title">Latest Analysis</div>
      <div class="card-sub">Last classified feedback and expanded trigger coverage</div>
    </div>

    <section class="asset-panel" style="margin-top: 14px;">
      ${renderAnalysis(asset.analysis)}
    </section>

    <div style="margin-top: 18px;">
      <div class="card-title">${t("assets.artifacts")}</div>
      <div class="card-sub">${t("assets.artifactsSubtitle")}</div>
    </div>

    <div class="asset-examples" style="margin-top: 14px;">
      ${
        asset.artifacts.length > 0
          ? asset.artifacts.map((artifact) => renderArtifact(artifact))
          : html`<div class="callout info">${t("assets.emptyArtifacts")}</div>`
      }
    </div>

    <div style="margin-top: 18px;">
      <div class="card-title">${t("assets.evalCases")}</div>
      <div class="card-sub">${t("assets.evalCasesSubtitle")}</div>
    </div>

    <div class="asset-examples" style="margin-top: 14px;">
      ${
        asset.evalCases.length > 0
          ? asset.evalCases.map((entry) => renderEvalCase(entry))
          : html`<div class="callout info">${t("assets.emptyEvalCases")}</div>`
      }
    </div>

    <div style="margin-top: 18px;">
      <div class="card-title">${t("assets.feedbackHistory")}</div>
      <div class="card-sub">${t("assets.feedbackSubtitle")}</div>
    </div>

    <div class="asset-examples" style="margin-top: 14px;">
      ${
        asset.history.length > 0
          ? asset.history.map((example) => renderExample(example))
          : html`<div class="callout info">${t("assets.emptyHistory")}</div>`
      }
    </div>

    <div style="margin-top: 18px;">
      <div class="card-title">Prompt-driven Update</div>
      <div class="card-sub">Use an LLM prompt to add rules, generate eval data, or run the judge metric.</div>
    </div>

    <section class="asset-panel" style="margin-top: 14px;">
      <textarea
        style="width: 100%; min-height: 160px; font-family: var(--font-mono, monospace);"
        .value=${promptDraft}
        @input=${(event: Event) =>
          props.onPromptChange(asset.id, (event.target as HTMLTextAreaElement).value)}
        placeholder="Describe the rule/update you want to add, or provide the focus for evaluation data."
      ></textarea>
      <div class="row" style="justify-content: flex-end; gap: 8px; margin-top: 12px; flex-wrap: wrap;">
        <button class="btn" ?disabled=${props.saving} @click=${() => props.onGenerateEvalSet(asset.id)}>
          Generate Eval Set
        </button>
        <button class="btn" ?disabled=${props.saving} @click=${() => props.onRunEval(asset.id)}>
          Run Judge
        </button>
        <button class="btn primary" ?disabled=${props.saving} @click=${() => props.onGenerateUpdate(asset.id)}>
          ${props.saving ? "Running…" : "Generate Update"}
        </button>
      </div>
    </section>

    <div style="margin-top: 18px;">
      <div class="card-title">${t("assets.editorTitle")}</div>
      <div class="card-sub">${t("assets.editorSubtitle")}</div>
    </div>

    <section class="asset-panel" style="margin-top: 14px;">
      <textarea
        style="width: 100%; min-height: 360px; font-family: var(--font-mono, monospace);"
        .value=${draft}
        @input=${(event: Event) =>
          props.onDraftChange(asset.id, (event.target as HTMLTextAreaElement).value)}
      ></textarea>
      <div class="row" style="justify-content: flex-end; gap: 8px; margin-top: 12px;">
        <button class="btn danger" ?disabled=${props.saving} @click=${() => props.onDelete(asset.id)}>
          Delete
        </button>
        <button class="btn primary" ?disabled=${props.saving} @click=${() => props.onSave(asset.id)}>
          ${props.saving ? "Saving…" : t("assets.saveButton")}
        </button>
      </div>
    </section>
  `;
}

function renderStringSection(title: string, items: string[]) {
  return html`
    <div>
      <div class="asset-panel__title">${title}</div>
      <div class="asset-keywords">${renderTokenList(items)}</div>
    </div>
  `;
}

function renderOutputShape(asset: CodeAssetEntry) {
  const shape = asset.controls.outputShape;
  const lines = [
    shape.tone ? `tone: ${shape.tone}` : "",
    shape.verbosity ? `verbosity: ${shape.verbosity}` : "",
    shape.format ? `format: ${shape.format}` : "",
    shape.structure ? `structure: ${shape.structure}` : "",
  ].filter(Boolean);
  return renderStringSection(t("assets.outputShape"), lines);
}

function renderRuntime(runtime: CodeAssetRuntime) {
  if (!runtime.enabled && runtime.sequence.length === 0) {
    return html`<div class="muted">${t("common.na")}</div>`;
  }
  return html`
    <div style="display: grid; gap: 12px;">
      <div class="chip-row">
        <span class="chip">${runtime.enabled ? "enabled" : "disabled"}</span>
        <span class="chip">${runtime.mode}</span>
      </div>
      ${renderStringSection("Conditions", runtime.conditions)}
      <div>
        <div class="asset-panel__title">Sequence</div>
        ${
          runtime.sequence.length > 0
            ? html`
                <div style="display: grid; gap: 10px;">
                  ${runtime.sequence.map(
                    (step, index) => html`
                      <section class="asset-panel asset-panel--accent">
                        <div class="row" style="justify-content: space-between; gap: 8px;">
                          <div class="asset-panel__title">${index + 1}. ${step.label}</div>
                          <span class="chip">${step.optional ? "optional" : "required"}</span>
                        </div>
                        <pre class="asset-text">${step.description || t("common.na")}</pre>
                        <div class="asset-keywords" style="margin-top: 10px;">
                          ${renderTokenList(step.toolPatterns)}
                        </div>
                        ${
                          step.mustFollow.length > 0
                            ? html`
                                <div class="asset-panel__title" style="margin-top: 10px;">Must Follow</div>
                                <div class="asset-keywords">${renderTokenList(step.mustFollow)}</div>
                              `
                            : nothing
                        }
                      </section>
                    `,
                  )}
                </div>
              `
            : html`<div class="muted">${t("common.na")}</div>`
        }
      </div>
    </div>
  `;
}

function renderAnalysis(analysis: CodeAssetAnalysis) {
  const lines = [
    analysis.lastFeedbackType ? `feedback_type: ${analysis.lastFeedbackType}` : "",
    analysis.rootCause ? `root_cause: ${analysis.rootCause}` : "",
    analysis.updatedAt ? `updated_at: ${formatTimestamp(analysis.updatedAt)}` : "",
  ].filter(Boolean);
  return html`
    <div style="display: grid; gap: 12px;">
      ${renderStringSection("Summary", lines)}
      <div>
        <div class="asset-panel__title">Reason</div>
        <pre class="asset-text">${analysis.reason || t("common.na")}</pre>
      </div>
      ${renderStringSection("Expanded Keywords", analysis.expandedKeywords)}
    </div>
  `;
}

function renderArtifact(artifact: CodeAssetArtifact) {
  return html`
    <article class="asset-example">
      <div class="row" style="justify-content: space-between; gap: 8px; align-items: center;">
        <div class="chip-row">
          <span class="chip">${artifact.type || t("common.na")}</span>
          <span class="chip">${artifact.language || t("common.na")}</span>
        </div>
        <div class="mono muted">${artifact.id}</div>
      </div>

      <div class="asset-example-grid">
        <section class="asset-panel">
          <div class="asset-panel__title">${t("assets.artifactWhen")}</div>
          <pre class="asset-text">${artifact.when || t("common.na")}</pre>
        </section>

        <section class="asset-panel">
          <div class="asset-panel__title">${t("assets.artifactContent")}</div>
          <pre class="asset-text">${artifact.content || t("common.na")}</pre>
        </section>

        <section class="asset-panel asset-panel--accent">
          <div class="asset-panel__title">${t("assets.artifactVerify")}</div>
          <pre class="asset-text">${artifact.verify.mode || t("common.na")}${artifact.verify.expected ? `\n${artifact.verify.expected}` : ""}</pre>
        </section>
      </div>
    </article>
  `;
}

function renderEvalCase(entry: CodeAssetEvalCase) {
  return html`
    <article class="asset-example">
      <div class="row" style="justify-content: space-between; gap: 8px; align-items: center;">
        <div class="chip-row">
          <span class="chip ${evalResultTone(entry.lastResult)}">${evalResultLabel(entry.lastResult)}</span>
          ${
            entry.lastResult.score !== null
              ? html`<span class="chip">${t("assets.evalScore", { value: String(entry.lastResult.score) })}</span>`
              : nothing
          }
        </div>
        <div class="mono muted">${entry.id}</div>
      </div>

      <div class="asset-example-grid">
        <section class="asset-panel">
          <div class="asset-panel__title">${t("assets.evalPrompt")}</div>
          <pre class="asset-text">${entry.prompt || t("common.na")}</pre>
        </section>

        <section class="asset-panel">
          <div class="asset-panel__title">${t("assets.successCriteria")}</div>
          <pre class="asset-text">${entry.successCriteria || t("common.na")}</pre>
        </section>

        <section class="asset-panel asset-panel--accent">
          <div class="asset-panel__title">${t("assets.evalReason")}</div>
          <pre class="asset-text">${entry.lastResult.reason || t("common.na")}</pre>
        </section>
      </div>
    </article>
  `;
}

function renderExample(example: CodeAssetExample) {
  return html`
    <article class="asset-example">
      <div class="row" style="justify-content: space-between; gap: 8px; align-items: center;">
        <div class="chip-row">
          <span class="chip ${exampleTone(example.type)}">${exampleLabel(example.type)}</span>
          <span class="chip">${statusLabel(example.status)}</span>
          <span class="chip">${formatRelative(example.ts)}</span>
        </div>
        <div class="muted">${formatTimestamp(example.ts)}</div>
      </div>

      <div class="asset-example-grid">
        <section class="asset-panel">
          <div class="asset-panel__title">${t("assets.scenario")}</div>
          <pre class="asset-text">${example.scenario || t("common.na")}</pre>
        </section>

        <section class="asset-panel">
          <div class="asset-panel__title">${t("assets.observedOutput")}</div>
          ${
            example.output.trim()
              ? html`<pre class="asset-text">${example.output}</pre>`
              : html`<div class="muted">${t("assets.noObservedOutput")}</div>`
          }
        </section>

        <section class="asset-panel asset-panel--accent">
          <div class="asset-panel__title">${t("assets.preferredHandling")}</div>
          <pre class="asset-text">${example.correction || t("common.na")}</pre>
        </section>
      </div>

      ${
        example.sessionId || example.channel || example.agentId
          ? html`
              <div class="chip-row" style="margin-top: 12px;">
                ${example.sessionId ? html`<span class="chip">${t("assets.session")}: ${example.sessionId}</span>` : nothing}
                ${example.channel ? html`<span class="chip">${t("assets.channel")}: ${example.channel}</span>` : nothing}
                ${example.agentId ? html`<span class="chip">${t("assets.agent")}: ${example.agentId}</span>` : nothing}
              </div>
            `
          : nothing
      }
    </article>
  `;
}
