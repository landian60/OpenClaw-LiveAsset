/**
 * system.ts — core LiveAssets logic
 * Ported from an earlier LiveAssets prototype and extended with input augmentation rendering
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// ===== Types =====

/** Recursive condition expression */
export type CondExpr =
  | string                    // Atomic: "done:X", "!done:X", "error:X", "isError"
  | { AND: CondExpr[] }
  | { OR: CondExpr[] }
  | { NOT: CondExpr };

/** Tool dependency constraint (evaluated during runtime loop) */
export type Constraint = {
  when?: CondExpr;               // omitted = always active
  then: string;                  // "require:X" | "forbid:X"
  reason?: string;
  utilityScore?: number;
};

export type ExampleMessage = { role: string; content: string };

export type InputRule = {
  check: string;      // contains:kw or !contains:kw
  inject: string;
  example?: ExampleMessage[];
};

export type OutputRule = {
  check: string;      // contains:kw or !contains:kw
  rewrite: string;
  utilityScore?: number;
};

/** Scene tool definitions (stored in asset, registered dynamically by plugin) */
export type AssetTool = {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  mockResponse: string;   // mock response for testing
};

export type LiveAsset = {
  assetId: string;
  scenarioId?: string;
  matching: {
    any?: string[];
    all?: string[];
    not?: string[];
  };
  inputControl?: InputRule[];
  processControl?: Constraint[];
  outputControl?: OutputRule[];
  tools?: AssetTool[];    // scene-specific tool definitions
  version?: number;
  utilityScore?: number;  // 0-100, Match Agent's evaluation of match quality
};

export type ConstraintResult = {
  require: string[];
  forbid: string[];
};

export type ActiveConstraint = {
  kind: "require" | "forbid";
  tool: string;
  reason?: string;
  when?: CondExpr;
};

// ===== 1. Matching =====

export function matchAsset(asset: LiveAsset, text: string): boolean {
  const m = asset.matching;
  const lower = text.toLowerCase();

  if (m.any && m.any.length > 0) {
    if (!m.any.some(k => lower.includes(k.toLowerCase()))) return false;
  }
  if (m.all && m.all.length > 0) {
    if (!m.all.every(k => lower.includes(k.toLowerCase()))) return false;
  }
  if (m.not && m.not.length > 0) {
    if (m.not.some(k => lower.includes(k.toLowerCase()))) return false;
  }
  return true;
}

/** Fallback scoring for legacy assets without utilityScore */
function matchScoreFallback(asset: LiveAsset, text: string): number {
  const m = asset.matching;
  const lower = text.toLowerCase();
  let score = 0;
  const anyHits = (m.any ?? []).filter(k => lower.includes(k.toLowerCase())).length;
  const allHits = (m.all ?? []).filter(k => lower.includes(k.toLowerCase())).length;
  score += anyHits;
  score += allHits * 10;
  return score;
}

export function findMatchingAsset(assets: LiveAsset[], text: string): LiveAsset | undefined {
  const candidates = assets.filter(a => matchAsset(a, text));
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  candidates.sort((a, b) => {
    const scoreA = a.utilityScore ?? matchScoreFallback(a, text);
    const scoreB = b.utilityScore ?? matchScoreFallback(b, text);
    return scoreB - scoreA;
  });
  return candidates[0];
}

// ===== 2. Input Control =====

type ParsedCheck = { kind: "contains" | "not_contains"; keyword: string };

export function parseCheck(chk: string): ParsedCheck | undefined {
  const normalized = chk.trim();
  if (normalized.startsWith("!contains:")) {
    const keyword = normalized.slice(10).trim();
    return keyword ? { kind: "not_contains", keyword } : undefined;
  }
  if (normalized.startsWith("contains:")) {
    const keyword = normalized.slice(9).trim();
    return keyword ? { kind: "contains", keyword } : undefined;
  }
  return undefined;
}

/** Parse a check string that may contain multiple |-separated conditions. */
function parseChecks(chk: string): ParsedCheck[] {
  return chk.split("|").flatMap(c => {
    const p = parseCheck(c.trim());
    return p ? [p] : [];
  });
}

