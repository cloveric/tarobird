import path from 'node:path';
import { lstatSync, openSync, readSync, closeSync } from 'node:fs';

export function electronSignable(target) {
  const stat = lstatSync(target);
  if (stat.isDirectory()) return target.endsWith('.app') || target.endsWith('.framework');
  if (!stat.isFile()) return false;
  const fd = openSync(target, 'r');
  try { const magic = Buffer.alloc(4); return readSync(fd, magic, 0, 4, 0) === 4
    && ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic.toString('hex')); }
  finally { closeSync(fd); }
}

export const ELECTRON_RIGHTS = Object.freeze({
  app: Object.freeze(['com.apple.security.cs.allow-jit', 'com.apple.security.device.audio-input', 'com.apple.security.device.camera']),
  chromium: Object.freeze(['com.apple.security.cs.allow-jit']),
  // Chromium's generic utility helper hosts audio/video capture. Renderer and
  // GPU helpers do not inherit the main executable's media entitlements.
  chromiumMedia: Object.freeze(['com.apple.security.cs.allow-jit', 'com.apple.security.device.audio-input', 'com.apple.security.device.camera']),
  host: Object.freeze(['com.apple.security.cs.allow-jit', 'com.apple.security.cs.disable-library-validation']),
  native: Object.freeze([]),
});
export function electronSigningRole(bundle, target) {
  const relative = path.relative(bundle, target).split(path.sep).join('/');
  if (relative === '' || relative === 'Contents/MacOS/tarocub-client') return 'app';
  if (relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('signing_target_outside_bundle');
  if (relative === 'Contents/Resources/host/node') return 'host';
  if (/^Contents\/Frameworks\/Taro(?:Bird|Bot) Helper\.app(?:\/Contents\/MacOS\/Taro(?:Bird|Bot) Helper)?$/.test(relative)) return 'chromiumMedia';
  if (/^Contents\/Frameworks\/Taro(?:Bird|Bot) Helper(?: \((?:Renderer|GPU|Plugin)\))?\.app(?:\/Contents\/MacOS\/[^/]+)?$/.test(relative)) return 'chromium';
  return 'native';
}
export function credentialCodeIdentifier(bundle, target, developerSigned) {
  const relative = path.relative(bundle, target).split(path.sep).join('/');
  // Old credentials trust the old App's designated signing requirement. Keep
  // that identifier for the two signed native readers as well as Electron main;
  // the release signer/Team ID remains unchanged. No secrets enter the renderer.
  // Signed acceptance packages exercise that exact same credential boundary.
  return developerSigned && ['Contents/Resources/native/tarobot-desktop-core', 'Contents/Resources/native/tarobot-desktop-updater'].includes(relative)
    ? 'com.tarobot.client' : undefined;
}
