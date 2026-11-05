// CRX3 verification for the person's extension packages (adopted from the 2026-11-01
// root review helper, synthetic cases in tests/browser-extensions.test.mjs).
import { createHash, createPublicKey, createVerify, constants } from 'node:crypto';

// Format reference: chromium/components/crx_file/{crx3.proto,crx_verifier.cc}.
// Independently implemented bounded parser; does not extract ZIPs or trust their paths.
const PUBLISHER_HASH = '61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf';
const CONTEXT = Buffer.from('CRX3 SignedData\0');
const MAX_PACKAGE = 128 * 1024 * 1024, MAX_HEADER = 4 * 1024 * 1024;
const fail = () => { throw new Error('extension_invalid_signature'); };
const sha = bytes => createHash('sha256').update(bytes).digest();
const id = bytes => [...bytes.toString('hex')].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');

function fields(bytes) {
  let cursor = 0, count = 0; const result = [];
  const uint = () => {
    let n = 0, factor = 1;
    for (let i = 0; i < 5; i++, factor *= 128) {
      if (cursor >= bytes.length) fail();
      const b = bytes[cursor++]; n += (b & 127) * factor;
      if (n > 0xffffffff) fail();
      if (!(b & 128)) return n;
    }
    fail();
  };
  while (cursor < bytes.length) {
    if (++count > 128) fail();
    const tag = uint(), wire = tag % 8, number = Math.floor(tag / 8);
    if (number === 0) fail();
    if (wire === 2) {
      const size = uint(); if (size > bytes.length - cursor) fail();
      result.push({number, value:bytes.subarray(cursor, cursor + size)}); cursor += size;
    } else if (wire === 0) { uint(); }
    else if (wire === 1 || wire === 5) { cursor += wire === 1 ? 8 : 4; if (cursor > bytes.length) fail(); }
    else fail();
  }
  return result;
}
function only(list, number) {
  const matches = list.filter(f => f.number === number); if (matches.length !== 1) fail(); return matches[0].value;
}

export function verifyCrx3(input, {expectedId, requirePublisher = false} = {}) {
  if (!(input instanceof Uint8Array) || input.length < 16 || input.length > MAX_PACKAGE) fail();
  const data = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (data.toString('ascii', 0, 4) !== 'Cr24' || data.readUInt32LE(4) !== 3) fail();
  const length = data.readUInt32LE(8);
  if (length === 0 || length > MAX_HEADER || length > data.length - 16) fail();
  const header = data.subarray(12, 12 + length), archive = data.subarray(12 + length);
  if (archive.readUInt32LE(0) !== 0x04034b50) fail();
  const outer = fields(header), signed = only(outer, 10000);
  if (signed.length > 4096) fail();
  const declared = only(fields(signed), 1); if (declared.length !== 16) fail();
  const extensionId = id(declared);
  if (expectedId !== undefined && expectedId !== extensionId) throw new Error('extension_id_mismatch');
  const proofs = outer.filter(f => f.number === 2 || f.number === 3);
  if (!proofs.length || proofs.length > 16) fail();
  const signedLength = Buffer.alloc(4); signedLength.writeUInt32LE(signed.length);
  let developerKey, publisher = false;
  for (const proof of proofs) {
    const parts = fields(proof.value), key = only(parts, 1), signature = only(parts, 2);
    if (!key.length || key.length > 16384 || !signature.length || signature.length > 16384) fail();
    try {
      const publicKey = createPublicKey({key,format:'der',type:'spki'});
      if (publicKey.asymmetricKeyType !== (proof.number === 2 ? 'rsa' : 'ec')) fail();
      const verifier = createVerify('sha256');
      verifier.update(CONTEXT); verifier.update(signedLength); verifier.update(signed); verifier.update(archive);
      if (!verifier.verify({key:publicKey,padding:constants.RSA_PKCS1_PADDING,dsaEncoding:'der'},signature)) fail();
    } catch { fail(); }
    const hash = sha(key);
    if (id(hash.subarray(0,16)) === extensionId) developerKey = key;
    if (hash.toString('hex') === PUBLISHER_HASH) publisher = true;
  }
  if (!developerKey || requirePublisher && !publisher) fail();
  return {id:extensionId, publicKey:developerKey.toString('base64'), publisherVerified:publisher, archive};
}
