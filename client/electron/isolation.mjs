import { mkdir, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';

/** Development/acceptance builds cannot silently use a production profile or
 * follow a cosmetic .noindex symlink onto an indexed physical directory. */
export async function isolatedRoot(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')
    || !directory.split(path.sep).some(part => part.endsWith('.noindex'))) throw new Error('absolute_noindex_root_required');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const physical = await realpath(directory);
  if (!physical.split(path.sep).some(part => part.endsWith('.noindex'))) throw new Error('physical_noindex_root_required');
  return physical;
}

export async function developmentPaths(directory) {
  const root = await isolatedRoot(directory);
  const values = {
    root, profile: path.join(root, 'electron-profile'), cache: path.join(root, 'cache'),
    stateDir: path.join(root, 'native-state'), hostStateDir: path.join(root, 'app-state'), resourcesDir: path.join(root, 'resources', 'host'),
  };
  for (const value of Object.values(values)) {
    let current = root;
    for (const part of path.relative(root, value).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const status = await lstat(current);
      if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('isolated_path_redirected');
    }
  }
  return values;
}
