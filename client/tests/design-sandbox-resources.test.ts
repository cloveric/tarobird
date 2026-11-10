import { describe, expect, it } from "vitest";
import { buildDesignSandbox, designAssets } from "../design-assets.js";

describe("browser Design sandbox resources", () => {
  it.each(["canvas", "slides"] as const)("%s excludes the standalone sharing module from browser resources", format => {
    const html = buildDesignSandbox(format);
    const marker = "DesignRuntime.startDesignRuntime(";
    const start = html.lastIndexOf(marker) + marker.length;
    const resources = JSON.parse(html.slice(start, html.indexOf(",()=>{", start)));
    expect(Object.keys(resources)).not.toContain("share-ui.js");
  }, 30_000);
  it.each(["canvas", "slides"] as const)("%s labels chat acceptance without claiming the Bot is working", format => {
    const html = buildDesignSandbox(format);
    expect(html).not.toContain('Waiting for the agent');
    expect(html).toMatch(/footnote:[A-Za-z]+==="queued"\?"Draft ready":"Sent to Bot"/);
  }, 30_000);
  it("keeps the PPTX Node compiler out of the iframe while retaining its browser decoder", () => {
    const html = buildDesignSandbox("slides");
    const marker = "DesignRuntime.startDesignRuntime(";
    const start = html.lastIndexOf(marker) + marker.length;
    const resources = JSON.parse(html.slice(start, html.indexOf(",()=>{", start)));
    expect(Object.keys(resources).filter(name => name.startsWith("node/"))).toEqual([]);
    expect(Object.keys(resources).some(name => /^assets\/woff2-decoder-.*\.js$/.test(name))).toBe(true);
  }, 30_000);

  it("emits only the canvas and PPT editors with their attribution files", () => {
    const files: string[] = [];
    const hook = designAssets().generateBundle!;
    const generate = typeof hook === "function" ? hook : hook.handler;
    generate.call({ emitFile: (file: { fileName: string }) => files.push(file.fileName) } as never, {} as never, {}, false);
    expect(files.filter(name => name.endsWith("-sandbox.html"))).toEqual(["design-sandbox.html", "slides-sandbox.html"]);
    expect(files).toContain("licenses/baoyu-design/NOTICE.md");
    expect(files).toContain("licenses/baoyu-slides/third-party-licenses.txt");
    expect(files.some(name => /baoyu-(?:motion|dashboard|design-system)/.test(name))).toBe(false);
  }, 30_000);
});
