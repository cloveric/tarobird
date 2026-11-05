import type { CoreChannelLike } from "./types.js";
export async function uploadCoreImageKey(channel: CoreChannelLike, body: Buffer): Promise<string | undefined> { return channel.uploadImage?.(body); }
