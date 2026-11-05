// Hand-drawn brand art. Static imports let Vite hash and emit the files, so the
// offline service worker precaches them with the rest of the bundle.
import bear from "./brand/bear.png";
import cat from "./brand/cat.png";
import fox from "./brand/fox.png";
import lion from "./brand/lion.png";
import panda from "./brand/panda.png";
import penguin from "./brand/penguin.png";
import rabbit from "./brand/rabbit.png";
import raccoon from "./brand/raccoon.png";
import tiger from "./brand/tiger.png";

export type BrandArt = "lion" | Companion;
export type Companion = "fox" | "raccoon" | "panda" | "rabbit" | "penguin" | "bear" | "cat" | "tiger";

// The lion is TaroCub itself; Bots without a custom picture get a companion.
const companions: readonly Companion[] = ["fox", "raccoon", "panda", "rabbit", "penguin", "bear", "cat", "tiger"];
const art: Record<BrandArt, string> = { lion, fox, raccoon, panda, rabbit, penguin, bear, cat, tiger };

export const brandAsset = (name: BrandArt) => art[name];

/** Stable FNV-1a choice, so a Bot keeps the same companion on every device. */
export function companionFor(id: string): Companion {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { hash ^= id.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return companions[(hash >>> 0) % companions.length]!;
}
