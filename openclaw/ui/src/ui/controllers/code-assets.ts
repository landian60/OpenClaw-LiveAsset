import { clampText } from "../format.ts";
import type { GatewayHelloOk } from "../gateway.ts";
import type { UiSettings } from "../storage.ts";

export type CodeAssetExample = {
  scenario: string;
  output: string;
  correction: string;
  type: "accept" | "correct" | "reject";
  ts: string;
  status: "recorded" | "validated" | "rejected";
  sessionId: string;
  channel: string;
  agentId: string;
};

export type CodeAssetOutputShape = {
  tone: string;
  verbosity: string;
  format: string;
  structure: string;
};

export type CodeAssetControls = {
  replyRules: string[];
  processRules: string[];
  requiredChecks: string[];
  outputShape: CodeAssetOutputShape;
};

export type CodeAssetArtifactVerify = {
  mode: string;
  expected: string;
};

export type CodeAssetArtifact = {
  id: string;
  type: string;
  language: string;
  when: string;
  content: string;
  verify: CodeAssetArtifactVerify;
};

export type CodeAssetEvalCaseResult = {
  pass: boolean | null;
  score: number | null;
  reason: string;
};

export type CodeAssetEvalCase = {
  id: string;
  prompt: string;
  successCriteria: string;
  lastResult: CodeAssetEvalCaseResult;
};

export type CodeAssetScope = {
  users: string[];
  channels: string[];
  agents: string[];
  taskTypes: string[];
};

export type CodeAssetTrigger = {
  keywords: string[];
  regex: string[];
  contextSignals: string[];
};

export type CodeAssetRuntimeStep = {
  id: string;
  label: string;
  description: string;
  toolPatterns: string[];
  mustFollow: string[];
  optional: boolean;
};

export type CodeAssetRuntime = {
  enabled: boolean;
  mode: "advisory" | "enforce";
  conditions: string[];
  sequence: CodeAssetRuntimeStep[];
};

export type CodeAssetAnalysis = {
  lastFeedbackType: string;
  rootCause: string;
  reason: string;
  expandedKeywords: string[];
  updatedAt: string | null;
};

export type CodeAssetEntry = {
  id: string;
  name: string;
  scenarioType: string;
  utility: number;
  examples: number;
  keywords: string[];
  instruction: string;
  scope: CodeAssetScope;
  trigger: CodeAssetTrigger;
  controls: CodeAssetControls;
  runtime: CodeAssetRuntime;
  analysis: CodeAssetAnalysis;
  artifacts: CodeAssetArtifact[];
  evalCases: CodeAssetEvalCase[];
  history: CodeAssetExample[];
  lastUpdated: string | null;
};

const CJK_RE = /[\u4e00-\u9fff]/;

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function firstNonEmptyLine(value: string): string {
  return (
    value
      .split("\n")
      .map((line) => normalizeInlineText(line))
      .find(Boolean) ?? ""
  );
}