export function buildInput(
  rules: InputRule[] | undefined,
  query: string,
): { prompts: string[]; examples: ExampleMessage[][] } {
  const prompts: string[] = [];
  const examples: ExampleMessage[][] = [];

  if (!rules) return { prompts, examples };

  const lower = query.toLowerCase();
  for (const rule of rules) {
    const check = (rule.check ?? "").trim();

    // Empty check → unconditional inject
    if (!check) {
      if (rule.inject) prompts.push(rule.inject);
      if (rule.example?.length) examples.push(rule.example);
      continue;
    }

    const checks = parseChecks(check);
    if (checks.length === 0) continue;

    // contains: any one match triggers (OR); !contains: all must hold (AND)
    const positives = checks.filter(c => c.kind === "contains");
    const negatives = checks.filter(c => c.kind === "not_contains");
    const posOk = positives.length === 0 || positives.some(c => lower.includes(c.keyword.toLowerCase()));
    const negOk = negatives.every(c => !lower.includes(c.keyword.toLowerCase()));

    if (posOk && negOk) {
      if (rule.inject) prompts.push(rule.inject);
      if (rule.example?.length) examples.push(rule.example);
    }
  }

  return { prompts, examples };
}

function isCJKText(text: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text);
}

function getInputAugmentationStyle(query: string): {
  promptJoin: string;
  partJoin: string;
  examplePrefix: string;
  userLabel: string;
  assistantLabel: string;
  arrow: string;
  trailingStop: string;
  wrapExample: "quoted" | "colon";
} {
  if (isCJKText(query)) {
    return {
      promptJoin: "；",
      partJoin: "。",
      examplePrefix: "参考对话：",
      userLabel: "用户",
      assistantLabel: "助手",
      arrow: " → ",
      trailingStop: "。",
      wrapExample: "quoted",
    };
  }
  return {
    promptJoin: "; ",
    partJoin: ". ",
    examplePrefix: "Example conversation: ",
    userLabel: "User",
    assistantLabel: "Assistant",
    arrow: " -> ",
    trailingStop: ".",
    wrapExample: "colon",
  };
}

// ===== 3. Process Control =====

/** Recursively evaluate CondExpr */
function evalExpr(
  expr: CondExpr,
  ctx: { done: Set<string>; errors: Map<string, string>; isError: boolean },
): boolean {
  if (typeof expr === "object" && expr !== null) {
    if ("AND" in expr) return (expr as { AND: CondExpr[] }).AND.every(e => evalExpr(e, ctx));
    if ("OR" in expr) return (expr as { OR: CondExpr[] }).OR.some(e => evalExpr(e, ctx));
    if ("NOT" in expr) return !evalExpr((expr as { NOT: CondExpr }).NOT, ctx);
    return false;
  }
  if (typeof expr !== "string") {
    return false;
  }

  if (expr === "isError") return ctx.isError;
  if (expr.startsWith("done:")) return ctx.done.has(expr.slice(5));
  if (expr.startsWith("error:")) return ctx.errors.has(expr.slice(6));
  if (expr.startsWith("!done:")) return !ctx.done.has(expr.slice(6));
  return false;
}

export function getConstraints(
  ctrl: Constraint[] | undefined,
  done: Set<string>,
  errors: Map<string, string>,
  isError: boolean = false,
): ConstraintResult {
  const require = new Set<string>();
  const forbid = new Set<string>();

  for (const constraint of getActiveConstraints(ctrl, done, errors, isError)) {
    if (constraint.kind === "require") {
      require.add(constraint.tool);
    } else {
      forbid.add(constraint.tool);
    }
  }

  return { require: [...require], forbid: [...forbid] };
}

