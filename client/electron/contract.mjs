// Shared by the main process and bundled sandboxed preload. No Electron or
// Node imports: importing this file never grants a renderer a native capability.
export const BRIDGE_VERSION = 1;
export const APP_ORIGIN = 'tarobot://app';
export const APP_ENTRY = `${APP_ORIGIN}/index.html`;
export const SCREEN_PORT = 'tarobot:screen-port:v1';
export const NATIVE_REQUEST = 'tarobot:native-request:v1';
export const NATIVE_BOOTSTRAP = 'tarobot:native-bootstrap:v1';
export const NATIVE_EVENT = 'tarobot:native-event:v1';
export const DESKTOP_EVENT = 'tarobot:desktop-event:v1';
export const DESKTOP_EVENTS = Object.freeze(['focus', 'window-state', 'deep-link', 'native-state', 'tarocub-notification-action', 'github-update-progress', 'workbench-browser']);
export const DESKTOP_COMMANDS = Object.freeze([
  'screen_service_status', 'screen_service_retry', 'screen_service_permission', 'screen_service_stop', 'screen_viewer_open', 'screen_viewer_close', 'screen_viewer_visibility',
  'github_update_info', 'github_update_login_start', 'github_update_login_poll', 'github_update_login_cancel',
  'github_update_logout', 'github_update_check', 'github_update_install', 'github_update_close', 'restart_client',
  'desktop_migration_inspect', 'desktop_migration_prepare', 'desktop_migration_read', 'desktop_migration_complete',
  'desktop_recover', 'desktop_native_state', 'desktop_window_read', 'desktop_window_size', 'desktop_window_position', 'desktop_window_side_minimum',
  'desktop_window_fullscreen', 'desktop_window_focus', 'desktop_context_menu', 'desktop_open_url', 'desktop_clipboard_image',
  'desktop_launch_links', 'desktop_autostart_get', 'desktop_autostart_set', 'unread_count', 'desktop_notification_settings',
  'desktop_save_begin', 'desktop_save_write', 'desktop_save_commit', 'desktop_save_cancel', 'open_saved_file', 'reveal_saved_file',
  'desktop_notifications_supported', 'desktop_notification_permission', 'desktop_notification_context', 'desktop_notification_show',
  'desktop_notification_clear', 'desktop_notification_peek', 'desktop_notification_ack', 'capture_screenshot',
  // Main-owned workbench pages (WebContentsView). Distinct from desktop_open_url,
  // which keeps opening the system browser.
  'workbench_browser', 'workbench_browser_layout',
  // Trusted App reset/Host removal only; not a browser action and never Bot-reachable.
  'workbench_browser_reset',
  // The person's Chrome extensions for workbench pages; trusted UI only, never Bot-reachable.
  'workbench_browser_extensions',
]);
export const VIEW_COMMANDS = Object.freeze([
  'device_create', 'device_sign', 'device_sign_action', 'device_forget',
  'net_document', 'net_allocate', 'net_cancel', 'net_http_open', 'net_http_read',
  'net_socket_open', 'net_socket_send', 'net_socket_ack', 'net_socket_close', 'desktop_host',
]);
export const MAIN_COMMANDS = Object.freeze(['net_reset', 'helper_info']);
export const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
// A 1 MiB WebSocket frame can expand sixfold when JSON-escaped. Includes the
// document/channel envelope, HTTP chunks and the bounded Host status response.
export const MAX_RESPONSE_BYTES = 7 * 1024 * 1024;
export const MAX_PENDING = 256;

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

export function isEntryURL(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'tarobot:' && url.hostname === 'app' && !url.port
      && !url.username && !url.password && url.pathname === '/index.html' && !url.search;
  } catch { return false; }
}

// Frame identity AND origin AND document URL are required. Child frames receive
// no preload, but same-origin script can still call a parent's API. Untrusted
// content therefore also needs a separate origin or opaque sandbox and CSP.
export function trustedSender(event, contents) {
  try {
    return !contents.isDestroyed() && event.sender === contents
      && event.senderFrame === contents.mainFrame
      && event.senderFrame.origin === APP_ORIGIN && isEntryURL(event.senderFrame.url);
  } catch { return false; }
}

export function validateViewRequest(request, { controller = false } = {}) {
  if (!isObject(request) || Object.keys(request).some(key => !['command', 'args', 'subscription', 'token'].includes(key))
    || ![...VIEW_COMMANDS, ...DESKTOP_COMMANDS].includes(request.command) || !isObject(request.args)) {
    throw new Error('invalid_native_request');
  }
  if (!controller && (request.command.startsWith('device_') || request.command === 'desktop_host' || DESKTOP_COMMANDS.includes(request.command))) {
    throw new Error('native_controller_required');
  }
  if (request.command === 'net_socket_open') {
    if (!Number.isSafeInteger(request.subscription) || request.subscription < 1
      || Object.hasOwn(request.args, 'channel') || Object.hasOwn(request.args, 'events')) {
      throw new Error('invalid_native_subscription');
    }
  } else if (Object.hasOwn(request, 'subscription')) {
    throw new Error('invalid_native_subscription');
  }
  // Rust validates command fields and transport constraints. Helper RPC bounds
  // the serialized request before buffering or writing it to native stdin.
  return request;
}
