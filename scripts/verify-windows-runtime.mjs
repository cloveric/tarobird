import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyWindowsRuntime } from './verify-host-launcher.mjs';

// Run against the extracted final installer, not just the build's staging tree.
const root = path.resolve(process.argv[2] || '.');
// A setup.exe directory (compressed payload) or incomplete staging tree must
// not pass as an extracted installer merely because its outer EXE looks valid.
const electron = (await lstat(path.join(root, 'resources/app.asar')).catch(() => undefined))?.isFile();
const host = electron ? 'resources/host' : 'host';
const requiredFiles = ['tarocub-client.exe', `${host}/node.exe`, `${host}/bin/tarobot-host-launcher.exe`, `${host}/node_modules/sqlite3/build/Release/node_sqlite3.node`,
  ...(electron ? ['resources/native/tarobot-desktop-core.exe', 'resources/native/tarobot-desktop-native.node', 'resources/native/tarobot-desktop-updater.exe', 'resources/native/tarobot-migration-exporter.exe'] : [])];
for (const required of requiredFiles) {
  const info = await lstat(path.join(root, required)).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`windows_runtime_incomplete_installer: ${required}`);
}
const results = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(file);
    else if (entry.isFile() && /\.(exe|dll|node)$/i.test(entry.name)) {
      try { results.push({ file: path.relative(root, file), imports: verifyWindowsRuntime(await readFile(file)) }); }
      catch (error) { throw new Error(`${path.relative(root, file)}: ${error.message}`, { cause: error }); }
    }
  }
}
await visit(root);
if (!results.length) throw new Error('windows_runtime_no_binaries');
console.log(JSON.stringify({ root, binaries: results }, null, 2));
