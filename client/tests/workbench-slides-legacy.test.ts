import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDesignSandbox } from "../design-assets.js";
import { legacySlideText } from "../src/workbench-slides-legacy.js";

// The slide the 1.6.0 editor saved after "Shapes → Rounded rectangle": see e2e/fixtures/legacy-1.6.0/README.md.
const backup = JSON.parse(readFileSync(new URL("../e2e/fixtures/legacy-1.6.0/plain-deck.tarobot-design.json", import.meta.url), "utf8")) as { document: { files: Record<string, { base64: string }> } };
const stored = (path: string) => Buffer.from(backup.document.files[path]!.base64, "base64").toString("utf8");
const shape = (style: string) => `<x-shape kind="rect" id="a1" style="${style}"></x-shape>`;

describe("slides saved by the 1.6.0 editor, as handed to the presentation editor", () => {
  it("keeps a shape inserted from the 1.6.0 toolbar where 1.6.0 drew it", () => {
    const slide = stored("project/slides/shapes.html");
    const inserted = '<x-shape kind="rect" id="c92dab7c" style="position:absolute; top:50%; left:50%; width:300px; height:300px; background:#9aa0a6; border-radius:24px; transform:translate(-50%, -50%)"></x-shape>';
    expect(slide.match(/<x-shape kind="rect" id="[0-9a-f]+" style="position:absolute; top:50%; left:50%; width:300px; height:300px; background:#9aa0a6; border-radius:24px; transform:translate\(-50%, -50%\)"><\/x-shape>/)).toHaveLength(1);
    expect(legacySlideText(inserted)).toBe('<x-shape kind="rect" id="c92dab7c" style="position:absolute; top:calc(50% - 150px); left:calc(50% - 150px); width:300px; height:300px; background:#9aa0a6; border-radius:24px"></x-shape>');
    // In the real slide only that one tag changes; text, the table of the next slide and other shapes are byte-identical.
    const given = legacySlideText(slide), before = slide.split("\n"), after = given.split("\n");
    expect(after).toHaveLength(before.length);
    expect(after.filter((line, index) => line !== before[index])).toHaveLength(1);
    expect(given).toContain("top:calc(50% - 150px); left:calc(50% - 150px); width:300px; height:300px");
    expect(given).not.toContain("translate(");
    for (const path of Object.keys(backup.document.files).filter(path => path.startsWith("project/slides/") && path !== "project/slides/shapes.html")) expect(legacySlideText(stored(path)), path).toBe(stored(path));
    // A table the 1.6.0 toolbar inserted keeps its translateY: the presentation editor takes it on a table.
    expect(stored("project/slides/numbers.html")).toContain("transform:translateY(-50%)");
  });

  it("folds each translate form into left/top and keeps a rotation", () => {
    expect(legacySlideText(shape("position:absolute; top:120px; left:50%; width:200px; height:80px; transform:translateX(-50%)"))).toBe(shape("position:absolute; top:120px; left:calc(50% - 100px); width:200px; height:80px"));
    expect(legacySlideText(shape("position:absolute; top:50%; left:64px; width:200px; height:81px; transform:translateY(-50%)"))).toBe(shape("position:absolute; top:calc(50% - 40.5px); left:64px; width:200px; height:81px"));
    expect(legacySlideText(shape("position:absolute; top:400px; left:600px; width:200px; height:100px; transform:translate(-50%, -50%) rotate(45deg)"))).toBe(shape("position:absolute; top:350px; left:500px; width:200px; height:100px; transform:rotate(45deg)"));
    expect(legacySlideText(shape("position:absolute; top:calc(50% + 10px); left:calc(25% - 30px); width:100px; height:20px; transform:translate(-50%, -50%)"))).toBe(shape("position:absolute; top:50%; left:calc(25% - 80px); width:100px; height:20px"));
    expect(legacySlideText(shape("position:absolute; top:10px; left:20px; width:100px; height:20px; transform:translate(12px, -4px)"))).toBe(shape("position:absolute; top:6px; left:32px; width:100px; height:20px"));
    const twice = legacySlideText(legacySlideText(shape("position:absolute; top:50%; left:50%; width:300px; height:300px; transform:translate(-50%, -50%)")));
    expect(twice).toBe(shape("position:absolute; top:calc(50% - 150px); left:calc(50% - 150px); width:300px; height:300px"));
  });

  it("leaves alone what it cannot place exactly, and everything that is not a shape", () => {
    for (const style of [
      "position:absolute; top:50%; left:50%; width:300px; height:300px; transform:rotate(30deg)",
      "position:absolute; top:50%; left:50%; width:30%; height:300px; transform:translate(-50%, -50%)",
      "position:absolute; top:50%; right:40px; width:300px; height:300px; transform:translate(-50%, -50%)",
      "position:absolute; top:50%; left:50%; width:300px; height:300px; transform:translate(-50%, -50%) scale(1.5)",
      "position:absolute; top:50%; left:auto; width:300px; height:300px; transform:translateX(-50%)",
    ]) expect(legacySlideText(shape(style)), style).toBe(shape(style));
    const others = '<section id="s" style="padding:96px"><div style="position:absolute; top:50%; left:50%; transform:translate(-50%, -50%)"><p>translate(-50%, -50%) as text</p></div><img src="/_blob/0123456789abcdef0123456789abcdef" alt="" style="position:absolute; left:50%; transform:translateX(-50%)"><table style="position:absolute; top:50%; transform:translateY(-50%)"><tr><td>x-shape</td></tr></table></section>';
    expect(legacySlideText(others)).toBe(others);
  });

  it("is what the built editor frame applies to slide files it reads", () => {
    const html = buildDesignSandbox("slides");
    expect(html).toContain("legacySlideText");
    expect(html).toMatch(/project\\\/slides\\\/\[\^\/\]\+\\\.html/);
  }, 30_000);
});
