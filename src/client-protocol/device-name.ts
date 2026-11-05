/** Old defaults are relative to the client that created the pairing, not a
 * device identity. Never infer a particular computer from its platform. */
export function relativeDeviceName(name: string): boolean {
  return ["我的设备", "这台电脑", "这台手机", "这台主机", "此设备", "此主机", "my device", "this computer", "this phone", "this device", "this host"].includes(name.trim().toLowerCase());
}
