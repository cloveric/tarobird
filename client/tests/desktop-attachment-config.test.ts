import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("lets the WebView deliver scoped HTML file drops without granting filesystem access", async () => {
  const config = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  expect(config.app.windows.find((window: { label: string }) => window.label === "main").dragDropEnabled).toBe(false);
  for (const directive of ["base-uri 'none'", "form-action 'none'", "object-src 'none'", "worker-src 'self'"]) expect(config.app.security.csp).toContain(directive);
});
