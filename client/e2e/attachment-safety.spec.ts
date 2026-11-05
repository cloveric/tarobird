import { test, expect } from "@playwright/test";
import { attachmentFilename, previewAttachment } from "../src/attachment-export.js";
import { readFile } from "node:fs/promises";

test("generic media attachments recover a playable type without treating active content as a document", async () => {
  const bytes = await readFile("e2e/fixtures/media/clip.mp4");
  for (const type of ["", "application/octet-stream", "application/octet-stream; charset=binary"]) {
    const blob = new Blob([bytes], { type });
    const preview = await previewAttachment(blob, "视频_720p.MP4");
    expect(preview.kind).toBe("video");
    if (preview.kind === "video") {
      expect(preview.blob.type).toBe("video/mp4");
      expect(Buffer.from(await preview.blob.arrayBuffer())).toEqual(bytes);
      expect(blob.type).toBe(type); // Preview normalization never mutates the saved original.
    }
  }
  const html = "<script>window.previewExecuted=true</script>";
  expect(await previewAttachment(new Blob([html], { type: "text/html" }), "fake.mp4"))
    .toEqual({ kind: "text", text: html, truncated: false });
  for (const name of ["fake.svg", "fake.html"]) expect((await previewAttachment(new Blob([html]), name)).kind).toBe("text");
  for (const name of ["fake.mp4.exe", "fake.mp4/unknown", "unknown.bin", "file.constructor"]) expect((await previewAttachment(new Blob([html]), name)).kind).toBe("unsupported");
});

test("attachment names cannot escape a selected directory and executable text never becomes HTML", async () => {
  expect(attachmentFilename("../../CON.txt")).toBe("_CON.txt");
  expect(attachmentFilename("CON .txt")).toBe("_CON.txt");
  expect(attachmentFilename(".env")).toBe(".env");
  expect(attachmentFilename("C:\\Users\\someone\\a\u202eb.html")).toBe("a_b.html");
  expect(attachmentFilename("... ")).toBe("attachment");
  expect(attachmentFilename("a".repeat(159) + ".txt")).toBe("a".repeat(156) + ".txt");
  expect(attachmentFilename("a".repeat(159) + " name.txt")).toBe("a".repeat(156) + ".txt");
  expect(attachmentFilename("a".repeat(159) + "🦁.txt")).toBe("a".repeat(156) + ".txt");
  expect(attachmentFilename("a".repeat(158) + "🦁.txt")).toBe("a".repeat(156) + ".txt");
  expect(attachmentFilename("文".repeat(100) + ".txt")).toBe("文".repeat(78) + ".txt");
  const html = new Blob(["<script>alert(1)</script>"], { type: "text/html" });
  expect(await previewAttachment(html, "fake.pdf")).toEqual({ kind: "text", text: "<script>alert(1)</script>", truncated: false });
  expect(await previewAttachment(new Blob(["<script>alert(1)</script>"], { type: "application/pdf" }), "fake.pdf")).toEqual({ kind: "unsupported" });
  const pdf = await previewAttachment(new Blob(["%PDF-1.7"], { type: "text/html" }), "real.pdf");
  expect(pdf.kind).toBe("pdf"); if (pdf.kind === "pdf") expect(pdf.blob.type).toBe("application/pdf");
  const large = await previewAttachment(new Blob(["a".repeat(2 * 1024 * 1024)]), "large.txt");
  expect(large.kind).toBe("text"); if (large.kind === "text") { expect(large.text.length).toBe(1024 * 1024); expect(large.truncated).toBe(true); }
});

test("long saved attachment labels preserve the complete extension within filesystem limits", () => {
  for (const name of ["a".repeat(158) + ".pdf", "文".repeat(100) + ".pdf", "🦁".repeat(100) + ".pdf", "CON." + "文".repeat(100) + ".pdf"]) {
    const saved = attachmentFilename(name);
    expect(saved.endsWith(".pdf")).toBe(true);
    expect(Buffer.byteLength(saved)).toBeLessThanOrEqual(240);
    expect(saved.length).toBeLessThanOrEqual(160);
    expect(saved).not.toMatch(/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i);
  }
});
