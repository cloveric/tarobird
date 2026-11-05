/** Electron's native encoder avoids building and spreading a binary string on
 * the UI thread for every upload/save chunk. Keep the old algorithm available
 * when the runtime has no typed-array encoder; wire this only to Electron. */
export function encodeDesktopBytes(bytes: Uint8Array): string {
  const encode = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof encode === "function") return encode.call(bytes);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(binary);
}
