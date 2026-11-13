/** Test-harness reminder only. Temporary browser profiles do not isolate the
 * macOS login keychain used by WebKit to serialize CryptoKeys. */
export function warnWebKitTestEnvironment(browserName, {
  platform = process.platform, warn = console.warn,
} = {}) {
  if (platform !== "darwin" || browserName !== "webkit") return;
  warn(
    "WebKit tests are allowed on this Mac. Reminder: persisting CryptoKeys " +
    "may open Playwright WebCrypto Master Key permission prompts. " +
    "A temporary browser profile does not isolate the login keychain. " +
    "This reminder does not block the run or change keychain permissions. " +
    "See docs/client/playwright-keychain-isolation.md.",
  );
}

// Retain the existing import for standalone probes; it now only warns.
export const assertWebKitTestEnvironment = warnWebKitTestEnvironment;

// The resolved config also includes projects created by --browser webkit/all.
// Warn once for a mixed run; Chromium/Firefox-only runs remain quiet.
export default function remindBrowserTests(config) {
  if (config.projects.some(project =>
    (project.use.browserName ?? project.use.defaultBrowserType ?? "chromium") === "webkit")) {
    warnWebKitTestEnvironment("webkit");
  }
}
