import { describe, expect, it } from 'vitest';
import { decodeBase64 } from '../src/client-protocol/base64.js';

describe('browser binary decoding', () => {
  it.each(['', 'YQ==', 'YQ', 'YWI=', 'YWI', ' Y W I=\r\n\t', 'AP8QgH8='])('preserves native atob bytes for %j', value => {
    expect(decodeBase64(value)).toEqual(Uint8Array.from(atob(value), character => character.charCodeAt(0)));
  });
  it.each(['A', 'Y===', 'YQ=', '-_==', '😀', 'YQ==x'])('retains native rejection for %j', value => {
    expect(() => atob(value)).toThrow(); expect(() => decodeBase64(value)).toThrow();
  });
  it('round-trips every byte across a multi-megabyte buffer without truncation', () => {
    const expected = new Uint8Array(4 * 1024 * 1024 + 257);
    for (let index = 0; index < expected.length; index++) expected[index] = index % 256;
    const decoded = decodeBase64(Buffer.from(expected).toString('base64'));
    expect(decoded.byteOffset).toBe(0); expect(decoded.buffer.byteLength).toBe(expected.byteLength);
    expect(Buffer.from(decoded).equals(Buffer.from(expected))).toBe(true);
  });
});
