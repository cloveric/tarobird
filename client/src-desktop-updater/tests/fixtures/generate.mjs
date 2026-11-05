// Regenerates the static vectors used by src/signature.rs unit tests.
import { writeFileSync } from 'node:fs';
import { generateKey, signBytes } from '../minisign.mjs';

const here = new URL('.', import.meta.url);
const key = generateKey(Buffer.alloc(32, 7)), other = generateKey(Buffer.alloc(32, 9));
const data = Buffer.from('tarobot-update-fixture');
const write = (name, value) => writeFileSync(new URL(name, here), `${value}\n`);
write('pubkey.b64', key.pubkey);
write('other-pubkey.b64', other.pubkey);
write('prehashed.sig.b64', signBytes(key, data, { version: '1.2.3' }));
write('legacy.sig.b64', signBytes(key, data, { version: '1.2.3', prehashed: false }));
write('unversioned.sig.b64', signBytes(key, data, {}));
