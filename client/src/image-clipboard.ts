/** Clipboard image interchange uses PNG; exports still preserve the original file. */
export function canCopyImage(): boolean {
  return typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";
}

async function clipboardPng(blob: Blob): Promise<Blob> {
  if (blob.type.split(";")[0]?.toLowerCase() === "image/png") return blob;
  const url = URL.createObjectURL(blob), image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("image_copy_decode_failed")), 15_000);
      image.onload = () => { clearTimeout(timer); resolve(); };
      image.onerror = () => { clearTimeout(timer); reject(new Error("image_copy_decode_failed")); };
      image.src = url;
    });
    const width = image.naturalWidth, height = image.naturalHeight;
    if (!width || !height) throw new Error("image_copy_decode_failed");
    // Bound conversion memory without silently downscaling the copied image.
    if (width * height > 32_000_000 || Math.max(width, height) > 16_384) throw new Error("image_copy_too_large");
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    try {
      const context = canvas.getContext("2d");
      if (!context) throw new Error("image_copy_decode_failed");
      context.drawImage(image, 0, 0);
      return await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("image_copy_decode_failed")), "image/png"));
    } finally { canvas.width = 0; canvas.height = 0; }
  } finally { image.onload = null; image.onerror = null; image.src = ""; URL.revokeObjectURL(url); }
}

/** Call synchronously inside the click/key event. WebKit needs the clipboard
 * write before user activation ends, so PNG conversion is the item's promise. */
export async function copyImage(blob: Blob): Promise<void> {
  if (!canCopyImage()) throw new Error("image_copy_unavailable");
  const png = clipboardPng(blob);
  // A denied write may reject before the browser consumes the representation.
  void png.catch(() => undefined);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
