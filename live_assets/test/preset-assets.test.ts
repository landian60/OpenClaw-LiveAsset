import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadAllAssets } from "../src/system.ts";

test("fixtures ship six bilingual preset demo assets", async () => {
  const fixturesDir = fileURLToPath(new URL("../../fixtures/assets", import.meta.url));
  const assets = await loadAllAssets(fixturesDir);

  assert.equal(assets.length, 6);
  assert.deepEqual(
    assets.map((asset) => asset.assetId).sort(),
    [
      "advisor-email-draft-en",
      "advisor-email-draft-zh",
      "empathetic-response-en",
      "empathetic-response-zh",
      "product-comparison-search-en",
      "product-comparison-search-zh",
    ],
  );
  assert.deepEqual(
    [...new Set(assets.map((asset) => asset.scenarioId))].sort(),
    [
      "comparison_before_recommendation",
      "email_draft_review",
      "empathetic_response",
    ],
  );

  for (const asset of assets) {
    assert.ok(asset.matching.any?.length);
    for (const rule of asset.inputControl ?? []) {
      assert.equal(rule.check?.includes("|"), false);
      if (rule.example) {
        assert.ok(Array.isArray(rule.example));
        assert.ok(rule.example.length >= 2);
        assert.equal(rule.example[0]?.role, "user");
        assert.equal(rule.example.at(-1)?.role, "assistant");
      }
    }
    for (const rule of asset.outputControl ?? []) {
      assert.equal(rule.check?.includes("|"), false);
    }
  }
});
