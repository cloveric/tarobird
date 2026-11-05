/** Browser-safe decoding with native atob validation and one output allocation.
 * Avoid Uint8Array.from's per-byte iterator/callback cost on large attachments.
 */
export function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value), bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
