import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempRoot } from "./helpers/temp-files.js";
import { prepareAttachmentWorkflow } from "../src/runtime/file-workflow.js";

const pdf = vi.hoisted(() => ({ getText: vi.fn(), destroy: vi.fn() }));
vi.mock("pdf-parse", () => ({
  PDFParse: class {
    getText = pdf.getText;
    destroy = pdf.destroy;
  },
}));

describe("PDF attachment resources", () => {
  afterEach(() => vi.resetAllMocks());

  for (const outcome of ["success", "parse-failure", "cleanup-failure"] as const) {
    it(`releases the parser after ${outcome} without losing the attachment`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "tarobot-pdf-cleanup-"));
      try {
        const localPath = path.join(root, "document.pdf");
        await writeFile(localPath, "%PDF-1.7 fixture");
        if (outcome === "parse-failure") pdf.getText.mockRejectedValue(new Error("damaged PDF"));
        else pdf.getText.mockResolvedValue({ text: "  Extracted document text  " });
        if (outcome === "cleanup-failure") pdf.destroy.mockRejectedValue(new Error("worker already closed"));
        else pdf.destroy.mockResolvedValue(undefined);

        const result = await prepareAttachmentWorkflow({
          stateDir: path.join(root, "state"), chatId: 101, userId: 202, text: "Read this document",
          downloadedAttachments: [{ localPath, attachment: { kind: "document", fileId: "pdf", fileName: "document.pdf" } }],
        });

        expect(pdf.destroy).toHaveBeenCalledOnce();
        expect(result?.kind).toBe("direct");
        expect(result?.text).toContain(outcome === "parse-failure"
          ? "PDF text extraction unavailable" : "Extracted document text");
        if (result?.kind === "direct") expect(result.files).toHaveLength(1);
      } finally {
        await removeTempRoot(root);
      }
    });
  }
});
