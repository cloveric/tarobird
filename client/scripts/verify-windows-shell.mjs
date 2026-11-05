// Verify the renderer embedded in the final NSIS-extracted EXE, rather than the
// separate host/client/dist resource (which only proves the Hub's web UI).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  exe: { type: 'string' }, frontend: { type: 'string' }, codegen: { type: 'string' }, version: { type: 'string' },
} });
if (Object.values(values).length !== 4) throw new Error('Required: --exe final-extracted.exe --frontend client/dist --codegen tauri-codegen-assets --version AppVersion');
const executable = readFileSync(values.exe);
if (!executable.includes(Buffer.from(values.version, 'utf16le'))) throw new Error('Windows version resource mismatch');
const html = readFileSync(path.join(values.frontend, 'index.html'), 'utf8');
const entryFiles = ['index.html', ...Array.from(html.matchAll(/(?:src|href)="\/(assets\/[^"?#]+\.(?:js|css))"/g), (match) => match[1])];
if (entryFiles.length < 3 || !entryFiles.some((file) => file.endsWith('.js'))) throw new Error('Missing renderer entry assets');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Tauri serializes index.html through an HTML parser. Normalize only its
// generated markup spelling; JavaScript and CSS must match byte for byte.
const canonicalHtml = (bytes) => bytes.toString().replace(/<!doctype html>/i, '<!doctype html>')
  .replace(/\s*\/>/g, '>').replace(/\bcrossorigin(?=[\s>])/g, 'crossorigin=""').replace(/>\s+</g, '><').trim();
const required = new Map(entryFiles.map((file) => {
  const bytes = readFileSync(path.join(values.frontend, file));
  return [hash(file === 'index.html' ? canonicalHtml(bytes) : bytes), file];
}));
const matches = [];
for (const name of readdirSync(values.codegen)) {
  const compressed = readFileSync(path.join(values.codegen, name));
  let decoded; try { decoded = brotliDecompressSync(compressed); } catch { decoded = compressed; }
  const digest = hash(name.endsWith('.html') ? canonicalHtml(decoded) : decoded), file = required.get(digest);
  if (!file) continue;
  const offset = executable.indexOf(compressed);
  if (offset < 0) continue;
  matches.push({ file, sha256: hash(decoded), embeddedOffset: offset }); required.delete(digest);
}
if (required.size) throw new Error('Final EXE does not embed matching renderer assets: ' + [...required.values()].join(', '));
console.log(JSON.stringify({ appVersion: values.version, exeSha256: hash(executable), embeddedRenderer: matches, nativeWindowsExecution: false }, null, 2));
