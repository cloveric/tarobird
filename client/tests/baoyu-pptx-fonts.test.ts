import { createRequire } from "node:module";
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";

// Exercise the pinned exporter itself: a valid ZIP alone cannot show whether
// PowerPoint was told to use a font containing the East Asian text.
const require = createRequire(import.meta.url);
const { runtime } = require("../vendor/baoyu-slides/editor/node/compiler.cjs");
const samples = [
  { text: "中文 English 123", face: "Arial", expected: "Microsoft YaHei" },
  { text: "繁體中文 English", face: "Noto Sans TC", expected: "Microsoft JhengHei" },
  { text: "日本語かな English", face: "Arial", expected: "Yu Gothic" },
  { text: "한국어 English", face: "Arial", expected: "Malgun Gothic" },
  { text: "English only 123", face: "Arial", expected: "Arial" },
];
async function exportedSlides(forGoogleSlides = false): Promise<string[]> {
  const deck = {
    title: "Multilingual export regression",
    slides: samples.map(sample => ({ bg: "#ffffff", leaves: [{
      kind: "text", role: "body", text: sample.text,
      fontFamily: { family: sample.face, fallback: "sans-serif" },
      rect: { x: 60, y: 60, w: 900, h: 90 }, color: "#000000",
    }] })),
  };
  const { blob, warnings } = await runtime.exportPptxBlob(deck, { forGoogleSlides });
  expect(warnings).toEqual([]);
  const archive = new AdmZip(Buffer.from(await blob.arrayBuffer()));
  return samples.map((_sample, index) => archive.readAsText(`ppt/slides/slide${index + 1}.xml`));
}

describe("Baoyu PPTX East Asian font fallback", () => {
  it("names a matching East Asian face without changing the Latin face or text", async () => {
    const slides = await exportedSlides();
    samples.forEach((sample, index) => {
      expect(slides[index]).toContain(sample.text);
      expect(slides[index]).toContain(`<a:latin typeface="${sample.face}"`);
      expect(slides[index]).toContain(`<a:ea typeface="${sample.expected}"`);
    });
  }, 30_000);

  it("preserves the selected face for Google Slides export", async () => {
    const slides = await exportedSlides(true);
    samples.forEach((sample, index) => {
      expect(slides[index]).toContain(sample.text);
      expect(slides[index]).toContain(`<a:ea typeface="${sample.face}"`);
    });
  }, 30_000);
});
