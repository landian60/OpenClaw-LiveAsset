import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type FakeFsEntry =
  | { kind: "file"; content: string; mtimeMs: number }
  | { kind: "dir"; mtimeMs: number };

const state = vi.hoisted(() => ({
  entries: new Map<string, FakeFsEntry>(),
  realpaths: new Map<string, string>(),
  nextMtimeMs: 1_000,
}));

const abs = (p: string) => path.resolve(p);

function bumpMtimeMs() {
  state.nextMtimeMs += 1_000;
  return state.nextMtimeMs;
}

function ensureDirTree(p: string) {
  const resolved = abs(p);
  const parts = resolved.split(path.sep);
  const start = resolved.startsWith(path.sep) ? 1 : 0;
  for (let i = start; i <= parts.length; i++) {
    const candidate = parts.slice(0, i).join(path.sep) || path.sep;
    if (!candidate.startsWith(abs("fixtures"))) {
      continue;
    }
    if (!state.entries.has(candidate)) {
      state.entries.set(candidate, { kind: "dir", mtimeMs: bumpMtimeMs() });
    }
  }
}

function setFile(p: string, content = "", mtimeMs = bumpMtimeMs()) {
  ensureDirTree(path.dirname(p));
  state.entries.set(abs(p), { kind: "file", content, mtimeMs });
}

function setDir(p: string, mtimeMs = bumpMtimeMs()) {
  ensureDirTree(path.dirname(p));
  state.entries.set(abs(p), { kind: "dir", mtimeMs });
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const pathMod = await import("node:path");
  const absInMock = (p: string) => pathMod.resolve(p);
  const fixturesRoot = `${absInMock("fixtures")}${pathMod.sep}`;
  const isFixturePath = (p: string) => {
    const resolved = absInMock(p);
    return resolved === fixturesRoot.slice(0, -1) || resolved.startsWith(fixturesRoot);
  };
  const readFixtureEntry = (p: string) => state.entries.get(absInMock(p));

  const wrapped = {
    ...actual,
    existsSync: (p: string) =>
      isFixturePath(p) ? state.entries.has(absInMock(p)) : actual.existsSync(p),
    readdirSync: (p: string, options?: { withFileTypes?: boolean }) => {
      if (!isFixturePath(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return actual.readdirSync(p as any, options as any) as unknown;
      }
      const resolved = absInMock(p);
      const prefix = resolved.endsWith(pathMod.sep) ? resolved : `${resolved}${pathMod.sep}`;
      const names = new Map<string, FakeFsEntry>();
      for (const [entryPath, entry] of state.entries.entries()) {
        if (!entryPath.startsWith(prefix)) {
          continue;
        }
        const rest = entryPath.slice(prefix.length);
        if (!rest || rest.includes(pathMod.sep)) {
          continue;
        }
        names.set(rest, entry);
      }
      if (options?.withFileTypes) {
        return Array.from(names.entries()).map(([name, entry]) => ({
          name,
          isFile: () => entry.kind === "file",
          isDirectory: () => entry.kind === "dir",
        }));
      }
      return Array.from(names.keys());
    },
    readFileSync: (p: string, encoding?: unknown) => {
      if (!isFixturePath(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return actual.readFileSync(p as any, encoding as any) as unknown;
      }
      const entry = readFixtureEntry(p);
      if (entry?.kind === "file") {
        return entry.content;
      }
      throw new Error(`ENOENT: no such file, open '${p}'`);
    },
    statSync: (p: string) => {
      if (!isFixturePath(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return actual.statSync(p as any) as unknown;
      }
      const entry = readFixtureEntry(p);
      if (entry?.kind === "file") {
        return { isFile: () => true, isDirectory: () => false, mtimeMs: entry.mtimeMs };
      }
      if (entry?.kind === "dir") {
        return { isFile: () => false, isDirectory: () => true, mtimeMs: entry.mtimeMs };
      }
      throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
    },
    realpathSync: (p: string) =>
      isFixturePath(p)
        ? (state.realpaths.get(absInMock(p)) ?? absInMock(p))
        : actual.realpathSync(p),
  };

  return { ...wrapped, default: wrapped };
});

vi.mock("./openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn(async () => null),
  resolveOpenClawPackageRootSync: vi.fn(() => null),
}));

