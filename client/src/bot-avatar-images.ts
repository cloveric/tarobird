import type { BotAvatar } from "./bot-avatar-catalog.js";

// Transparent cutouts of the owner's mascot sheets, split by scripts/crop-bot-mascots.py.
// Separate URLs keep the images out of JS while Vite includes them in the offline
// shell and native packages. The editor still saves a standard 256px PNG.
const images = import.meta.glob<string>("./assets/bot-mascots/*.webp", { eager: true, query: "?url&no-inline", import: "default" });
export function botAvatarImage(avatar: BotAvatar) {
  return {
    url: images[`./assets/bot-mascots/${avatar.id}.webp`]!,
    width: 256, height: 256, x: 0, y: 0, edge: 256,
  };
}
