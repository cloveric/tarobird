import { createContext } from "react";
import type { Block, CardElement } from "../../src/client-protocol/index.js";

export type GalleryImage = { id: string; title?: string };
export const ImageGalleryContext = createContext<readonly GalleryImage[]>([]);

/** Native galleries and legacy alternating captions, never arbitrary form text. */
export function galleryImages(elements: readonly CardElement[]): GalleryImage[] | undefined {
  const images: GalleryImage[] = []; let caption: string | undefined;
  for (const element of elements) {
    if (element.type === "markdown" && caption === undefined) caption = element.text;
    else if (element.type === "image" && element.attachmentId) {
      images.push({ id: element.attachmentId, title: caption ?? element.text }); caption = undefined;
    } else return undefined;
  }
  return caption === undefined && images.length ? images : undefined;
}

/** Scope browsing to authenticated image attachments in this one message. */
export function messageImages(blocks: readonly Block[]): GalleryImage[] {
  const images: GalleryImage[] = [], seen = new Set<string>();
  const add = (image: GalleryImage) => { if (!seen.has(image.id)) { seen.add(image.id); images.push(image); } };
  const visit = (elements: readonly CardElement[]) => {
    const gallery = galleryImages(elements);
    if (gallery) { gallery.forEach(add); return; }
    for (const element of elements) {
      if (element.type === "image" && element.attachmentId) add({ id: element.attachmentId, title: element.text });
      if (element.children) visit(element.children);
    }
  };
  for (const block of blocks) {
    if (block.type === "image") add({ id: block.attachmentId, title: block.title });
    else if (block.type === "card") visit(block.elements);
  }
  return images;
}
