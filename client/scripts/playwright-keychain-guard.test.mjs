import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { assertWebKitTestEnvironment } from "./playwright-keychain-guard.mjs";

const client = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
// The root package retains the TypeScript parser API used by repository tools.
const ts = createRequire(new URL("../../package.json", import.meta.url))("typescript-api");

test("macOS WebKit fails closed, including ordinary CI and false opt-ins", () => {
  for (const env of [{}, { CI: "1" }, { TAROBIRD_TEST_DISPOSABLE_MAC: "0" }, { TAROBIRD_TEST_DISPOSABLE_MAC: "true" }]) {
    assert.throws(() => assertWebKitTestEnvironment("webkit", { platform: "darwin", env }), /before launching the browser/);
  }
});

test("only the explicit disposable Mac opt-in permits macOS WebKit", () => {
  assert.doesNotThrow(() => assertWebKitTestEnvironment("webkit", {
    platform: "darwin", env: { TAROBIRD_TEST_DISPOSABLE_MAC: "1" },
  }));
});

test("Chromium, Firefox and non-Mac WebKit keep their existing behavior", () => {
  for (const [platform, browserName] of [["darwin", "chromium"], ["darwin", "firefox"], ["linux", "webkit"], ["win32", "webkit"]]) {
    assert.doesNotThrow(() => assertWebKitTestEnvironment(browserName, { platform, env: {} }));
  }
});

test("specs leave browser selection to the guarded project configuration", async () => {
  const files = await readdir(path.join(client, "e2e"), { recursive: true });
  for (const file of files.filter(file => file.endsWith(".ts"))) {
    const source = ts.createSourceFile(file, await readFile(path.join(client, "e2e", file), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = node => {
      if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
        assert.ok(!["browserName", "defaultBrowserType"].includes(node.name.text), `${file}: browser overrides bypass the project keychain guard`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});

// These probe tests do not request page/browser fixtures: even a broken guard
// can only write a marker, never start WebKit or access the login keychain.
for (const scenario of [
  { name: "Chromium", config: "playwright.config.ts", args: [], blocked: false },
  { name: "WebKit config", config: "playwright.webkit.config.ts", args: [], blocked: true },
  { name: "CLI WebKit", config: "playwright.config.ts", args: ["--browser=webkit"], blocked: true },
  { name: "CLI all browsers", config: "playwright.config.ts", args: ["--browser=all"], blocked: true },
]) {
  test(`real CLI: ${scenario.name} honors the launch guard`, { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tarobird-browser-guard-"));
    try {
      const marker = path.join(directory, "worker-ran");
      const config = path.join(directory, "probe.config.mjs");
      const spec = path.join(directory, "probe.spec.mjs");
      await writeFile(config, `import base from ${JSON.stringify(pathToFileURL(path.join(client, scenario.config)).href)};
if (base.globalSetup !== ${JSON.stringify(path.join(client, "scripts/playwright-keychain-guard.mjs"))}) throw new Error('Repository keychain guard must be registered');
export default { ...base, testDir: ${JSON.stringify(directory)}, testMatch: /probe\\.spec\\.mjs$/, outputDir: ${JSON.stringify(path.join(directory, "results"))}, reporter: 'list' };`);
      await writeFile(spec, `import playwrightTest from ${JSON.stringify(pathToFileURL(require.resolve("@playwright/test")).href)};
const { test } = playwrightTest;
import { writeFile } from 'node:fs/promises';
test('no browser fixture', async () => { await writeFile(${JSON.stringify(marker)}, 'ran'); });`);
      const env = { ...process.env };
      delete env.TAROBIRD_TEST_DISPOSABLE_MAC;
      const result = spawnSync(process.execPath, [require.resolve("@playwright/test/cli"), "test", "--config", config, ...scenario.args], {
        cwd: client, env, encoding: "utf8", timeout: 20_000,
      });
      assert.ifError(result.error);
      const output = result.stdout + result.stderr;
      if (scenario.blocked && process.platform === "darwin") {
        assert.equal(result.status, 1, output);
        assert.match(output, /WebKit tests are blocked/);
        await assert.rejects(access(marker), { code: "ENOENT" });
      } else {
        assert.equal(result.status, 0, output);
        assert.equal(await readFile(marker, "utf8"), "ran");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
