/** Production accepts OS activation only, never Chromium/Node debug or
 * security switches. Validate before loading native code or awaiting ready. */
export function validProductionLaunch(argv, packaged, platform = process.platform) {
  if (!packaged || !Array.isArray(argv) || !argv.length) return false;
  const args = argv.slice(1);
  if (platform === 'win32') {
    if (args.length === 1 && args[0] === '--clear-notification-history') return true;
    if (args.length === 2 && args[0] === '--register-notification-shortcut') {
      return typeof args[1] === 'string' && args[1].length < 32768 && !args[1].includes('\0'); // Native verifies the owned shortcut path.
    }
  }
  return args.every(arg => {
    if (typeof arg !== 'string' || arg.length > 2048 || arg.includes('\0')) return false;
    if (platform === 'darwin' && /^-psn_\d+_\d+$/.test(arg)) return true;
    try {
      const url = new URL(arg);
      return url.protocol === 'tarocub:' && ['conversation', 'notification'].includes(url.hostname)
        && !url.username && !url.password && !url.port;
    } catch { return false; }
  });
}
