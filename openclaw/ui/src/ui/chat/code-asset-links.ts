import {
  formatCodeAssetChangeSummary,
  formatCodeAssetDisplayName,
  type CodeAssetEntry,
} from "../controllers/code-assets.ts";
import type { ChatItem, ChatTurnAssetLink, MessageGroup } from "../types/chat-types.ts";
import { extractTextCached } from "./message-extract.ts";
import { normalizeRoleForGrouping } from "./message-normalizer.ts";

const CHAT_ASSET_STUDIO_PATH = "/code-assets/ui";
const MAX_MATCHED_ASSETS = 3;

type MatchToken = {
  value: string;
  weight: number;
};

type AssetMatchScore = {
  score: number;
  matchedTerms: string[];
  matchedRegex: boolean;
};

function normalizeMatchText(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeMatchTokens(values: string[], weight: number): MatchToken[] {
  const seen = new Set<string>();
  const out: MatchToken[] = [];
  for (const value of values) {
    const normalized = normalizeMatchText(value);
    if (!normalized) {
      continue;
    }
    if (/^[a-z0-9_-]{1,2}$/i.test(normalized)) {
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push({ value: normalized, weight });
  }
  return out;
}

function matchesToken(text: string, token: string): boolean {
  if (!token) {
    return false;
  }
  if (/[\u4e00-\u9fff]/.test(token)) {
    return text.includes(token);
  }
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, "i").test(text);
}

function compileRegex(pattern: string): RegExp | null {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return null;
  }
  const slashMatch = trimmed.match(/^\/(.+)\/([a-z]*)$/i);
  try {
    if (slashMatch) {
      return new RegExp(slashMatch[1], slashMatch[2] || "i");
    }
    return new RegExp(trimmed, "i");
  } catch {
    return null;
  }
}

function hasCjk(value: string): boolean {
  return /[\u4e00-\u9fff]/.test(value);
}

function effectiveTokenWeight(token: string, baseWeight: number): number {
  const normalized = normalizeMatchText(token);
  if (!normalized) {
    return 0;
  }
  if (/\s|[，。！？,.!?;:：；()（）]/.test(normalized)) {
    return baseWeight + 1;
  }
  if (hasCjk(normalized)) {
    if (normalized.length >= 4) {
      return baseWeight;
    }
    if (normalized.length === 3) {
      return Math.max(3, baseWeight - 1);
    }
    return 1;
  }
  if (normalized.length >= 8) {
    return baseWeight;
  }
  if (normalized.length >= 5) {
    return Math.max(2, baseWeight - 1);
  }
  return 1;
}

function formatMatchReason(matchedTerms: string[], matchedRegex: boolean): string {
  if (matchedTerms.length > 0) {
    return `Keywords: ${matchedTerms.join(", ")}`;
  }
  if (matchedRegex) {
    return "Matched this asset's trigger pattern";
  }
  return "Matched the current input";
}

function scoreAssetMatch(text: string, asset: CodeAssetEntry): AssetMatchScore {
  const normalizedText = normalizeMatchText(text);
  if (!normalizedText) {
    return { score: 0, matchedTerms: [], matchedRegex: false };
  }
  const tokens = [
    ...normalizeMatchTokens(asset.trigger.keywords, 4),
    ...normalizeMatchTokens(asset.analysis.expandedKeywords, 3),
    ...normalizeMatchTokens(asset.keywords, 2),
    ...normalizeMatchTokens(asset.trigger.contextSignals, 2),
  ];
  let score = 0;
  const consumed = new Set<string>();
  const matchedTerms: Array<{ value: string; weight: number }> = [];
  for (const token of tokens) {
    if (consumed.has(token.value)) {
      continue;
    }
    if (!matchesToken(normalizedText, token.value)) {
      continue;
    }
    const weighted = effectiveTokenWeight(token.value, token.weight);
    if (weighted <= 0) {
      continue;
    }
    consumed.add(token.value);
    score += weighted;
    matchedTerms.push({ value: token.value, weight: weighted });
  }
  let matchedRegex = false;
  for (const pattern of asset.trigger.regex) {
    const compiled = compileRegex(pattern);
    if (compiled?.test(text)) {
      matchedRegex = true;
      score += 5;
    }
  }
  if (!matchedRegex && score < 3) {
    return { score: 0, matchedTerms: [], matchedRegex: false };
  }
  return {
    score,
    matchedTerms: matchedTerms
      .toSorted((left, right) => {
        if (right.weight !== left.weight) {
          return right.weight - left.weight;
        }
        return right.value.localeCompare(left.value);
      })
      .map((entry) => entry.value)
      .slice(0, 3),
    matchedRegex,
  };
}

function groupText(group: MessageGroup): string {
  return group.messages
    .map((entry) => extractTextCached(entry.message) ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function codeAssetStudioHref(assetId?: string | null): string {
  if (!assetId?.trim()) {
    return CHAT_ASSET_STUDIO_PATH;
  }
  return `${CHAT_ASSET_STUDIO_PATH}?asset=${encodeURIComponent(assetId.trim())}`;
}

export function matchCodeAssetsForText(
  text: string,
  assets: CodeAssetEntry[],
): ChatTurnAssetLink[] {
  if (!text.trim() || assets.length === 0) {
    return [];
  }
  return assets
    .map((asset) => {
      const match = scoreAssetMatch(text, asset);
      return {
        id: asset.id,
        name: asset.name,
        displayName: formatCodeAssetDisplayName(asset),
        changeSummary: formatCodeAssetChangeSummary(asset),
        matchReason: formatMatchReason(match.matchedTerms, match.matchedRegex),
        href: codeAssetStudioHref(asset.id),
        score: match.score,
        utility: asset.utility,
      };
    })
    .filter((entry) => entry.score > 0)
    .toSorted((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.utility !== left.utility) {
        return right.utility - left.utility;
      }
      return left.name.localeCompare(right.name);
    })
    .slice(0, MAX_MATCHED_ASSETS);
}

export function attachCodeAssetLinks(
  items: Array<ChatItem | MessageGroup>,
  assets: CodeAssetEntry[],
): Array<ChatItem | MessageGroup> {
  if (assets.length === 0) {
    return items.map((item) =>
      item.kind === "group" &&
      ["user", "assistant"].includes(normalizeRoleForGrouping(item.role).toLowerCase())
        ? { ...item, codeAssets: [], codeAssetOrigin: "none" as const }
        : item,
    );
  }

  let activeTurnAssets: ChatTurnAssetLink[] = [];
  return items.map((item) => {
    if (item.kind !== "group") {
      return item;
    }

    const role = normalizeRoleForGrouping(item.role).toLowerCase();
    if (role !== "user" && role !== "assistant") {
      return item;
    }

    const directMatches = matchCodeAssetsForText(groupText(item), assets);
    if (role === "user") {
      activeTurnAssets = directMatches;
      return {
        ...item,
        codeAssets: directMatches,
        codeAssetOrigin: directMatches.length > 0 ? ("direct" as const) : ("none" as const),
      };
    }

    if (directMatches.length > 0) {
      activeTurnAssets = directMatches;
      return { ...item, codeAssets: directMatches, codeAssetOrigin: "direct" as const };
    }

    if (activeTurnAssets.length > 0) {
      return { ...item, codeAssets: activeTurnAssets, codeAssetOrigin: "turn" as const };
    }

    return { ...item, codeAssets: [], codeAssetOrigin: "none" as const };
  });
}