function humanizeSegment(segment: string): string {
  if (!segment) {
    return "";
  }
  if (CJK_RE.test(segment)) {
    return segment;
  }
  if (segment.length <= 4 && /^[a-z0-9]+$/i.test(segment)) {
    return segment.toUpperCase();
  }
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

function pickPreferredSummaryCandidate(asset: CodeAssetEntry): string {
  const candidates = [
    ...asset.controls.processRules,
    ...asset.controls.replyRules,
    asset.runtime.enabled && asset.runtime.sequence.length > 0
      ? `Follow runtime sequence: ${asset.runtime.sequence.map((step) => step.label).join(" -> ")}`
      : "",
    firstNonEmptyLine(asset.instruction),
  ]
    .map((item) => normalizeInlineText(item))
    .filter(Boolean);
  const localized = candidates.find((item) => CJK_RE.test(item));
  return localized ?? candidates[0] ?? "";
}

function summarizeScenarioType(value: string): string {
  if (!value.trim()) {
    return "";
  }
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((segment) => humanizeSegment(segment))
    .join(" ");
}

export function formatCodeAssetDisplayName(asset: Pick<CodeAssetEntry, "id" | "name">): string {
  const source = normalizeInlineText(asset.name || asset.id);
  if (!source) {
    return "Asset";
  }
  if (CJK_RE.test(source) && !/[_-]/.test(source)) {
    return source;
  }
  return source
    .split(/[_-]+/)
    .filter(Boolean)
    .map((segment) => humanizeSegment(segment))
    .join(" ");
}

export function formatCodeAssetChangeSummary(asset: CodeAssetEntry, max = 88): string {
  const preferred = pickPreferredSummaryCandidate(asset);
  if (!preferred) {
    const fallback = summarizeScenarioType(asset.scenarioType);
    return fallback ? `Applies ${fallback} behavior` : "Adjusts response behavior for this case";
  }
  const normalized = preferred
    .replace(/^正确做法是/, "")
    .replace(/^When asked to\s+/i, "")
    .replace(/^Ming wants\s+/i, "")
    .replace(/^User defined a rule:\s*/i, "")
    .trim();
  return clampText(normalized, max);
}

function markdownSection(title: string, lines: string[]): string {
  const filtered = lines.map((line) => line.trim()).filter(Boolean);
  if (filtered.length === 0) {
    return "";
  }
  return [`## ${title}`, ...filtered].join("\n");
}

function markdownBulletList(items: string[]): string[] {
  return items
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `- ${item}`);
}

function formatRuntimeMarkdown(runtime: CodeAssetRuntime): string[] {
  const lines: string[] = [
    `- Enabled: ${runtime.enabled ? "yes" : "no"}`,
    `- Mode: ${runtime.mode}`,
    ...markdownBulletList(runtime.conditions.map((item) => `Condition: ${item}`)),
  ];
  for (const [index, step] of runtime.sequence.entries()) {
    lines.push(`- Step ${index + 1}: ${step.label}${step.optional ? " (optional)" : ""}`);
    if (step.description.trim()) {
      lines.push(`  - ${step.description.trim()}`);
    }
    for (const pattern of step.toolPatterns) {
      lines.push(`  - Tool: ${pattern}`);
    }
    for (const dependency of step.mustFollow) {
      lines.push(`  - Must follow: ${dependency}`);
    }
  }
  return lines;
}

