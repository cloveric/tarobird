/** com.tarobot.client channels. Never publish the new identity under legacy
 * <platform>-v tags: old installed updaters cannot migrate a package identity.
 * Unverified architectures must not receive an update. */
export function desktopUpdatePlatform(platform = 'windows') {
  if (platform === 'windows') return { name: 'Windows', prefix: 'windows-tarobot-v', manifest: 'windows-tarobot-latest.json', target: 'windows-x86_64', extension: '.exe' };
  if (platform === 'macos') return { name: 'macOS', prefix: 'macos-tarobot-v', manifest: 'macos-tarobot-latest.json', target: 'darwin-aarch64', extension: '.app.tar.gz' };
  throw new Error('Unsupported desktop update platform');
}
