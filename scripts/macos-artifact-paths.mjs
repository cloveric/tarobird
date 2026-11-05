import { mkdirSync, realpathSync, existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Resolve existing parents too: a symlink named *.noindex does not protect an
// indexed physical destination. Do not rename shared caches behind other Bots.
export function physicalPath(input) {
  const absolute = path.resolve(input);
  let ancestor = absolute;
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return path.join(realpathSync.native(ancestor), path.relative(ancestor, absolute));
}
export function noIndexDirectory(input) {
  let output = path.resolve(input);
  const protectInstalled = value => {
    const guarded = value.toLowerCase();
    if (guarded === '/applications' || guarded.startsWith('/applications/') || guarded === '/system' || guarded.startsWith('/system/')) throw new Error('Temporary artifacts must not be placed in installed application directories');
  };
  protectInstalled(output);
  if (!output.split(path.sep).some(part => part.endsWith('.noindex'))) {
    const legacy = '/Volumes/gdrive/taro-tmp';
    output = output.startsWith(legacy + path.sep) ? '/Volumes/gdrive/taro-tmp.noindex' + output.slice(legacy.length) : output + '.noindex';
  }
  const physical = physicalPath(output);
  protectInstalled(physical);
  if (!physical.split(path.sep).some(part => part.endsWith('.noindex'))) throw new Error('The physical artifact directory must be below .noindex (symlink refused)');
  return output;
}
export function artifactRoot(environment = process.env) {
  const ownerRoot = '/Volumes/gdrive/taro-tmp.noindex';
  const requested = environment.TAROBOT_ARTIFACT_ROOT ?? (existsSync('/Volumes/gdrive') ? ownerRoot : path.join(os.tmpdir(), 'tarobot-artifacts.noindex'));
  return noIndexDirectory(requested);
}
export function macosBuildEnvironment(repo, environment = process.env, platform = process.platform) {
  if (platform !== 'darwin') return { ...environment };
  const target = noIndexDirectory(environment.CARGO_TARGET_DIR ?? path.join(repo, 'client/src-tauri/target.noindex'));
  return { ...environment, CARGO_TARGET_DIR: target, TAROBOT_ARTIFACT_ROOT: artifactRoot(environment) };
}
export async function macosScratch(prefix, environment = process.env) {
  const root = artifactRoot(environment);
  mkdirSync(root, { recursive: true });
  return mkdtemp(path.join(root, prefix));
}