export function formatCodeAssetLogicMarkdown(asset: CodeAssetEntry): string {
  const latestHistory = asset.history.slice(0, 3);
  const sections = [
    `# Asset Logic`,
    `**${formatCodeAssetDisplayName(asset)}**`,
    `ID: \`${asset.name}\``,
    markdownSection("What It Changes", [
      `- Summary: ${formatCodeAssetChangeSummary(asset, 200)}`,
      asset.scenarioType ? `- Scene: ${summarizeScenarioType(asset.scenarioType)}` : "",
      asset.runtime.enabled
        ? `- Runtime: ${asset.runtime.mode} mode with ${asset.runtime.sequence.length} step(s)`
        : "",
    ]),
    asset.instruction.trim() ? asset.instruction.trim() : "",
    markdownSection("Trigger", [
      ...markdownBulletList(asset.trigger.keywords.map((item) => `Keyword: ${item}`)),
      ...markdownBulletList(asset.trigger.regex.map((item) => `Regex: ${item}`)),
      ...markdownBulletList(asset.trigger.contextSignals.map((item) => `Context: ${item}`)),
    ]),
    markdownSection("Controls", [
      ...markdownBulletList(asset.controls.replyRules.map((item) => `Reply rule: ${item}`)),
      ...markdownBulletList(asset.controls.processRules.map((item) => `Process rule: ${item}`)),
      ...markdownBulletList(asset.controls.requiredChecks.map((item) => `Required check: ${item}`)),
      ...markdownBulletList(
        [
          asset.controls.outputShape.tone ? `Output tone: ${asset.controls.outputShape.tone}` : "",
          asset.controls.outputShape.verbosity
            ? `Output verbosity: ${asset.controls.outputShape.verbosity}`
            : "",
          asset.controls.outputShape.format
            ? `Output format: ${asset.controls.outputShape.format}`
            : "",
          asset.controls.outputShape.structure
            ? `Output structure: ${asset.controls.outputShape.structure}`
            : "",
        ].filter(Boolean),
      ),
    ]),
    markdownSection("Runtime", formatRuntimeMarkdown(asset.runtime)),
    markdownSection("Latest Analysis", [
      asset.analysis.lastFeedbackType ? `- Feedback type: ${asset.analysis.lastFeedbackType}` : "",
      asset.analysis.rootCause ? `- Root cause: ${asset.analysis.rootCause}` : "",
      asset.analysis.reason ? `- Reason: ${asset.analysis.reason}` : "",
      ...markdownBulletList(
        asset.analysis.expandedKeywords.map((item) => `Expanded keyword: ${item}`),
      ),
    ]),
    markdownSection(
      "Artifacts",
      asset.artifacts.flatMap((artifact) => [
        `- ${artifact.id} · ${artifact.type}${artifact.language ? ` · ${artifact.language}` : ""}`,
        artifact.when.trim() ? `  - When: ${artifact.when.trim()}` : "",
        artifact.verify.mode.trim() ? `  - Verify: ${artifact.verify.mode.trim()}` : "",
        artifact.verify.expected.trim() ? `  - Expected: ${artifact.verify.expected.trim()}` : "",
      ]),
    ),
    markdownSection(
      "Recent Feedback",
      latestHistory.flatMap((entry, index) => [
        `- Record ${index + 1}: ${entry.type} · ${entry.status}`,
        entry.scenario.trim() ? `  - Scenario: ${entry.scenario.trim()}` : "",
        entry.correction.trim() ? `  - Preferred handling: ${entry.correction.trim()}` : "",
        entry.output.trim() ? `  - Observed output: ${entry.output.trim()}` : "",
      ]),
    ),
  ]
    .map((section) => section.trim())
    .filter(Boolean);
  return sections.join("\n\n");
}

export type CodeAssetsState = {
  connected: boolean;
  hello: GatewayHelloOk | null;
  settings: UiSettings;
  password: string;
  codeAssetsLoading: boolean;
  codeAssetsError: string | null;
  codeAssets: CodeAssetEntry[];
  codeAssetsFilter: string;
  codeAssetsSelected: string | null;
  codeAssetsSaving: boolean;
  codeAssetsMutationError: string | null;
  codeAssetsMutationMessage: string | null;
  codeAssetDrafts: Record<string, string>;
  codeAssetPromptDrafts: Record<string, string>;
};

type CodeAssetsApiEntry = {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  scenarioType?: unknown;
  utility?: unknown;
  examples?: unknown;
  keywords?: unknown;
  triggerKeywords?: unknown;
  instruction?: unknown;
  scope?: unknown;
  trigger?: unknown;
  controls?: unknown;
  runtime?: unknown;
  analysis?: unknown;
  artifacts?: unknown;
  evalCases?: unknown;
  history?: unknown;
  updatedAt?: unknown;
};

function getErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  return String(err);
}