let resolveControlUiRepoRoot: typeof import("./control-ui-assets.js").resolveControlUiRepoRoot;
let resolveControlUiDistIndexPath: typeof import("./control-ui-assets.js").resolveControlUiDistIndexPath;
let resolveControlUiDistIndexHealth: typeof import("./control-ui-assets.js").resolveControlUiDistIndexHealth;
let isControlUiDistStaleSync: typeof import("./control-ui-assets.js").isControlUiDistStaleSync;
let isPackageProvenControlUiRootSync: typeof import("./control-ui-assets.js").isPackageProvenControlUiRootSync;
let resolveControlUiRootOverrideSync: typeof import("./control-ui-assets.js").resolveControlUiRootOverrideSync;
let resolveControlUiRootSync: typeof import("./control-ui-assets.js").resolveControlUiRootSync;
let openclawRoot: typeof import("./openclaw-root.js");

describe("control UI assets helpers (fs-mocked)", () => {
  beforeAll(async () => {
    ({
      resolveControlUiRepoRoot,
      resolveControlUiDistIndexPath,
      resolveControlUiDistIndexHealth,
      isControlUiDistStaleSync,
      isPackageProvenControlUiRootSync,
      resolveControlUiRootOverrideSync,
      resolveControlUiRootSync,
    } = await import("./control-ui-assets.js"));
    openclawRoot = await import("./openclaw-root.js");
  });

  beforeEach(() => {
    state.entries.clear();
    state.realpaths.clear();
    state.nextMtimeMs = 1_000;
    vi.clearAllMocks();
  });

  it("resolves repo root from src argv1", () => {
    const root = abs("fixtures/ui-src");
    setFile(path.join(root, "ui", "vite.config.ts"), "export {};\n");

    const argv1 = path.join(root, "src", "index.ts");
    expect(resolveControlUiRepoRoot(argv1)).toBe(root);
  });

  it("resolves repo root by traversing up (dist argv1)", () => {
    const root = abs("fixtures/ui-dist");
    setFile(path.join(root, "package.json"), "{}\n");
    setFile(path.join(root, "ui", "vite.config.ts"), "export {};\n");

    const argv1 = path.join(root, "dist", "index.js");
    expect(resolveControlUiRepoRoot(argv1)).toBe(root);
  });

  it("resolves dist control-ui index path for dist argv1", async () => {
    const argv1 = abs(path.join("fixtures", "pkg", "dist", "index.js"));
    const distDir = path.dirname(argv1);
    await expect(resolveControlUiDistIndexPath(argv1)).resolves.toBe(
      path.join(distDir, "control-ui", "index.html"),
    );
  });

  it("resolves dist control-ui index path for symlinked argv1 via realpath", async () => {
    const pkgRoot = abs("fixtures/bun-global/openclaw");
    const wrapperArgv1 = abs("fixtures/bin/openclaw");
    const realEntrypoint = path.join(pkgRoot, "dist", "index.js");

    state.realpaths.set(wrapperArgv1, realEntrypoint);

    await expect(resolveControlUiDistIndexPath(wrapperArgv1)).resolves.toBe(
      path.join(pkgRoot, "dist", "control-ui", "index.html"),
    );
  });

  it("uses resolveOpenClawPackageRoot when available", async () => {
    const pkgRoot = abs("fixtures/openclaw");
    (
      openclawRoot.resolveOpenClawPackageRoot as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(pkgRoot);

    await expect(resolveControlUiDistIndexPath(abs("fixtures/bin/openclaw"))).resolves.toBe(
      path.join(pkgRoot, "dist", "control-ui", "index.html"),
    );
  });

  it("falls back to package.json name matching when root resolution fails", async () => {
    const root = abs("fixtures/fallback");
    setFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
    setFile(path.join(root, "dist", "control-ui", "index.html"), "<html></html>\n");

    await expect(resolveControlUiDistIndexPath(path.join(root, "openclaw.mjs"))).resolves.toBe(
      path.join(root, "dist", "control-ui", "index.html"),
    );
  });

  it("returns null when fallback package name does not match", async () => {
    const root = abs("fixtures/not-openclaw");
    setFile(path.join(root, "package.json"), JSON.stringify({ name: "malicious-pkg" }));
    setFile(path.join(root, "dist", "control-ui", "index.html"), "<html></html>\n");

    await expect(resolveControlUiDistIndexPath(path.join(root, "index.mjs"))).resolves.toBeNull();
  });

  it("reports health for missing + existing dist assets", async () => {
    const root = abs("fixtures/health");
    const indexPath = path.join(root, "dist", "control-ui", "index.html");

    await expect(resolveControlUiDistIndexHealth({ root })).resolves.toEqual({
      indexPath,
      exists: false,
      stale: false,
    });

    setFile(indexPath, "<html></html>\n");
    await expect(resolveControlUiDistIndexHealth({ root })).resolves.toEqual({
      indexPath,
      exists: true,
      stale: false,
    });
  });

  it("marks dist assets stale when a UI source file is newer than index.html", async () => {
    const root = abs("fixtures/stale-ui");
    const indexPath = path.join(root, "dist", "control-ui", "index.html");
    setFile(path.join(root, "ui", "vite.config.ts"), "export {};\n", 2_000);
    setFile(path.join(root, "ui", "index.html"), "<html></html>\n", 2_100);
    setFile(path.join(root, "ui", "src", "app-chat.ts"), "export {};\n", 4_000);
    setFile(indexPath, "<html></html>\n", 3_000);

    expect(isControlUiDistStaleSync(root, indexPath)).toBe(true);
    await expect(resolveControlUiDistIndexHealth({ root })).resolves.toEqual({
      indexPath,
      exists: true,
      stale: true,
    });
  });

  it("ignores newer UI test files when checking dist staleness", () => {
    const root = abs("fixtures/non-stale-ui");
    const indexPath = path.join(root, "dist", "control-ui", "index.html");
    setFile(path.join(root, "ui", "vite.config.ts"), "export {};\n", 2_000);
    setFile(path.join(root, "ui", "index.html"), "<html></html>\n", 2_100);
    setFile(path.join(root, "ui", "src", "chat.test.ts"), "export {};\n", 5_000);
    setFile(indexPath, "<html></html>\n", 4_000);

    expect(isControlUiDistStaleSync(root, indexPath)).toBe(false);
  });

  it("resolves control-ui root from override file or directory", () => {
    const root = abs("fixtures/override");
    const uiDir = path.join(root, "dist", "control-ui");
    const indexPath = path.join(uiDir, "index.html");

    setDir(uiDir);
    setFile(indexPath, "<html></html>\n");

    expect(resolveControlUiRootOverrideSync(uiDir)).toBe(uiDir);
    expect(resolveControlUiRootOverrideSync(indexPath)).toBe(uiDir);
    expect(resolveControlUiRootOverrideSync(path.join(uiDir, "missing.html"))).toBeNull();
  });

  it("resolves control-ui root for dist bundle argv1 and moduleUrl candidates", async () => {
    const pkgRoot = abs("fixtures/openclaw-bundle");
    (
      openclawRoot.resolveOpenClawPackageRootSync as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValueOnce(pkgRoot);

    const uiDir = path.join(pkgRoot, "dist", "control-ui");
    setFile(path.join(uiDir, "index.html"), "<html></html>\n");

    // argv1Dir candidate: <argv1Dir>/control-ui
    expect(resolveControlUiRootSync({ argv1: path.join(pkgRoot, "dist", "bundle.js") })).toBe(
      uiDir,
    );

    // moduleUrl candidate: <moduleDir>/control-ui
    const moduleUrl = pathToFileURL(path.join(pkgRoot, "dist", "bundle.js")).toString();
    expect(resolveControlUiRootSync({ moduleUrl })).toBe(uiDir);
  });

  it("resolves control-ui root for symlinked argv1 via realpath", () => {
    const pkgRoot = abs("fixtures/bun-global/openclaw");
    const wrapperArgv1 = abs("fixtures/bin/openclaw");
    const realEntrypoint = path.join(pkgRoot, "dist", "index.js");
    const uiDir = path.join(pkgRoot, "dist", "control-ui");

    state.realpaths.set(wrapperArgv1, realEntrypoint);
    setFile(path.join(uiDir, "index.html"), "<html></html>\n");

    expect(resolveControlUiRootSync({ argv1: wrapperArgv1 })).toBe(uiDir);
  });

  it("detects package-proven control-ui roots", () => {
    const pkgRoot = abs("fixtures/openclaw-package-root");
    const uiDir = path.join(pkgRoot, "dist", "control-ui");
    setDir(uiDir);
    setFile(path.join(uiDir, "index.html"), "<html></html>\n");
    (
      openclawRoot.resolveOpenClawPackageRootSync as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValueOnce(pkgRoot);

    expect(
      isPackageProvenControlUiRootSync(uiDir, {
        cwd: abs("fixtures/cwd"),
      }),
    ).toBe(true);
  });

  it("does not treat fallback roots as package-proven", () => {
    const pkgRoot = abs("fixtures/openclaw-package-root");
    const fallbackRoot = abs("fixtures/fallback-root/dist/control-ui");
    setDir(fallbackRoot);
    setFile(path.join(fallbackRoot, "index.html"), "<html></html>\n");
    (
      openclawRoot.resolveOpenClawPackageRootSync as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValueOnce(pkgRoot);

    expect(
      isPackageProvenControlUiRootSync(fallbackRoot, {
        cwd: abs("fixtures/fallback-root"),
      }),
    ).toBe(false);
  });
});
