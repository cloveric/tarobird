import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { excalidrawAssets, removeExcalidrawFontFallback, localizeExcalidrawViewportOffsets } from "../excalidraw-assets.js";

const directory = fileURLToPath(new URL("../node_modules/@excalidraw/excalidraw/dist/", import.meta.url));
function source(mode: "dev" | "prod") {
  const files = readdirSync(join(directory, mode)).filter(name => name.endsWith(".js"));
  const found = files.map(name => ({ id: join(directory, mode, name), code: readFileSync(join(directory, mode, name), "utf8") })).filter(({ code }) => /\w+\.push\(new URL\(\w+,\s*\w+\.ASSETS_FALLBACK_URL\)\)/.test(code));
  expect(found).toHaveLength(1); return found[0];
}
describe("self-hosted Excalidraw package assets", () => {
  for (const mode of ["dev", "prod"] as const) it(`removes exactly the pinned ${mode} external font fallback and fails on drift`, () => {
    const code = source(mode).code;
    expect(removeExcalidrawFontFallback(code)).not.toMatch(/\w+\.push\(new URL\(\w+,\s*\w+\.ASSETS_FALLBACK_URL\)\)/);
    expect(() => removeExcalidrawFontFallback("new upstream shape")).toThrow("font_fallback_contract_changed");
    expect(() => removeExcalidrawFontFallback(code + code)).toThrow("font_fallback_contract_changed");
  });
  for (const mode of ["dev", "prod"] as const) it(`keeps ${mode} fit offsets local at any embedded position, including RTL sidebars`, () => {
    const code = readFileSync(join(directory, mode, "index.js"), "utf8"), patched = localizeExcalidrawViewportOffsets(code);
    const transform = excalidrawAssets().transform as Function;
    expect(transform.call({}, code, join(directory, mode, "index.js") + "?v=dev-cache").code).toContain("_tarobotViewportRect");
    const body = /"getEditorUIOffsets",\s*\(\)\s*=>\s*\{([\s\S]*?)\}\);?(?=\s*(?:\/\/ Input handling\s*)?(?:__publicField|C)\(this,\s*"onKeyDown")/.exec(patched)![1];
    const language = /return\s+(\w+)\(\)\.rtl/.exec(body)![1];
    for (const rtl of [false, true]) for (const panels of [false, true]) {
      const getter = new Function(language, `return function(){${body}}`)(() => ({ rtl }));
      const read = (left: number, top: number) => {
        const rect = (x: number, y: number, width: number, height: number) => ({ left: left + x, top: top + y, right: left + x + width, bottom: top + y + height, width, height });
        const elements: Record<string, ReturnType<typeof rect>> = { ".App-toolbar": rect(250, 12, 450, 44) };
        if (panels) { elements[".sidebar"] = rect(rtl ? 0 : 806, 0, 180, 243); elements[".App-menu__left"] = rect(rtl ? 786 : 0, 56, 200, 160); }
        return getter.call({ state: { width: 986, height: 243 }, excalidrawContainerRef: { current: { getBoundingClientRect: () => rect(0, 0, 986, 243), querySelector: (selector: string) => elements[selector] ? { getBoundingClientRect: () => elements[selector] } : undefined } } });
      };
      expect(read(1288, 559.5)).toEqual(read(0, 0));
      expect(read(1288, 559.5)).toMatchObject({ top: 72, bottom: 16 });
      expect(read(1288, 559.5)).toMatchObject(panels ? { left: rtl ? 196 : 216, right: rtl ? 216 : 196 } : { left: 16, right: 16 });
    }
    expect(() => localizeExcalidrawViewportOffsets(code + code)).toThrow("viewport_offsets_contract_changed");
    expect(() => localizeExcalidrawViewportOffsets(code.replace('querySelector(".App-toolbar")', 'querySelector(".different-toolbar")'))).toThrow("viewport_offsets_contract_changed");
  });
  it("distributes every browser font with unmodified bytes, provenance and license notices", () => {
    const plugin = excalidrawAssets(), assets: { fileName: string; source: string | Uint8Array }[] = [];
    const context = { emitFile: (value: { fileName: string; source: string | Uint8Array }) => { assets.push(value); return value.fileName; } };
    const input = source("prod");
    (plugin.transform as Function).call(context, input.code, input.id);
    const viewportId = join(directory, "prod", "index.js");
    if (input.id !== viewportId) (plugin.transform as Function).call(context, readFileSync(viewportId, "utf8"), viewportId);
    (plugin.generateBundle as Function).call(context, {}, {});
    const fonts = assets.filter(asset => asset.fileName.endsWith(".woff2")); expect(fonts).toHaveLength(233);
    expect(fonts.some(asset => asset.fileName.includes("/Liberation/"))).toBe(false);
    const provenance = assets.find(asset => asset.fileName.endsWith("/provenance.json")); expect(provenance).toBeTruthy();
    const manifest = JSON.parse(Buffer.from(provenance!.source).toString()) as { fonts: { file: string; bytes: number; sha256: string }[] };
    for (const item of manifest.fonts) {
      const asset = fonts.find(asset => asset.fileName.endsWith(`/fonts/${item.file}`)); expect(asset).toBeTruthy();
      expect(Buffer.byteLength(asset!.source)).toBe(item.bytes);
      expect(createHash("sha256").update(asset!.source).digest("hex")).toBe(item.sha256);
    }
    expect(assets.some(asset => asset.fileName.endsWith("/Excalidraw-LICENSE.txt"))).toBe(true);
    expect(assets.some(asset => asset.fileName.endsWith("/Xiaolai-OFL.txt"))).toBe(true);
  });
});