function getResponseDetail(payload: Record<string, unknown>): string {
  return [
    normalizeString(payload.reason),
    normalizeString(payload.summary),
    normalizeString(payload.judgeSummary),
    normalizeString(payload.datasetSummary),
  ]
    .filter(Boolean)
    .join(" ");
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

function resolveGatewayHttpAuthHeader(state: CodeAssetsState): string | null {
  const token = state.settings.token.trim();
  if (token) {
    return `Bearer ${token}`;
  }
  const password = state.password.trim();
  if (password) {
    return `Bearer ${password}`;
  }
  const deviceToken = state.hello?.auth?.deviceToken?.trim();
  if (deviceToken) {
    return `Bearer ${deviceToken}`;
  }
  return null;
}

function buildGatewayHttpHeaders(state: CodeAssetsState): Record<string, string> {
  const authorization = resolveGatewayHttpAuthHeader(state);
  return authorization
    ? {
        Accept: "application/json",
        Authorization: authorization,
      }
    : { Accept: "application/json" };
}

function normalizeExample(value: unknown): CodeAssetExample | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const type = record.type;
  const status = record.status;
  return {
    scenario: normalizeString(record.scenario),
    output: normalizeString(record.output),
    correction: normalizeString(record.correction),
    type: type === "accept" || type === "correct" || type === "reject" ? type : "correct",
    ts: normalizeString(record.ts),
    status:
      status === "recorded" || status === "validated" || status === "rejected"
        ? status
        : "recorded",
    sessionId: normalizeString(record.session_id ?? record.sessionId),
    channel: normalizeString(record.channel),
    agentId: normalizeString(record.agent_id ?? record.agentId),
  };
}

function normalizeScope(value: unknown): CodeAssetScope {
  if (!value || typeof value !== "object") {
    return { users: [], channels: [], agents: [], taskTypes: [] };
  }
  const record = value as Record<string, unknown>;
  return {
    users: normalizeStringArray(record.users),
    channels: normalizeStringArray(record.channels),
    agents: normalizeStringArray(record.agents),
    taskTypes: normalizeStringArray(record.task_types ?? record.taskTypes),
  };
}

function normalizeTrigger(value: unknown, fallbackKeywords: string[]): CodeAssetTrigger {
  if (!value || typeof value !== "object") {
    return { keywords: fallbackKeywords, regex: [], contextSignals: [] };
  }
  const record = value as Record<string, unknown>;
  const keywords = normalizeStringArray(record.keywords);
  return {
    keywords: keywords.length > 0 ? keywords : fallbackKeywords,
    regex: normalizeStringArray(record.regex),
    contextSignals: normalizeStringArray(record.context_signals ?? record.contextSignals),
  };
}

function normalizeRuntimeStep(value: unknown, index: number): CodeAssetRuntimeStep | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const label = normalizeString(record.label ?? record.title);
  const patterns = normalizeStringArray(
    record.tool_patterns ?? record.toolPatterns ?? record.tools,
  );
  if (!label && patterns.length === 0) {
    return null;
  }
  return {
    id: normalizeString(record.id) || `step_${index + 1}`,
    label: label || `Step ${index + 1}`,
    description: normalizeString(record.description ?? record.when),
    toolPatterns: patterns,
    mustFollow: normalizeStringArray(record.must_follow ?? record.mustFollow ?? record.requires),
    optional: typeof record.optional === "boolean" ? record.optional : false,
  };
}

function normalizeRuntime(value: unknown): CodeAssetRuntime {
  if (!value || typeof value !== "object") {
    return { enabled: false, mode: "advisory", conditions: [], sequence: [] };
  }
  const record = value as Record<string, unknown>;
  const sequence = Array.isArray(record.sequence)
    ? record.sequence
        .map((entry, index) => normalizeRuntimeStep(entry, index))
        .filter((entry): entry is CodeAssetRuntimeStep => Boolean(entry))
    : [];
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : sequence.length > 0,
    mode: record.mode === "enforce" ? "enforce" : "advisory",
    conditions: normalizeStringArray(record.conditions),
    sequence,
  };
}

function normalizeAnalysis(value: unknown): CodeAssetAnalysis {
  if (!value || typeof value !== "object") {
    return {
      lastFeedbackType: "",
      rootCause: "",
      reason: "",
      expandedKeywords: [],
      updatedAt: null,
    };
  }
  const record = value as Record<string, unknown>;
  return {
    lastFeedbackType: normalizeString(record.last_feedback_type ?? record.lastFeedbackType),
    rootCause: normalizeString(record.root_cause ?? record.rootCause),
    reason: normalizeString(record.reason),
    expandedKeywords: normalizeStringArray(record.expanded_keywords ?? record.expandedKeywords),
    updatedAt: normalizeString(record.updated_at ?? record.updatedAt) || null,
  };
}

