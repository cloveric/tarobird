import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { warnWebKitTestEnvironment, assertWebKitTestEnvironment } from "./playwright-keychain-guard.mjs";

const client = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
// The root package retains the TypeScript parser API used by repository tools.
const ts = createRequire(new URL("../../package.json", import.meta.url))("typescript-api");

test("macOS WebKit warns and continues without a runner opt-in", () => {
  const warnings = [];
  assert.doesNotThrow(() => warnWebKitTestEnvironment("webkit", {
    platform: "darwin", warn: message => warnings.push(message),
  }));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /WebKit tests are allowed/);
  assert.match(warnings[0], /does not block the run/);
});

test("the standalone legacy export also only warns", () => {
  assert.equal(assertWebKitTestEnvironment, warnWebKitTestEnvironment);
});

test("Chromium, Firefox and non-Mac WebKit remain quiet", () => {
  for (const [platform, browserName] of [["darwin", "chromium"], ["darwin", "firefox"], ["linux", "webkit"], ["win32", "webkit"]]) {
    const warnings = [];
    assert.doesNotThrow(() => warnWebKitTestEnvironment(browserName, { platform, warn: message => warnings.push(message) }));
    assert.deepEqual(warnings, []);
  }
});

function checkBrowserSelection(text, file) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = node => {
      const call = node.parent?.parent;
      const fixtureOptions = call && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && ["use", "extend"].includes(call.expression.name.text);
      if (ts.isPropertyAssignment(node) || (ts.isShorthandPropertyAssignment(node) && fixtureOptions)) {
        const name = ts.isComputedPropertyName(node.name) ? node.name.expression : node.name;
        if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
          assert.ok(!["browserName", "defaultBrowserType"].includes(name.text), `${file}: select browsers in project config so CLI selection remains reliable`);
        }
      }
      if (ts.isImportDeclaration(node) && /^(?:@playwright\/test|playwright(?:-core)?)$/.test(node.moduleSpecifier.text)) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
          assert.ok(!["webkit", "devices"].includes((binding.propertyName ?? binding.name).text), `${file}: select WebKit/devices in project config`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
}

test("browser-selection regression catches shorthand, device and direct WebKit imports", () => {
  for (const source of ["test.use({browserName})", "test.use({['browserName']: 'webkit'})",
    "import { devices as phones } from '@playwright/test'; test.use({...phones['iPhone 15']})",
    "import { webkit as browser } from 'playwright'; browser.launch()",
  ]) assert.throws(() => checkBrowserSelection(source, "fixture.ts"));
});

test("specs and browser scripts leave browser selection to project configuration", async () => {
  for (const directory of [path.join(client, "e2e"), path.join(client, "scripts"), path.join(client, "visual-baseline"), path.join(client, "../assets/product")]) {
    const files = await readdir(directory, { recursive: true });
    for (const file of files.filter(file => /\.(?:ts|m?js)$/.test(file))) {
      checkBrowserSelection(await readFile(path.join(directory, file), "utf8"), path.join(directory, file));
    }
  }
});

// These probe tests do not request page/browser fixtures: they only write a marker and verify warning-only setup, without starting
// WebKit or accessing the login keychain.
for (const scenario of [
  { name: "Chromium", config: "playwright.config.ts", args: [], warns: false },
  { name: "WebKit config", config: "playwright.webkit.config.ts", args: [], warns: true },
  { name: "CLI WebKit", config: "playwright.config.ts", args: ["--browser=webkit"], warns: true },
  { name: "CLI all browsers", config: "playwright.config.ts", args: ["--browser=all"], warns: true },
]) {
  test(`real CLI: ${scenario.name} continues past the keychain reminder`, { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tarobird-browser-guard-"));
    try {
      const marker = path.join(directory, "worker-ran");
      const config = path.join(directory, "probe.config.mjs");
      const spec = path.join(directory, "probe.spec.mjs");
      await writeFile(config, `import base from ${JSON.stringify(pathToFileURL(path.join(client, scenario.config)).href)};
if (base.globalSetup !== ${JSON.stringify(path.join(client, "scripts/playwright-keychain-guard.mjs"))}) throw new Error('Repository keychain reminder must be registered');
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
      assert.equal(result.status, 0, output);
      assert.equal(await readFile(marker, "utf8"), "ran");
      if (scenario.warns && process.platform === "darwin") assert.match(output, /WebKit tests are allowed/);
      else assert.doesNotMatch(output, /WebKit tests are allowed/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
