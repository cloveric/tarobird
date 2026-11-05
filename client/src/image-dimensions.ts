import type { HubConnection } from "./connection.js";

export type ImageDimensions = { width: number; height: number };
export const MAX_IMAGE_DIMENSIONS = 512;
// Virtual rows release their images and object URLs. Keep only a bounded amount
// of decoded geometry, scoped to the authenticated connection, for remounts.
const dimensions = new WeakMap<HubConnection, Map<string, ImageDimensions>>();
const listeners = new WeakMap<HubConnection, Map<string, Set<() => void>>>();

export function subscribeImageDimensions(connection: HubConnection, id: string, notify: () => void): () => void {
  let host = listeners.get(connection);
  if (!host) { host = new Map(); listeners.set(connection, host); }
  let current = host.get(id);
  if (!current) { current = new Set(); host.set(id, current); }
  current.add(notify);
  return () => { current.delete(notify); if (!current.size) host.delete(id); };
}

export function imageDimensions(connection: HubConnection, id: string): ImageDimensions | undefined {
  const cache = dimensions.get(connection), value = cache?.get(id);
  if (value) { cache!.delete(id); cache!.set(id, value); }
  return value;
}

export function rememberImageDimensions(connection: HubConnection, id: string, size: ImageDimensions) {
  if (![size.width, size.height].every(value => Number.isFinite(value) && value > 0)) return;
  let cache = dimensions.get(connection);
  if (!cache) { cache = new Map(); dimensions.set(connection, cache); }
  const prior = cache.get(id);
  if (prior?.width === size.width && prior.height === size.height) return;
  cache.delete(id); cache.set(id, { width: size.width, height: size.height });
  if (cache.size > MAX_IMAGE_DIMENSIONS) {
    const evicted = cache.keys().next().value!; cache.delete(evicted);
    listeners.get(connection)?.get(evicted)?.forEach(notify => notify());
  }
  // Other mounted lazy images may have read the cache before this decode.
  // Publish geometry to those rows too, before they enter the viewport.
  listeners.get(connection)?.get(id)?.forEach(notify => notify());
}

/** Empty, intrinsic-size reservation; never an exported or previewable image. */
export function imageReservation(size: ImageDimensions): string {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}"/>`)}`;
}
