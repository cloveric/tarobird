import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterAll, afterEach, expect, vi } from "vitest";

// This setup runs before test-module imports, including files that did not
// manually inject a forbidden SDK runtime. Retired adapters are not installed.
const testPath = expect.getState().testPath ?? "";
if (/[/\\]gateway-[^/\\]+\.(?:test|case)\.ts$/.test(testPath)) {
  const root = mkdtempSync(path.join(os.tmpdir(), "gateway-guard-"));
  const report = path.join(root, "violations.jsonl"); writeFileSync(report, "", { mode: 0o600 });
  const require = createRequire(import.meta.url);
  const { install } = require("./helpers/gateway-no-feishu.cjs") as { install(report: string): { guardSdk(value: unknown): unknown; dispose(): void } };
  const guard = install(report);
  const previous = process.env.TAROBOT_GATEWAY_GUARD_REPORT;
  process.env.TAROBOT_GATEWAY_GUARD_REPORT = report;
  vi.doMock("@larksuiteoapi/node-sdk", async () => guard.guardSdk(await vi.importActual("@larksuiteoapi/node-sdk")));
  const assertClean = () => expect(readFileSync(report, "utf8"), "Gateway test attempted a Feishu SDK call or unapproved subprocess, even if its error was caught").toBe("");
  afterEach(assertClean);
  afterAll(() => {
    try { assertClean(); } finally {
      guard.dispose(); vi.doUnmock("@larksuiteoapi/node-sdk");
      if (previous === undefined) delete process.env.TAROBOT_GATEWAY_GUARD_REPORT; else process.env.TAROBOT_GATEWAY_GUARD_REPORT = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
