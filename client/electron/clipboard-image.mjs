import { z } from 'zod';

const request = z.object({ text: z.string().max(1024 * 1024) }).strict();
const LIMIT = 32 * 1024 * 1024;
const formats = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** Explicit composer paste only. Never resolve clipboard URLs, filesystem paths
 * or private application payloads. Electron 45 uses async ClipboardItem reads. */
export async function readClipboardImage(window, clipboard, input, active) {
  const { text } = request.parse(input);
  const check = () => {
    if (!active()) throw new Error('native_document_retired');
    if (window.isDestroyed() || !window.isFocused()) throw new Error('clipboard_inactive');
  };
  check();
  const items = await clipboard.read(); check();
  if (items.length > 32) throw new Error('clipboard_image_too_large');
  let actualText = '';
  for (const item of items) {
    if (!item.types.includes('text/plain')) continue;
    const blob = await item.getType('text/plain'); check();
    if (blob.size > 4 * 1024 * 1024) throw new Error('clipboard_changed');
    actualText += await blob.text(); check();
  }
  // Chromium can normalize Windows clipboard CRLF while the native item
  // retains it. Compare the text content, not its platform newline encoding.
  if (actualText.replace(/\r\n?/g, '\n') !== text.replace(/\r\n?/g, '\n')) throw new Error('clipboard_changed');
  for (const item of items) {
    const type = formats.find(type => item.types.includes(type));
    if (!type) continue;
    const blob = await item.getType(type); check();
    if (blob.size > LIMIT) throw new Error('clipboard_image_too_large');
    const bytes = Buffer.from(await blob.arrayBuffer()); check();
    const valid = type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : type === 'image/gif' ? /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!valid) throw new Error('clipboard_image_invalid');
    return { type, data: bytes.toString('base64') };
  }
  return null;
}
