import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// The guard is a build-time script; testing it must not pull it into host output.
// @ts-expect-error Build script intentionally has no runtime declaration file.
import { retiredTransportImports, retiredTransportPath, checkRetiredTransportSources } from "../scripts/retired-transport-guard.mjs";

describe("retired transport source boundary", () => {
  it.each([
    'import type { Hidden } from "../telegram/api.js";',
    'export type { Hidden } from "../lark/types.js";',
    'const load = () => import("../commands/cli.js");',
    'const load = () => require("../service.js");',
    'vi.mock("../telegram/api.js", () => ({}));',
    'const helper = new URL("../runtime/telegram-out.js", import.meta.url);',
    'import { createRequire as makeRequire } from "node:module"; const local = makeRequire(import.meta.url); local("../runtime/cron-runtime.js");',
    'vi.importMock("../tools/telegram-tool-registry.js");',
    'import * as Module from "node:module"; const local = Module.createRequire(import.meta.url); local("../telegram/api.js");',
    'import Module from "module"; const local = Module["createRequire"](import.meta.url); local.resolve("../lark/types.js");',
    'const Module = require("node:module"); const local = Module.createRequire(__filename); local("../service.js");',
    'const { createRequire: makeRequire } = require("module"); const local = makeRequire(__filename); local("../service.js");',
    'const local = require("node:module").createRequire(__filename); local("../service.js");',
  ])("rejects erased and lazy edges: %s", source => {
    expect(retiredTransportImports("src/runtime/example.ts", source)).toHaveLength(1);
  });
  it("keeps historical schema fixtures and negative guard strings legal", () => {
    expect(retiredTransportImports("src/runtime/example.ts", [
      '// import type { Old } from "../telegram/api.js";',
      'const route = "lark:fixture";',
      'const field = "telegramChatId";',
      'const forbidden = "src/telegram/api.ts";',
      'import type { CommandMessage } from "./command-message.js";',
    ].join('\n'))).toEqual([]);
  });
  it("admits only the package verifiers' SDK absence probe, not an SDK load", () => {
    const prefix = 'import { createRequire } from "node:module"; const requirePackage = createRequire(import.meta.url);';
    const probe = prefix + 'requirePackage.resolve("@larksuiteoapi/node-sdk");';
    expect(retiredTransportImports("scripts/verify-standalone-package.mjs", probe)).toEqual([]);
    expect(retiredTransportImports("src/core/x.ts", probe)).toHaveLength(1);
    expect(retiredTransportImports("scripts/verify-standalone-package.mjs", prefix + 'requirePackage("@larksuiteoapi/node-sdk");')).toHaveLength(1);
    expect(retiredTransportImports("scripts/verify-standalone-package.mjs", 'import { Client } from "@larksuiteoapi/node-sdk";')).toHaveLength(1);
  });
  it("limits the intentional SDK canary exemption to its dedicated helper", () => {
    const source = 'const Module = require("node:module"); const probe = Module.createRequire(__filename); probe("@larksuiteoapi/node-sdk");';
    expect(retiredTransportImports("tests/helpers/gateway-no-feishu.cjs", source)).toEqual([]);
    expect(retiredTransportImports("tests/ordinary.test.ts", source)).toHaveLength(1);
    expect(retiredTransportImports("scripts/verify-standalone-package.mjs", source)).toHaveLength(1);
  });

  it("rejects SDK imports and recognizes platform paths across separators", () => {
    expect(retiredTransportImports("src/core/x.ts", 'import { Client } from "@larksuiteoapi/node-sdk";')).toHaveLength(1);
    expect(retiredTransportPath('src\\telegram\\api.ts')).toBe(true);
    expect(retiredTransportPath('src/hub/service.ts')).toBe(false);
  });

  it("accepts the Docker host stage without optional tests or client sources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "retired-guard-"));
    try {
      await mkdir(path.join(root, "src"));
      await mkdir(path.join(root, "deepseek-harness-plugin/src"), { recursive: true });
      await writeFile(path.join(root, "src/index.ts"), 'export const route = "lark:historical";');
      await expect(checkRetiredTransportSources(root)).resolves.toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not hide missing required source roots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "retired-guard-"));
    try { await expect(checkRetiredTransportSources(root)).rejects.toMatchObject({ code: "ENOENT" }); }
    finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["src/runtime/cron-runtime.ts", "src/tools/telegram-tool-executor.ts", "tsconfig.legacy.json", "scripts/start-instance.sh"])("rejects restored retired files even when unimported: %s", async name => {
    const root = await mkdtemp(path.join(os.tmpdir(), "retired-guard-"));
    try {
      await mkdir(path.join(root, "src"));
      await mkdir(path.join(root, "deepseek-harness-plugin/src"), { recursive: true });
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), "");
      await expect(checkRetiredTransportSources(root)).rejects.toThrow(`retired path exists: ${name}`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("checks optional client sources when present", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "retired-guard-"));
    try {
      await mkdir(path.join(root, "src"));
      await mkdir(path.join(root, "deepseek-harness-plugin/src"), { recursive: true });
      await mkdir(path.join(root, "client/src"), { recursive: true });
      await writeFile(path.join(root, "client/src/index.ts"), 'import type { Old } from "../../src/telegram/api.js";');
      await expect(checkRetiredTransportSources(root)).rejects.toThrow("client/src/index.ts -> ../../src/telegram/api.js");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
