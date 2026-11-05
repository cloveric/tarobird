import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { zipSync, unzipSync, strToU8 } from "../client/node_modules/fflate/esm/browser.js";
import { boundedDocxArchive, DOCX_MAX_BYTES } from "../client/src/docx-archive.js";

describe("bounded local document archives", () => {
  it("reconstructs a real DOCX without changing its document or image bytes", () => {
    const input = readFileSync(new URL("../client/e2e/fixtures/documents/reading.docx", import.meta.url));
    expect(unzipSync(new Uint8Array(boundedDocxArchive(input)))).toEqual(unzipSync(input));
  });
  it("rejects unsupported, damaged and oversized files", () => {
    for (const bytes of [strToU8("not a zip"), new Uint8Array(DOCX_MAX_BYTES + 1), zipSync({ "note.txt": strToU8("hello") })]) expect(() => boundedDocxArchive(bytes)).toThrow();
  });
  it("bounds actual expansion before the Word converter sees compressed bombs", () => {
    const bomb = zipSync({ "word/document.xml": new Uint8Array(17 * 1024 * 1024), "[Content_Types].xml": strToU8("x") });
    expect(bomb.length).toBeLessThan(100_000);
    expect(() => boundedDocxArchive(bomb)).toThrow("large");
    // Lie in both local and central size fields; actual output is still bounded.
    const view = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength);
    for (let i = 0; i < bomb.length - 28; i++) {
      const sig = view.getUint32(i, true);
      if (sig === 0x04034b50) view.setUint32(i + 22, 1, true);
      if (sig === 0x02014b50) view.setUint32(i + 24, 1, true);
    }
    expect(() => boundedDocxArchive(bomb)).toThrow("large");
  });
});