export function getActiveConstraints(
  ctrl: Constraint[] | undefined,
  done: Set<string>,
  errors: Map<string, string>,
  isError: boolean = false,
): ActiveConstraint[] {
  const activeConstraints: ActiveConstraint[] = [];

  if (!ctrl?.length) return activeConstraints;

  for (const constraint of ctrl) {
    const whenActive = constraint.when
      ? evalExpr(constraint.when, { done, errors, isError })
      : true;

    if (!whenActive) continue;

    if (constraint.then.startsWith("require:")) {
      const tool = constraint.then.slice(8).trim();
      if (tool && !done.has(tool)) {
        activeConstraints.push({
          kind: "require",
          tool,
          reason: constraint.reason?.trim() || undefined,
          when: constraint.when,
        });
      }
      continue;
    }

    if (constraint.then.startsWith("forbid:")) {
      const tool = constraint.then.slice(7).trim();
      if (tool) {
        activeConstraints.push({
          kind: "forbid",
          tool,
          reason: constraint.reason?.trim() || undefined,
          when: constraint.when,
        });
      }
    }
  }

  return activeConstraints;
}

// ===== 3b. Process Control Guidance =====

/** Build natural-language guidance for active require/forbid constraints, to be injected into the prompt. */
export function buildProcessControlGuidance(
  ctrl: Constraint[] | undefined,
  done: Set<string>,
  errors: Map<string, string>,
  zh: boolean,
): string {
  const active = getActiveConstraints(ctrl, done, errors);
  if (active.length === 0) return "";

  const parts: string[] = [];
  for (const c of active) {
    if (c.kind === "require") {
      const reason = c.reason ? `（${c.reason}）` : "";
      parts.push(zh
        ? `回复前必须先调用工具 ${c.tool}${reason}。`
        : `You MUST call ${c.tool} before giving any text response${reason}.`);
    } else {
      const reason = c.reason ? `（${c.reason}）` : "";
      parts.push(zh
        ? `禁止调用工具 ${c.tool}${reason}。`
        : `Do NOT call ${c.tool}${reason}.`);
    }
  }
  return parts.join("\n");
}

// ===== 4. Output Control =====

export function checkOutput(
  output: string,
  rules: OutputRule[] | undefined,
  zh: boolean,
): { ok: boolean; failed?: OutputRule; reason?: string; reasons?: string[] } {
  if (!rules) return { ok: true };
  const reasons: string[] = [];
  let firstFailed: OutputRule | undefined;

  for (const rule of rules) {
    const checks = parseChecks(rule.check);
    if (checks.length === 0) continue;

    // contains: all must be present (AND); !contains: none must be present (AND)
    for (const c of checks) {
      if (c.kind === "contains" && !output.includes(c.keyword)) {
        firstFailed ??= rule;
        reasons.push(zh ? `缺少: ${c.keyword}` : `Missing required text: ${c.keyword}`);
      } else if (c.kind === "not_contains" && output.includes(c.keyword)) {
        firstFailed ??= rule;
        reasons.push(zh ? `包含禁止词: ${c.keyword}` : `Contains forbidden text: ${c.keyword}`);
      }
    }
  }

  if (reasons.length > 0) {
    return {
      ok: false,
      failed: firstFailed,
      reason: reasons[0],
      reasons,
    };
  }

  return { ok: true };
}

// ===== 5. Input Augmentation Rendering =====

/** Render current turn input augmentation text, appending to current user prompt. */
export function buildInputAugmentation(
  rules: InputRule[] | undefined,
  query: string,
): string {
  return buildInputAugmentationVariants(rules, query)[0] ?? "";
}

function buildInputAugmentationVariants(
  rules: InputRule[] | undefined,
  query: string,
): string[] {
  const { prompts, examples } = buildInput(rules, query);
  const style = getInputAugmentationStyle(query);
  if (prompts.length === 0 && examples.length === 0) {
    return [];
  }

  const guidance = [...new Set(prompts.map(prompt => prompt.trim()).filter(Boolean))].join(style.promptJoin);
  const parts: string[] = [];
  if (guidance) {
    parts.push(guidance);
  }
  const example = examples[0];
  if (example?.length) {
    const conv = example.map(m =>
      m.role === "user"
        ? style.wrapExample === "quoted"
          ? `${style.userLabel}「${m.content}」`
          : `${style.userLabel}: ${m.content}`
        : style.wrapExample === "quoted"
          ? `${style.assistantLabel}「${m.content}」`
          : `${style.assistantLabel}: ${m.content}`,
    ).join(style.arrow);
    parts.push(`${style.examplePrefix}${conv}`);
  }
  const rendered = parts.join(style.partJoin);
  return rendered ? [rendered, `${rendered}${style.trailingStop}`] : [];
}