function normalizeOutputShape(value: unknown): CodeAssetOutputShape {
  if (!value || typeof value !== "object") {
    return { tone: "", verbosity: "", format: "", structure: "" };
  }
  const record = value as Record<string, unknown>;
  return {
    tone: normalizeString(record.tone),
    verbosity: normalizeString(record.verbosity),
    format: normalizeString(record.format),
    structure: normalizeString(record.structure),
  };
}

function normalizeControls(value: unknown): CodeAssetControls {
  if (!value || typeof value !== "object") {
    return {
      replyRules: [],
      processRules: [],
      requiredChecks: [],
      outputShape: { tone: "", verbosity: "", format: "", structure: "" },
    };
  }
  const record = value as Record<string, unknown>;
  return {
    replyRules: normalizeStringArray(record.reply_rules ?? record.replyRules),
    processRules: normalizeStringArray(record.process_rules ?? record.processRules),
    requiredChecks: normalizeStringArray(record.required_checks ?? record.requiredChecks),
    outputShape: normalizeOutputShape(record.output_shape ?? record.outputShape),
  };
}

function normalizeArtifactVerify(value: unknown): CodeAssetArtifactVerify {
  if (!value || typeof value !== "object") {
    return { mode: "", expected: "" };
  }
  const record = value as Record<string, unknown>;
  return {
    mode: normalizeString(record.mode),
    expected: normalizeString(record.expected),
  };
}

function normalizeArtifact(value: unknown, index: number): CodeAssetArtifact | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const content = normalizeString(record.content);
  const when = normalizeString(record.when);
  if (!content && !when) {
    return null;
  }
  return {
    id: normalizeString(record.id) || `artifact_${index + 1}`,
    type: normalizeString(record.type) || "snippet",
    language: normalizeString(record.language),
    when,
    content,
    verify: normalizeArtifactVerify(record.verify),
  };
}

function normalizeEvalCaseResult(value: unknown): CodeAssetEvalCaseResult {
  if (!value || typeof value !== "object") {
    return { pass: null, score: null, reason: "" };
  }
  const record = value as Record<string, unknown>;
  return {
    pass: typeof record.pass === "boolean" ? record.pass : null,
    score: typeof record.score === "number" ? record.score : null,
    reason: normalizeString(record.reason),
  };
}

function normalizeEvalCase(value: unknown, index: number): CodeAssetEvalCase | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const prompt = normalizeString(record.prompt);
  const successCriteria = normalizeString(record.success_criteria ?? record.successCriteria);
  if (!prompt && !successCriteria) {
    return null;
  }
  return {
    id: normalizeString(record.id) || `eval_case_${index + 1}`,
    prompt,
    successCriteria,
    lastResult: normalizeEvalCaseResult(record.last_result ?? record.lastResult),
  };
}

