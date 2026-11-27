import { z } from "zod";

export const CROSS_HOST_FOLDER_ORDER_CAPABILITY = "cross-host-folder-order.v1";

/** Validate canonical `JSON.stringify([hostKey, folderId])` entries where
 * `hostKey` is non-empty and `folderId` is a non-empty folder ID or `null`. */
export function isCanonicalCrossHostFolderKey(key: string): boolean {
  if (key.length < 5 || key.length > 512) return false;
  try {
    const value: unknown = JSON.parse(key);
    if (!Array.isArray(value) || value.length !== 2) return false;
    const [hostKey, folderId] = value;
    if (typeof hostKey !== "string" || !hostKey || hostKey.length > 256) return false;
    if (folderId !== null && (typeof folderId !== "string" || !folderId || folderId.length > 128)) return false;
    return key === JSON.stringify([hostKey, folderId]);
  } catch {
    return false;
  }
}

export const crossHostFolderKeySchema = z.string().refine(isCanonicalCrossHostFolderKey, "Invalid cross-host folder key");

const revision = z.number().int().nonnegative().safe();
const timestamp = z.number().int().nonnegative().safe();

export const crossHostFolderOrderSchema = z.object({
  version: z.literal(1),
  revision,
  updatedAt: timestamp,
  pinned: z.array(crossHostFolderKeySchema).max(2048),
  ordinary: z.array(crossHostFolderKeySchema).max(2048),
});
export type CrossHostFolderOrderState = z.infer<typeof crossHostFolderOrderSchema>;

export const crossHostFolderOrderChangeSchema = z.object({
  revision,
  updatedAt: timestamp,
  pinned: z.array(crossHostFolderKeySchema).max(2048),
  ordinary: z.array(crossHostFolderKeySchema).max(2048),
}).strict();
export type CrossHostFolderOrderChange = z.infer<typeof crossHostFolderOrderChangeSchema>;

export const emptyCrossHostFolderOrderState = (): CrossHostFolderOrderState => ({
  version: 1,
  revision: 0,
  updatedAt: 0,
  pinned: [],
  ordinary: [],
});
