// Lab-only minisign signer in the format `tauri signer` emits: base64 of the
// public key file and of the signature file. Never used by the shipped App.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const b64 = bytes => Buffer.from(bytes).toString('base64');

export function generateKey(seed) {
  const pair = seed
    ? (() => { const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' }); return { privateKey, publicKey: createPublicKey(privateKey) }; })()
    : generateKeyPairSync('ed25519');
  const raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const keyId = seed ? createHash('sha256').update(seed).digest().subarray(0, 8) : randomBytes(8);
  const file = `untrusted comment: minisign public key ${Buffer.from(keyId).reverse().toString('hex').toUpperCase()}\n${b64(Buffer.concat([Buffer.from('Ed'), keyId, raw]))}\n`;
  return { privateKey: pair.privateKey, keyId, pubkey: b64(file) };
}

/** `trusted` defaults to the Tauri CLI layout, which records the version. */
export function signBytes(key, data, { version, prehashed = true, trusted, file = 'TaroBot.app.tar.gz' } = {}) {
  const comment = trusted ?? `timestamp:1700000000\tfile:${file}${version ? `\tversion:${version}` : ''}`;
  const message = prehashed ? createHash('blake2b512').update(data).digest() : data;
  const signature = sign(null, message, key.privateKey);
  const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), key.privateKey);
  const text = `untrusted comment: signature from tauri secret key\n${b64(Buffer.concat([Buffer.from(prehashed ? 'ED' : 'Ed'), key.keyId, signature]))}\ntrusted comment: ${comment}\n${b64(global)}\n`;
  return b64(text);
}
