import { describe, expect, it } from "vitest";
import { buildDesignSandbox, designAssets } from "../design-assets.js";

describe("browser Design sandbox resources", () => {
  it("slides excludes the standalone sharing module from browser resources", () => {
    const html = buildDesignSandbox("slides");
    const marker = "DesignRuntime.startDesignRuntime(";
    const start = html.lastIndexOf(marker) + marker.length;
    const resources = JSON.parse(html.slice(start, html.indexOf(",()=>{", start)));
    expect(Object.keys(resources)).not.toContain("share-ui.js");
  }, 30_000);

  // The old editor's "Draft ready / Sent to Bot" footnote patch went with that
  // editor (#90). What the new adapter guarantees is the toast: sending a
  // comment thread to the Bot opens a draft, and is not described as delivered.
  it("slides describes Send to Bot as a draft the user still has to send", () => {
    const html = buildDesignSandbox("slides");
    expect(html).not.toContain("function _v(A,e){return e===!1?{title:`Sent to ${A}`");
    expect(html).toContain('function _v(A){return{title:"Added to your message to the agent. Send it when you’re ready."');
  }, 30_000);
  it("refuses building the removed canvas sandbox", () => {
    expect(() => buildDesignSandbox("canvas" as never)).toThrow(/design_canvas_removed/);
  });

  it("slides bundles Apache-2.0 editor as a self-contained single bundle without external workers", () => {
    const html = buildDesignSandbox("slides");
    const marker = "DesignRuntime.startDesignRuntime(";
    const start = html.lastIndexOf(marker) + marker.length;
    const resources = JSON.parse(html.slice(start, html.indexOf(",()=>{", start)));
    expect(Object.keys(resources).filter(name => /worker-.*\.js$/.test(name))).toEqual([]);
    expect(html).toContain("openartifact");
    expect(html).not.toContain("__baoyuSave");
  }, 30_000);

  it("emits only the Apache-2.0 slides editor with its attribution files", () => {
    const files: string[] = [];
    const hook = designAssets().generateBundle!;
    const generate = typeof hook === "function" ? hook : hook.handler;
    generate.call({ emitFile: (file: { fileName: string }) => files.push(file.fileName) } as never, {} as never, {}, false);
    expect(files.filter(name => name.endsWith("-sandbox.html"))).toEqual(["slides-sandbox.html"]);
    expect(files.some(name => name.includes("baoyu-design"))).toBe(false);
    expect(files).toContain("licenses/workbench-slides/LICENSE");
    expect(files).toContain("licenses/workbench-slides/NOTICE");
    expect(files).toContain("licenses/workbench-slides/UPSTREAM.json");
    // Notices for what the bundle compiles in (React, Inter, the wasm crates…) travel with it.
    expect(files).toContain("licenses/workbench-slides/THIRD-PARTY-NOTICES.txt");
    expect(files.some(name => /baoyu-(?:slides|motion|dashboard|design-system)/.test(name))).toBe(false);
  }, 30_000);
});
