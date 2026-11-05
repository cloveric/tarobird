import { fileURLToPath } from 'node:url';

/** Windows owns the overlay position/size. Supply a 16-DIP image with crisp
 * scale representations, retaining a small clear edge around the red circle. */
export function windowsUnreadBadge(nativeImage) {
  let atlas, previousLabel, previousImage;
  return count => {
    if (count === 0) return null;
    const label = Math.min(count, 100);
    if (previousLabel === label) return previousImage;
    atlas ??= nativeImage.createFromPath(fileURLToPath(new URL('./windows-unread-badges.png', import.meta.url)));
    const size = atlas.getSize();
    if (atlas.isEmpty() || size.width !== 640 || size.height !== 640) throw new Error('taskbar_badge_asset_invalid');
    const index = label - 1;
    const tile = atlas.crop({ x: index % 10 * 64, y: Math.floor(index / 10) * 64, width: 64, height: 64 });
    const image = nativeImage.createEmpty();
    for (const scaleFactor of [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]) {
      const pixels = 16 * scaleFactor;
      image.addRepresentation({ scaleFactor, buffer: tile.resize({ width: pixels, height: pixels, quality: 'best' }).toPNG() });
    }
    previousLabel = label; previousImage = image;
    return image;
  };
}