export function stripInputAugmentationFromAsset(asset: LiveAsset, text: string): string {
  const cleaned = text.trim();
  if (!cleaned.includes("\n\n")) {
    return cleaned;
  }

  const parts = cleaned.split("\n\n");
  for (let splitIndex = parts.length - 1; splitIndex > 0; splitIndex -= 1) {
    const prefix = parts.slice(0, splitIndex).join("\n\n").trim();
    const suffix = parts.slice(splitIndex).join("\n\n").trim();
    if (!prefix || !suffix || !matchAsset(asset, prefix)) {
      continue;
    }
    const augmentations = buildInputAugmentationVariants(asset.inputControl, prefix);
    if (augmentations.includes(suffix)) {
      return prefix;
    }
  }

  return cleaned;
}

export function stripInputAugmentationFromKnownAssets(
  assets: LiveAsset[],
  text: string,
): string {
  const cleaned = text.trim();
  for (const asset of assets) {
    const stripped = stripInputAugmentationFromAsset(asset, cleaned);
    if (stripped !== cleaned) {
      return stripped;
    }
  }
  return cleaned;
}

/** Normalize example to messages array, accepting both old {user,assistant} and new [{role,content}] formats. */
function normalizeExample(raw: unknown): ExampleMessage[] | undefined {
  // New format: array of {role, content}
  if (Array.isArray(raw)) {
    const msgs = raw.filter((m): m is ExampleMessage =>
      m && typeof m === "object" && typeof (m as Record<string, unknown>).role === "string"
        && typeof (m as Record<string, unknown>).content === "string"
        && ((m as Record<string, unknown>).content as string).trim().length > 0,
    ).map(m => ({ role: m.role, content: m.content.trim() }));
    return msgs.length >= 2 ? msgs : undefined;
  }
  // Old format: {user: string|string[], assistant: string}
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const old = raw as { user?: unknown; assistant?: unknown };
    const assistant = typeof old.assistant === "string" ? old.assistant.trim() : undefined;
    if (!assistant) return undefined;
    const msgs: ExampleMessage[] = [];
    if (typeof old.user === "string" && old.user.trim()) {
      msgs.push({ role: "user", content: old.user.trim() });
    } else if (Array.isArray(old.user)) {
      for (const item of old.user) {
        if (typeof item === "string" && item.trim()) {
          msgs.push({ role: "user", content: item.trim() });
        }
      }
    }
    if (msgs.length === 0) return undefined;
    msgs.push({ role: "assistant", content: assistant });
    return msgs;
  }
  return undefined;
}

function normalizeProcessControl(raw: unknown): Constraint[] | undefined {
  if (Array.isArray(raw)) {
    return raw as Constraint[];
  }
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const legacy = raw as { constraints?: unknown };
  return Array.isArray(legacy.constraints) ? (legacy.constraints as Constraint[]) : undefined;
}

function normalizeAsset(asset: LiveAsset): LiveAsset {
  return {
    ...asset,
    inputControl: asset.inputControl?.map(rule => {
      const example = normalizeExample(rule.example);
      return example ? { ...rule, example } : { ...rule, example: undefined };
    }),
    processControl: normalizeProcessControl(asset.processControl),
  };
}

// ===== Loading =====

export async function loadAllAssets(dir: string): Promise<LiveAsset[]> {
  const files = await readdir(dir);
  const assets: LiveAsset[] = [];

  for (const f of files.filter(file => file.endsWith(".json"))) {
    const content = await readFile(path.join(dir, f), "utf-8");
    try {
      assets.push(normalizeAsset(JSON.parse(content) as LiveAsset));
    } catch {
      // skip invalid JSON
    }
  }

  return assets;
}
