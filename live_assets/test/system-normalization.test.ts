import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildInputAugmentation, loadAllAssets, stripInputAugmentationFromAsset } from "../src/system.ts";

test("loadAllAssets normalizes legacy processControl.constraints objects to arrays", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "live-assets-system-"));
  try {
    await writeFile(
      path.join(tempDir, "legacy.json"),
      JSON.stringify({
        assetId: "legacy-shape",
        matching: { any: ["email"] },
        processControl: {
          constraints: [
            {
              when: "!done:show_draft",
              then: "forbid:send_email",
              reason: "legacy shape",
            },
          ],
        },
      }),
      "utf8",
    );

    const assets = await loadAllAssets(tempDir);
    assert.equal(assets.length, 1);
    assert.deepEqual(assets[0]?.processControl, [
      {
        when: "!done:show_draft",
        then: "forbid:send_email",
        reason: "legacy shape",
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildInputAugmentation uses English labels and punctuation for English queries", () => {
  const augmentation = buildInputAugmentation(
    [
      {
        check: "contains:report",
        inject: "Please split the summary by project",
        example: [
          { role: "user", content: "Help me write a weekly report" },
          { role: "assistant", content: "Sure, I will organize it by project." },
        ],
      },
    ],
    "Help me write a weekly report",
  );

  assert.equal(
    augmentation,
    "Please split the summary by project. Example conversation: User: Help me write a weekly report -> Assistant: Sure, I will organize it by project.",
  );
});

test("stripInputAugmentationFromAsset removes appended English augmentation variants", () => {
  const asset = {
    assetId: "weekly-report-en",
    matching: { any: ["weekly report"], all: [], not: [] },
    inputControl: [
      {
        check: "contains:report",
        inject: "Please split the summary by project",
        example: [
          { role: "user", content: "Help me write a weekly report" },
          { role: "assistant", content: "Sure, I will organize it by project." },
        ],
      },
    ],
  };

  const stripped = stripInputAugmentationFromAsset(
    asset,
    "Help me write a weekly report\n\nPlease split the summary by project. Example conversation: User: Help me write a weekly report -> Assistant: Sure, I will organize it by project..",
  );

  assert.equal(stripped, "Help me write a weekly report");
});
