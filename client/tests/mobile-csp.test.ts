import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { MOBILE_CSP, mobileCspHtml, protectMobileCopy } from "../scripts/mobile-csp.mjs";

const index = await readFile(new URL("../index.html", import.meta.url), "utf8");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it("permits Capacitor's web hook without rewriting browser assets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mobile-csp-")); roots.push(root);
  await writeFile(path.join(root, "index.html"), index);
  await protectMobileCopy(root, "web");
  expect(await readFile(path.join(root, "index.html"), "utf8")).toBe(index);
  await expect(protectMobileCopy(root, undefined)).rejects.toThrow("platform_required");
});
it("ships a passive-media policy before any App resources and restricts native scripts/network", () => {
  const html = mobileCspHtml(index);
  expect(html).toContain(`content="${MOBILE_CSP}"`);
  expect(html.indexOf('id="tarobot-csp"')).toBeLessThan(html.indexOf('<link'));
  expect(html.indexOf('id="tarobot-csp"')).toBeLessThan(html.indexOf('<script'));
  expect(html).toContain("connect-src 'self';"); expect(html).toContain("script-src 'self';");
  expect(html).toContain("worker-src 'self';"); expect(html).toContain("img-src 'self' data: blob:;");
  expect(html).not.toContain("unsafe-eval"); expect(mobileCspHtml(html)).toBe(html);
  expect(() => mobileCspHtml('<head><script src="app.js"></script></head>')).toThrow("mobile_csp_marker");
  expect(() => mobileCspHtml(index.replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="img-src *">'))).toThrow("ambiguous");
});
it.each(["android", "ios"])("hardens the actual %s copy destination without changing the browser build", async platform => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mobile-csp-")); roots.push(root);
  const target = path.join(root, platform, platform === "android" ? "app/src/main/assets/public/index.html" : "App/App/public/index.html");
  await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, index);
  await mkdir(path.join(root, "dist")); await writeFile(path.join(root, "dist/index.html"), index);
  await protectMobileCopy(root, platform);
  expect(await readFile(target, "utf8")).toBe(mobileCspHtml(index));
  expect(await readFile(path.join(root, "dist/index.html"), "utf8")).toBe(index);
  await expect(protectMobileCopy(root, platform, { server: { url: "https://remote.example" } })).rejects.toThrow("bundled_assets");
});
