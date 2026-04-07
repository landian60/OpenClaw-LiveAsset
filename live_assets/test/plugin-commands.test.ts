import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import plugin from "../src/plugin.ts";

test("plugin registers only liveassets slash commands", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "live-assets-plugin-commands-"));
  const registeredCommands: string[] = [];

  try {
    plugin.register({
      pluginConfig: { assetsDir: tempDir },
      logger: { info: () => {}, warn: () => {} },
      resolvePath: (input: string) => input,
      registerCommand: (command: unknown) => {
        const name = (command as { name?: unknown }).name;
        if (typeof name === "string") {
          registeredCommands.push(name);
        }
      },
      registerHttpRoute: () => {},
      registerTool: () => {},
      on: () => {},
    });

    assert.deepEqual(registeredCommands.sort(), [
      "liveassets-baseline",
      "liveassets-delete",
      "liveassets-feedback",
      "liveassets-generate",
      "liveassets-reload",
      "liveassets-status",
      "liveassets-viz",
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
