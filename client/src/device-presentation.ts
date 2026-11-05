import { t } from './i18n.js';
import { relativeDeviceName } from '../../src/client-protocol/device-name.js';
import type { NetworkView } from '../../src/client-protocol/private-network.js';

/** Display labels never identify a device or change its authorization. */
export function defaultDeviceName(platform: string): string {
  switch (platform) {
    case 'macos': return t('Mac 电脑');
    case 'windows': return t('Windows 电脑');
    case 'android': return t('Android 手机');
    case 'ios': return t('iPhone / iPad');
    default: return t('浏览器设备');
  }
}
export function ambiguousDeviceName(name: string): boolean {
  return relativeDeviceName(name);
}
/** Old pairing defaults describe the originating client's perspective. Show a
 * neutral label everywhere without rewriting user records or inferring which
 * network host a remote computer belongs to. Proven host names stay authoritative. */
export function deviceDisplayName(device: { name: string; platform: string; nameSource?: 'host' }): string {
  if (device.nameSource === 'host' || !ambiguousDeviceName(device.name)) return device.name;
  return ['macos', 'windows', 'android', 'ios', 'web'].includes(device.platform)
    ? defaultDeviceName(device.platform) : t('其他设备');
}
export function deviceRevokeScope(network: NetworkView | undefined, hostKey: string | undefined, deviceId: string): string {
  const manifest = network?.membership?.manifest;
  if (network?.sync !== 'removed' && manifest?.devices.some(device => device.host === hostKey && device.id === deviceId && !device.revoked)) {
    return t('撤销会同步到网络「{0}」中的所有主机，该设备将无法继续访问这些主机。其他主机同步前可能有短暂延迟。', manifest.name);
  }
  // A missing or stale directory is not evidence of host-only authorization.
  return t('该设备将与此主机断开；如果它已加入网络，撤销也会同步到整个网络。再次访问需要重新配对。');
}
