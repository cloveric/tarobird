import path from 'node:path';
import { mkdir } from 'node:fs/promises';

/** Preserve Tauri's app_data_dir/app_local_data_dir split. Chromium's default
 * product-name directory must never become the Host or credential namespace. */
export function productionPaths({ platform, appData, localAppData, resources }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (!['darwin', 'win32'].includes(platform) || !p.isAbsolute(appData) || !p.isAbsolute(resources)
    || platform === 'win32' && !p.isAbsolute(localAppData ?? '')) throw new Error('desktop_paths_unavailable');
  const hostStateDir = p.join(appData, 'com.tarobot.client');
  const stateDir = platform === 'win32' ? p.join(localAppData, 'com.tarobot.client') : hostStateDir;
  // sessionData contains IndexedDB/localStorage as well as Chromium caches.
  // Keep it inside the persistent profile, never in an expendable cache folder.
  return { stateDir, hostStateDir, profile: p.join(stateDir, 'electron-profile'), cache: p.join(stateDir, 'electron-profile', 'browser-data'), resourcesDir: p.join(resources, 'host'),
    legacyWebviewDirs: platform === 'darwin' ? [p.join(p.dirname(appData), 'WebKit', 'com.tarobot.client')] : [p.join(stateDir, 'EBWebView')] };
}
export async function preparePaths(paths) {
  for (const key of ['stateDir', 'hostStateDir', 'profile', 'cache']) await mkdir(paths[key], { recursive: true, mode: 0o700 });
}