function normalizeEntry(key: string, value: CodeAssetsApiEntry): CodeAssetEntry {
  const keywordsSource = Array.isArray(value.triggerKeywords)
    ? value.triggerKeywords
    : Array.isArray(value.keywords)
      ? value.keywords
      : [];
  const history = Array.isArray(value.history)
    ? value.history
        .map(normalizeExample)
        .filter((entry): entry is CodeAssetExample => Boolean(entry))
    : [];
  const historySorted = [...history].toSorted((left, right) => {
    const leftTime = Date.parse(left.ts);
    const rightTime = Date.parse(right.ts);
    return (
      (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0)
    );
  });
  const artifacts = Array.isArray(value.artifacts)
    ? value.artifacts
        .map((artifact, index) => normalizeArtifact(artifact, index))
        .filter((artifact): artifact is CodeAssetArtifact => Boolean(artifact))
    : [];
  const evalCases = Array.isArray(value.evalCases)
    ? value.evalCases
        .map((entry, index) => normalizeEvalCase(entry, index))
        .filter((entry): entry is CodeAssetEvalCase => Boolean(entry))
    : [];
  return {
    id: normalizeString(value.id) || key,
    name: normalizeString(value.name) || normalizeString(value.id) || key,
    scenarioType:
      typeof value.scenarioType === "string"
        ? value.scenarioType
        : typeof value.type === "string"
          ? value.type
          : "",
    utility: typeof value.utility === "number" ? value.utility : Number(value.utility ?? 0),
    examples:
      typeof value.examples === "number"
        ? value.examples
        : Array.isArray(value.history)
          ? value.history.length
          : 0,
    keywords: normalizeStringArray(keywordsSource),
    instruction: normalizeString(value.instruction),
    scope: normalizeScope(value.scope),
    trigger: normalizeTrigger(value.trigger, normalizeStringArray(keywordsSource)),
    controls: normalizeControls(value.controls),
    runtime: normalizeRuntime(value.runtime),
    analysis: normalizeAnalysis(value.analysis),
    artifacts,
    evalCases,
    history: historySorted,
    lastUpdated: normalizeString(value.updatedAt) || historySorted[0]?.ts || null,
  };
}

function serializeEntry(entry: CodeAssetEntry): string {
  return JSON.stringify(
    {
      id: entry.id,
      name: entry.name,
      scenario_type: entry.scenarioType,
      utility: entry.utility,
      instruction: entry.instruction,
      scope: {
        users: entry.scope.users,
        channels: entry.scope.channels,
        agents: entry.scope.agents,
        task_types: entry.scope.taskTypes,
      },
      trigger: {
        keywords: entry.trigger.keywords,
        regex: entry.trigger.regex,
        context_signals: entry.trigger.contextSignals,
      },
      controls: {
        reply_rules: entry.controls.replyRules,
        process_rules: entry.controls.processRules,
        required_checks: entry.controls.requiredChecks,
        output_shape: {
          tone: entry.controls.outputShape.tone,
          verbosity: entry.controls.outputShape.verbosity,
          format: entry.controls.outputShape.format,
          structure: entry.controls.outputShape.structure,
        },
      },
      runtime: {
        enabled: entry.runtime.enabled,
        mode: entry.runtime.mode,
        conditions: entry.runtime.conditions,
        sequence: entry.runtime.sequence.map((step) => ({
          id: step.id,
          label: step.label,
          description: step.description,
          tool_patterns: step.toolPatterns,
          must_follow: step.mustFollow,
          optional: step.optional,
        })),
      },
      analysis: {
        last_feedback_type: entry.analysis.lastFeedbackType,
        root_cause: entry.analysis.rootCause,
        reason: entry.analysis.reason,
        expanded_keywords: entry.analysis.expandedKeywords,
        updated_at: entry.analysis.updatedAt,
      },
      artifacts: entry.artifacts,
      eval_cases: entry.evalCases.map((evalCase) => ({
        id: evalCase.id,
        prompt: evalCase.prompt,
        success_criteria: evalCase.successCriteria,
        last_result: {
          pass: evalCase.lastResult.pass,
          score: evalCase.lastResult.score,
          reason: evalCase.lastResult.reason,
        },
      })),
      history: entry.history.map((example) => ({
        scenario: example.scenario,
        output: example.output,
        correction: example.correction,
        type: example.type,
        ts: example.ts,
        status: example.status,
        session_id: example.sessionId,
        channel: example.channel,
        agent_id: example.agentId,
      })),
      updated_at: entry.lastUpdated,
    },
    null,
    2,
  );
}

