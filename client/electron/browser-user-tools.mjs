// Pure helpers for the person's own page tools (find, zoom, device preview,
// print, screenshots, history). Main-only; nothing here reads page content.

export const ZOOM_MIN = 0.25, ZOOM_MAX = 3;
export const ZOOM_STEPS = Object.freeze([0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]);
// Chromium displays 25%–500%; a preview scale times the person's zoom is clamped there.
const CHROMIUM_MIN = 0.25, CHROMIUM_MAX = 5;

export const clampZoom = value => Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value)) * 100) / 100;
export function zoomStep(factor, direction) {
  if (direction === 0) return 1;
  return direction > 0 ? ZOOM_STEPS.find(value => value > factor + 0.001) ?? ZOOM_MAX : [...ZOOM_STEPS].reverse().find(value => value < factor - 0.001) ?? ZOOM_MIN;
}
/** The factor applied to the page: the person's zoom times the preview scale. */
export const effectiveZoom = (zoom, scale = 1) => Math.min(CHROMIUM_MAX, Math.max(CHROMIUM_MIN, zoom * scale));

/** Responsive viewport sizes (CSS px at 100%). Not device emulation: no user
 * agent, touch, screen or pixel-ratio changes. */
export const DEVICE_PRESETS = Object.freeze({ phone: Object.freeze({ width: 390, height: 844 }), tablet: Object.freeze({ width: 768, height: 1024 }) });
export function deviceSize(device) {
  const size = DEVICE_PRESETS[device?.preset];
  if (!size) return undefined;
  return device.landscape ? { width: size.height, height: size.width } : { ...size };
}
/** Letterbox a device size (DIP at 100% page zoom) inside a pane, scaled down
 * to fit. The native view gets this rectangle and the page is zoomed by
 * `pageZoom × scale`: at 100% the CSS viewport equals the preset, at other
 * zooms it is preset ÷ pageZoom (as in a browser), and Chromium's 25% floor can
 * widen it further. Page coordinates and captures keep their usual meaning. */
export function fitDevice(pane, size) {
  const scale = Math.min(1, pane.width / size.width, pane.height / size.height);
  const width = Math.max(1, Math.min(pane.width, Math.round(size.width * scale))), height = Math.max(1, Math.min(pane.height, Math.round(size.height * scale)));
  return { x: pane.x + Math.floor((pane.width - width) / 2), y: pane.y + Math.floor((pane.height - height) / 2), width, height, scale: width / size.width };
}
export function devicePreview(device, scale = 1) {
  const size = deviceSize(device);
  if (!size) return { preset: 'desktop', landscape: false, width: 0, height: 0, scale: 1 };
  return { preset: device.preset, landscape: !!device.landscape, ...size, scale: Math.round(scale * 10000) / 10000 };
}

// Query names that mark an authentication or secret-bearing URL. Such a visit
// is not recorded at all; ordinary search queries are kept.
const SECRET_PARAM = /token|secret|passw|pwd|api_?key|apikey|signature|credential|assertion|session|^code$|^auth|^sig$|^sid$|^otp$|^key$|^ticket$|^jwt$|^nonce$|^saml|^x-amz-|^x-goog-/i;
/** History form of a committed main-frame URL, or undefined when it must not
 * be recorded: non-web, credentials, secret-bearing queries or oversize. */
export function historyURL(raw) {
  let url;
  try { url = new URL(raw); } catch { return undefined; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
  for (const name of url.searchParams.keys()) if (SECRET_PARAM.test(name)) return undefined;
  url.hash = '';
  const value = url.href;
  return value.length > 2048 ? undefined : value;
}

/** Page-focused shortcuts handled for the person. Returns a command or undefined.
 * Find next/previous and Escape belong to the page unless a find session is active. */
export function shortcutCommand(input, platform, finding = false) {
  if (input?.type !== 'keyDown' || input.alt) return undefined;
  if (input.key === 'Escape') return finding && !input.meta && !input.control && !input.shift ? 'escape' : undefined;
  const primary = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
  if (!primary) return undefined;
  const key = String(input.key ?? '').toLowerCase(), code = String(input.code ?? '');
  if (key === 'f' && !input.shift) return 'find';
  if (key === 'p' && !input.shift) return 'print';
  if (key === 'g' && finding) return input.shift ? 'find_prev' : 'find_next';
  if (key === '=' || key === '+' || code === 'NumpadAdd') return 'zoom_in';
  if (key === '-' || key === '_' || code === 'NumpadSubtract') return 'zoom_out';
  if (key === '0' && !input.shift) return 'zoom_reset';
  return undefined;
}

/** Suggested file name for a save dialog; the person chooses the real path. */
export function saveName(title, url, extension, date = new Date()) {
  let base = String(title ?? '').trim();
  if (!base) try { base = new URL(url).hostname; } catch { base = ''; }
  base = base.replace(/[\x00-\x1f\x7f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80).trim() || 'page';
  const pad = value => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  return `${base} ${stamp}.${extension}`;
}
