import { decodeBase64 } from '../../src/client-protocol/base64.js';
import { invoke, isElectron } from './desktop-bridge.js';

const LIMIT = 32 * 1024 * 1024;
const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const imagePlaceholder = (text: string) => /^\s*\[(?:图片|image)\]\s*$/i.test(text);

function imageFile(type: string, data: string, index = 0): File {
  if (!extensions[type] || data.length > Math.ceil(LIMIT / 3) * 4) throw new Error('clipboard_image_too_large');
  const bytes = decodeBase64(data);
  const valid = type === 'image/png' ? [137,80,78,71,13,10,26,10].every((value,i)=>bytes[i]===value)
    : type === 'image/jpeg' ? bytes[0]===255 && bytes[1]===216 && bytes[2]===255
    : type === 'image/gif' ? /^GIF8[79]a$/.test(String.fromCharCode(...bytes.slice(0,6)))
    : String.fromCharCode(...bytes.slice(0,4))==='RIFF' && String.fromCharCode(...bytes.slice(8,12))==='WEBP';
  if (!valid || bytes.length > LIMIT) throw new Error('clipboard_image_invalid');
  return new File([bytes], `Pasted-image-${Date.now()}-${index + 1}.${extensions[type]}`, { type });
}

export function clipboardHTMLImages(html: string): { files: File[]; hasImage: boolean } {
  if (!html || html.length > Math.ceil(LIMIT / 3) * 4) return { files: [], hasImage: false };
  // Template contents are inert, including external images/iframes. They are
  // never connected to the page or used as markup in a message.
  const template = document.createElement('template'); template.innerHTML = html;
  const images = Array.from(template.content.querySelectorAll('img'));
  const files: File[] = [];
  let bytes = 0;
  for (const image of images.slice(0,32)) {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(image.getAttribute('src') ?? '');
    if (!match) continue;
    const file = imageFile(match[1]!.toLowerCase(), match[2]!.replace(/\s/g,''), files.length);
    if ((bytes += file.size) > LIMIT) throw new Error('clipboard_image_too_large');
    files.push(file);
  }
  return { files, hasImage: images.length > 0 };
}

export function canReadDesktopClipboardImage() { return isElectron(); }
export async function readDesktopClipboardImage(text: string): Promise<File | undefined> {
  const result = await invoke<{ type: string; data: string } | null>('desktop_clipboard_image', { text });
  return result === null ? undefined : imageFile(result.type, result.data);
}