export async function loadCodeAssets(state: CodeAssetsState) {
  if (!state.connected) {
    return;
  }
  if (state.codeAssetsLoading) {
    return;
  }
  state.codeAssetsLoading = true;
  state.codeAssetsError = null;
  try {
    const response = await fetch("/code-assets/list", {
      method: "GET",
      headers: buildGatewayHttpHeaders(state),
      credentials: "same-origin",
    });
    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).trim();
      } catch {
        detail = "";
      }
      throw new Error(detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`);
    }
    const payload = (await response.json()) as Record<string, CodeAssetsApiEntry>;
    const assets = Object.entries(payload)
      .map(([key, value]) => normalizeEntry(key, value ?? {}))
      .toSorted((left, right) => {
        if (right.utility !== left.utility) {
          return right.utility - left.utility;
        }
        return left.name.localeCompare(right.name);
      });
    const currentPromptDrafts = state.codeAssetPromptDrafts;
    state.codeAssets = assets;
    state.codeAssetDrafts = Object.fromEntries(
      assets.map((entry) => [entry.id, serializeEntry(entry)]),
    );
    state.codeAssetPromptDrafts = Object.fromEntries(
      assets.map((entry) => [entry.id, currentPromptDrafts[entry.id] ?? ""]),
    );
    if (!assets.some((entry) => entry.name === state.codeAssetsSelected)) {
      state.codeAssetsSelected = assets[0]?.name ?? null;
    }
  } catch (err) {
    state.codeAssetsError = getErrorMessage(err);
  } finally {
    state.codeAssetsLoading = false;
  }
}

export function updateCodeAssetDraft(state: CodeAssetsState, assetId: string, value: string) {
  state.codeAssetDrafts = { ...state.codeAssetDrafts, [assetId]: value };
}

export function updateCodeAssetPromptDraft(state: CodeAssetsState, assetId: string, value: string) {
  state.codeAssetPromptDrafts = { ...state.codeAssetPromptDrafts, [assetId]: value };
}

export function createBlankCodeAsset(state: CodeAssetsState) {
  const id = `asset_${Date.now().toString(36)}`;
  const entry: CodeAssetEntry = {
    id,
    name: id,
    scenarioType: "behavioral_guidance",
    utility: 0.5,
    examples: 0,
    keywords: [],
    instruction: "",
    scope: { users: [], channels: [], agents: [], taskTypes: [] },
    trigger: { keywords: [], regex: [], contextSignals: [] },
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
  };
  state.codeAssets = [entry, ...state.codeAssets];
  state.codeAssetsSelected = entry.name;
  state.codeAssetDrafts = { ...state.codeAssetDrafts, [entry.id]: serializeEntry(entry) };
  state.codeAssetPromptDrafts = { ...state.codeAssetPromptDrafts, [entry.id]: "" };
}

export async function saveCodeAsset(state: CodeAssetsState, assetId: string) {
  const draft = state.codeAssetDrafts[assetId];
  if (!draft?.trim()) {
    state.codeAssetsMutationError = "Draft is empty.";
    return;
  }
  state.codeAssetsSaving = true;
  state.codeAssetsMutationError = null;
  state.codeAssetsMutationMessage = null;
  try {
    const payload = JSON.parse(draft) as Record<string, unknown>;
    const response = await fetch("/code-assets/upsert", {
      method: "POST",
      headers: {
        ...buildGatewayHttpHeaders(state),
        "Content-Type": "application/json",
      },
      credentials: "same-origin",
      body: JSON.stringify({ asset: payload }),
    });
    if (!response.ok) {
      const detail = (await response.text()).trim();
      throw new Error(detail || `HTTP ${response.status}`);
    }
    state.codeAssetsMutationMessage = `Saved asset ${assetId}.`;
    await loadCodeAssets(state);
  } catch (err) {
    state.codeAssetsMutationError = getErrorMessage(err);
  } finally {
    state.codeAssetsSaving = false;
  }
}

export async function deleteCodeAsset(state: CodeAssetsState, assetId: string) {
  state.codeAssetsSaving = true;
  state.codeAssetsMutationError = null;
  state.codeAssetsMutationMessage = null;
  try {
    const response = await fetch("/code-assets/delete", {
      method: "POST",
      headers: {
        ...buildGatewayHttpHeaders(state),
        "Content-Type": "application/json",
      },
      credentials: "same-origin",
      body: JSON.stringify({ asset_id: assetId }),
    });
    if (!response.ok) {
      const detail = (await response.text()).trim();
      throw new Error(detail || `HTTP ${response.status}`);
    }
    const nextDrafts = { ...state.codeAssetDrafts };
    delete nextDrafts[assetId];
    state.codeAssetDrafts = nextDrafts;
    const nextPromptDrafts = { ...state.codeAssetPromptDrafts };
    delete nextPromptDrafts[assetId];
    state.codeAssetPromptDrafts = nextPromptDrafts;
    state.codeAssetsMutationMessage = `Deleted asset ${assetId}.`;
    await loadCodeAssets(state);
  } catch (err) {
    state.codeAssetsMutationError = getErrorMessage(err);
  } finally {
    state.codeAssetsSaving = false;
  }
}

async function postCodeAssetAction(
  state: CodeAssetsState,
  path: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      ...buildGatewayHttpHeaders(state),
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

export async function generateCodeAssetUpdate(state: CodeAssetsState, assetId: string) {
  const prompt = state.codeAssetPromptDrafts[assetId]?.trim();
  if (!prompt) {
    state.codeAssetsMutationError = "Prompt is empty.";
    return;
  }
  state.codeAssetsSaving = true;
  state.codeAssetsMutationError = null;
  state.codeAssetsMutationMessage = null;
  try {
    const payload = await postCodeAssetAction(state, "/code-assets/generate-update", {
      asset_id: assetId,
      prompt,
    });
    state.codeAssetsMutationMessage =
      getResponseDetail(payload) || `Generated additive update for ${assetId}.`;
    await loadCodeAssets(state);
  } catch (err) {
    state.codeAssetsMutationError = getErrorMessage(err);
  } finally {
    state.codeAssetsSaving = false;
  }
}

export async function generateCodeAssetEvalSet(state: CodeAssetsState, assetId: string) {
  const prompt = state.codeAssetPromptDrafts[assetId]?.trim() ?? "";
  state.codeAssetsSaving = true;
  state.codeAssetsMutationError = null;
  state.codeAssetsMutationMessage = null;
  try {
    const payload = await postCodeAssetAction(state, "/code-assets/generate-evals", {
      asset_id: assetId,
      prompt,
      count: 4,
    });
    state.codeAssetsMutationMessage =
      getResponseDetail(payload) || `Generated evaluation data for ${assetId}.`;
    await loadCodeAssets(state);
  } catch (err) {
    state.codeAssetsMutationError = getErrorMessage(err);
  } finally {
    state.codeAssetsSaving = false;
  }
}

export async function runCodeAssetEval(state: CodeAssetsState, assetId: string) {
  const prompt = state.codeAssetPromptDrafts[assetId]?.trim() ?? "";
  state.codeAssetsSaving = true;
  state.codeAssetsMutationError = null;
  state.codeAssetsMutationMessage = null;
  try {
    const payload = await postCodeAssetAction(state, "/code-assets/run-eval", {
      asset_id: assetId,
      prompt,
      count: 4,
    });
    const averageScore =
      typeof payload.averageScore === "number" ? ` avg=${payload.averageScore.toFixed(3)}` : "";
    state.codeAssetsMutationMessage =
      `${getResponseDetail(payload) || `Ran judge evaluation for ${assetId}.`}${averageScore}`.trim();
    await loadCodeAssets(state);
  } catch (err) {
    state.codeAssetsMutationError = getErrorMessage(err);
  } finally {
    state.codeAssetsSaving = false;
  }
}
