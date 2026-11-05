import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { preflightCoreDeliveryPath, resolveCoreDeliveryRoots } from '../core/delivery-preflight.js';
/** Reuse App artifact permissions; local paths never cross the Workbench wire. */
export async function readWorkbenchImage(file: string, input: Parameters<typeof resolveCoreDeliveryRoots>[0], operator = false) {
  if (!path.isAbsolute(file)) throw new Error('absolute_image_path_required');
  const roots = await resolveCoreDeliveryRoots(input); if (operator) roots.allowAnyAbsolutePath = true;
  const safe = await preflightCoreDeliveryPath(file, roots); if (!safe.ok) throw new Error(`image_${safe.reason}`);
  if (safe.fileBytes < 8 || safe.fileBytes > 32 * 1024 * 1024) throw new Error('workbench_image_size');
  const handle = await open(safe.realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try { const before = await handle.stat();
    if (!before.isFile() || before.size !== safe.fileBytes || (before.ino > 0 && safe.fileIdentity !== `inode:${before.dev}:${before.ino}`)) throw new Error('image_file_changed');
    bytes = await handle.readFile(); const after = await handle.stat();
    if (bytes.length !== before.size || after.mtimeMs !== before.mtimeMs || after.size !== before.size) throw new Error('image_file_changed');
  } finally { await handle.close(); }
  const mime = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
    : bytes[0]===255 && bytes[1]===216 && bytes[2]===255 ? 'image/jpeg'
    : bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP' ? 'image/webp' : undefined;
  if (!mime) throw new Error('workbench_image_format');
  return { bytes, mime, name: path.basename(safe.realPath) };
}
