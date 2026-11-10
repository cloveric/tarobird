/** Test-harness policy only. Temporary browser profiles do not isolate the
 * macOS login keychain used by WebKit to serialize CryptoKeys. */
export function assertWebKitTestEnvironment(browserName, {
  platform = process.platform, env = process.env,
} = {}) {
  if (platform !== "darwin" || browserName !== "webkit") return;
  if (env.TAROBIRD_TEST_DISPOSABLE_MAC === "1") return;
  throw new Error(
    "WebKit tests are blocked on a personal Mac before launching the browser: " +
    "persisting CryptoKeys may open repeated Playwright WebCrypto Master Key prompts. " +
    "Run Chromium locally or use a disposable macOS test runner. " +
    "Only on that isolated runner, set TAROBIRD_TEST_DISPOSABLE_MAC=1. " +
    "Do not grant, delete or reset the owner's keychain to run tests. " +
    "See docs/client/playwright-keychain-isolation.md.",
  );
}

// The resolved config also includes projects created by --browser webkit/all.
// Keep browser selection in project configuration, never in spec-level use().
export default function guardBrowserTests(config) {
  for (const project of config.projects) {
    assertWebKitTestEnvironment(project.use.browserName ?? project.use.defaultBrowserType ?? "chromium");
  }
}
