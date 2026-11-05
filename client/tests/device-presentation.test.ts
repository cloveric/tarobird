import { expect, it } from 'vitest';
import { ambiguousDeviceName, defaultDeviceName, deviceDisplayName, deviceRevokeScope } from '../src/device-presentation.js';
import type { NetworkView } from '../../src/client-protocol/private-network.js';

it('uses neutral defaults without guessing a model or changing existing names', () => {
  expect(defaultDeviceName('macos')).toBe('Mac 电脑');
  expect(defaultDeviceName('android')).toBe('Android 手机');
  expect(defaultDeviceName('web')).toBe('浏览器设备');
  expect(ambiguousDeviceName('我的设备')).toBe(true);
  expect(ambiguousDeviceName('This computer')).toBe(true);
  expect(ambiguousDeviceName('Mac mini')).toBe(false);
});
it.each([
  ['这台电脑', 'macos', 'Mac 电脑'],
  ['这台手机', 'android', 'Android 手机'],
  ['这台主机', 'windows', 'Windows 电脑'],
  [' This Computer ', 'windows', 'Windows 电脑'],
  ['this phone', 'ios', 'iPhone / iPad'],
  ['我的设备', 'web', '浏览器设备'],
  ['此设备', 'unknown', '其他设备'],
])('renders legacy label %s neutrally for platform %s', (name, platform, expected) => {
  const device = { name, platform };
  expect(deviceDisplayName(device)).toBe(expected);
  expect(device.name).toBe(name);
});
it('preserves custom and proven host names without guessing a remote host identity', () => {
  expect(deviceDisplayName({ name: 'macmini', platform: 'macos' })).toBe('macmini');
  expect(deviceDisplayName({ name: '我的设备 Pro', platform: 'android' })).toBe('我的设备 Pro');
  expect(deviceDisplayName({ name: 'ASUS', platform: 'windows', nameSource: 'host' })).toBe('ASUS');
  expect(deviceDisplayName({ name: '这台电脑', platform: 'macos', nameSource: 'host' })).toBe('这台电脑');
});
it('describes network-wide revocation only from the matching host/device binding', () => {
  const network = { sync:'active', membership:{ manifest:{ name:'家庭网络',devices:[{id:'phone',host:'hostA',revoked:false}] } } } as unknown as NetworkView;
  expect(deviceRevokeScope(network,'hostA','phone')).toContain('网络「家庭网络」中的所有主机');
  expect(deviceRevokeScope(network,'hostB','phone')).toContain('如果它已加入网络');
  expect(deviceRevokeScope(undefined,'hostA','phone')).toContain('如果它已加入网络');
  expect(deviceRevokeScope({...network,sync:'removed'},'hostA','phone')).toContain('如果它已加入网络');
});
