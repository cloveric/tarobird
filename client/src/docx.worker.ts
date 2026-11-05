import mammoth from "mammoth";
import { boundedDocxArchive } from "./docx-archive.js";

self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  try {
    const arrayBuffer = boundedDocxArchive(new Uint8Array(event.data));
    let imageBytes = 0, imageCount = 0;
    const result = await mammoth.convertToHtml({ arrayBuffer }, {
      externalFileAccess: false, includeEmbeddedStyleMap: false, idPrefix: "docx-",
      convertImage: mammoth.images.imgElement(async image => {
        if (!/^image\/(png|jpeg|gif|webp)$/.test(image.contentType) || ++imageCount > 40) return { src: "" };
        // A missing/external image must not hide the rest of a readable file.
        const bytes = await image.readAsBase64String().catch(() => ""); imageBytes += bytes.length;
        if (!bytes) return { src: "" };
        if (bytes.length > 3 * 1024 * 1024 || imageBytes > 12 * 1024 * 1024) throw new Error("large");
        return { src: `data:${image.contentType};base64,${bytes}` };
      }),
    });
    if (result.value.length > 16 * 1024 * 1024 || result.value.replace(/src="data:[^"]*"/g, "").length > 2 * 1024 * 1024 || (result.value.match(/<[^/!]/g)?.length ?? 0) > 20_000) throw new Error("large");
    self.postMessage({ html: result.value });
  } catch (error) { self.postMessage({ error: error instanceof Error && error.message === "large" ? "large" : "invalid" }); }
};
