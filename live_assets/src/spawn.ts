/**
 * spawn.ts — Python child_process helper for Generate/Update scripts
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = path.join(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  "scripts",
);

export type SpawnLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

export async function spawnPython(
  scriptName: string,
  input: object,
  env: Record<string, string>,
  logger?: SpawnLogger,
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);

  return new Promise((resolve, reject) => {
    const pythonBin = env.PYTHON_BIN || process.env.PYTHON_BIN || "python3";
    const child = spawn(pythonBin, [scriptPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`[spawnPython] ${scriptName} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) {
        stderr += line + "\n";
        logger?.warn(`[${scriptName}] ${line}`);
      }
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`[spawnPython] failed to start ${scriptName}: ${err.message}`));
      }
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        reject(new Error(
          `[spawnPython] ${scriptName} exited with code ${code}\nstderr: ${stderr.slice(0, 500)}`,
        ));
        return;
      }

      try {
        const result = JSON.parse(stdout) as Record<string, unknown>;
        resolve(result);
      } catch {
        reject(new Error(
          `[spawnPython] ${scriptName} returned invalid JSON\nstdout: ${stdout.slice(0, 500)}`,
        ));
      }
    });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}
