import { PERSONAL_BROWSER_SCOPE, MAX_BROWSER_SURFACES } from "../shared/personal-browser.mjs";
import { z } from 'zod';
import { BROWSER_SETTINGS } from './browser-user-store.mjs';

// Main-only schema for the trusted App's workbench browser commands. Page
// content and Bot text never reach these handlers except as validated data.
const PERSONAL_ACTIONS = new Set(["capabilities", "list", "open", "navigate", "back", "forward", "reload", "stop", "close", "sleep", "wake", "find", "stop_find", "zoom", "device", "print", "save_screenshot", "settings", "settings_set", "history", "clear_history", "clear_data", "downloads", "download_cancel", "download_open", "download_reveal"]);

export const BROWSER_VERSION = 1;
export const BROWSER_EVENT = 'workbench-browser';
export const BROWSER_LIMITS = Object.freeze({
  tabs: 64, liveTabs: 6, visible: MAX_BROWSER_SURFACES, text: 48000, elements: 300, actionMs: 15000, navigationMs: 30000,
  imageBytes: 4 * 1024 * 1024, uploadBytes: 64 * 1024 * 1024, uploadFiles: 10, receipts: 512, receiptMs: 30 * 60000,
  // Leaves room inside the Host's 512 KiB workbench receipt for its envelope.
  observationBytes: 384 * 1024,
});
export const BROWSER_KEYS = Object.freeze(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PageUp', 'PageDown', 'Home', 'End']);

export class BrowserError extends Error {
  constructor(code, status = 'failed', detail) { super(code); this.code = code; this.status = status; this.detail = detail; }
}

const printable = max => z.string().min(1).max(max).regex(/^[\x21-\x7e]+$/);
const tabId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const ref = z.string().regex(/^r\d{1,9}\.\d{1,9}\.\d{1,6}$/);
const scope = z.object({ host: printable(256), user: printable(256), conversation: printable(256) }).strict();
const common = { scope, requestId: printable(128).optional(), source: z.enum(['user', 'bot']).optional(), navigation: z.number().int().min(0).max(1e9).optional() };
const tabbed = { ...common, tab: tabId };
const url = z.string().min(1).max(8192);
const point = z.object({ x: z.number().finite().min(0).max(100000), y: z.number().finite().min(0).max(100000) }).strict();
const download = z.string().uuid();
const upload = z.string().uuid();
const act = (action, fields = {}, base = tabbed) => z.object({ action: z.literal(action), ...base, ...fields }).strict();

export const BROWSER_ACTION = z.discriminatedUnion('action', [
  act('capabilities', {}, common), act('list', {}, common),
  act('open', { url: url.optional(), title: z.string().max(512).optional(), restore: z.boolean().optional() }),
  act('navigate', { url }), act('back'), act('forward'), act('reload'), act('stop'),
  act('observe', { mode: z.enum(['viewport', 'page']).optional(), maxText: z.number().int().min(256).max(BROWSER_LIMITS.text).optional(),
    maxElements: z.number().int().min(1).max(BROWSER_LIMITS.elements).optional() }),
  act('selection'),
  act('screenshot', { maxWidth: z.number().int().min(200).max(2560).optional() }),
  act('click', { ref: ref.optional(), point: point.optional(), snapshot: z.number().int().min(1).optional() }),
  act('type', { ref, text: z.string().max(20000), mode: z.enum(['replace', 'append']).optional() }),
  act('press', { key: z.union([z.enum(BROWSER_KEYS), z.string().regex(/^[A-Za-z0-9]$/)]),
    modifiers: z.array(z.enum(['shift', 'control', 'alt', 'meta'])).max(4).optional() }),
  act('scroll', { ref: ref.optional(), direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    amount: z.union([z.enum(['page', 'half']), z.number().int().min(1).max(100000)]).optional(), to: z.enum(['top', 'bottom']).optional() }),
  act('select', { ref, values: z.array(z.string().max(1024)).min(1).max(64).optional(), labels: z.array(z.string().max(1024)).min(1).max(64).optional() }),
  act('cancel', { targetRequestId: printable(128).optional() }), act('takeover'), act('resume'),
  act('close', { force: z.boolean().optional() }), act('sleep'), act('wake'),
  act('clear_data', {}, common), act('revoke_scope', {}, common),
  act('reveal', { tab: tabId.optional() }, common),
  act('downloads', {}, common), act('download_cancel', { download }, common), act('download_open', { download, english: z.boolean().optional() }, common),
  act('download_reveal', { download }, common),
  act('upload_begin', { name: z.string().min(1).max(240).refine(value => !/[\\/\x00-\x1f]/.test(value) && !value.startsWith('.')),
    mime: z.string().max(128).optional(), size: z.number().int().min(0).max(BROWSER_LIMITS.uploadBytes) }, common),
  act('upload_write', { upload, data: z.string().max(1398104) }, common),
  act('upload', { ref, files: z.array(upload).min(1).max(BROWSER_LIMITS.uploadFiles) }),
  // The person's own page tools (trusted UI only; see USER_ONLY).
  act('find', { text: z.string().min(1).max(1024), forward: z.boolean().optional(), findNext: z.boolean().optional(), matchCase: z.boolean().optional() }),
  act('stop_find'),
  act('zoom', { factor: z.number().finite().min(0.25).max(3) }),
  act('device', { preset: z.enum(['desktop', 'phone', 'tablet']), landscape: z.boolean().optional() }),
  act('print', { mode: z.enum(['dialog', 'pdf']).optional(), english: z.boolean().optional() }),
  act('save_screenshot', { english: z.boolean().optional() }),
  act('history', { query: z.string().max(256).optional(), limit: z.number().int().min(1).max(500).optional() }, common),
  act('clear_history', {}, common),
  act('settings', {}, common),
  act('settings_set', { settings: BROWSER_SETTINGS }, common),
]);
export const BROWSER_ACTIONS = Object.freeze(BROWSER_ACTION.options.map(option => option.shape.action.value));
// Actions that may change a page, a session or local files carry a Host
// request identity when issued for a Bot, so a retry never repeats them.
export const MUTATING = new Set(['open', 'navigate', 'back', 'forward', 'reload', 'stop', 'click', 'type', 'press', 'scroll', 'select', 'close',
  'sleep', 'wake', 'clear_data', 'revoke_scope', 'download_cancel', 'upload_begin', 'upload_write', 'upload']);
export const NATIVE_INPUT = new Set(['click', 'press', 'type', 'select', 'upload']);
// Opening local files, erasing or revoking a scope's sessions and ending a
// takeover are the person's own decisions (trusted UI); a Bot request is refused.
export const USER_ONLY = new Set(['download_open', 'download_reveal', 'clear_data', 'revoke_scope', 'resume',
  // Page tools open system dialogs, write chosen files or read browsing history.
  'find', 'stop_find', 'zoom', 'device', 'print', 'save_screenshot', 'history', 'clear_history', 'settings', 'settings_set']);
// A page focused key combination that main turns into a page tool (find, print,
// zoom). A Bot key press must not reach those tools through the shortcut path.
const TOOL_SHORTCUT = new Set(['f', 'g', 'p', '0']);

export const BROWSER_LAYOUT = z.object({
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  views: z.array(z.object({ tab: tabId, x: z.number().finite().min(-100000).max(100000), y: z.number().finite().min(-100000).max(100000),
    width: z.number().finite().min(0).max(100000), height: z.number().finite().min(0).max(100000) }).strict()).max(BROWSER_LIMITS.visible),
  hidden: z.boolean().optional(),
}).strict();

export function parseBrowserAction(input) {
  const checked = BROWSER_ACTION.safeParse(input);
  if (!checked.success) throw new Error('invalid_browser_args');
  const args = checked.data;
  if (args.scope.host === PERSONAL_BROWSER_SCOPE.host && (args.source !== "user" || !PERSONAL_ACTIONS.has(args.action))) throw new Error("browser_user_action_required");
  if (args.action === 'click' && !args.ref === !args.point || args.action === 'click' && args.point && !args.snapshot) throw new Error('invalid_browser_args');
  if (args.action === 'select' && !args.values === !args.labels) throw new Error('invalid_browser_args');
  if (args.action === 'scroll' && args.to && args.direction) throw new Error('invalid_browser_args');
  if ((args.source ?? 'bot') === 'bot' && MUTATING.has(args.action) && !args.requestId) throw new Error('browser_request_id_required');
  if ((args.source ?? 'bot') === 'bot' && USER_ONLY.has(args.action)) throw new Error('browser_user_action_required');
  if ((args.source ?? 'bot') === 'bot' && args.action === 'press' && args.modifiers?.some(value => value === 'meta' || value === 'control') && TOOL_SHORTCUT.has(args.key.toLowerCase()))
    throw new Error('browser_user_action_required');
  if (new Set(args.files ?? []).size !== (args.files ?? []).length) throw new Error('invalid_browser_args');
  return args;
}
/** Host removal / local reset: clear the web data of exactly these scopes (and
 * this Host's registered partitions). Every scope must belong to `host`. */
export const BROWSER_RESET = z.object({ host: printable(256), scopes: z.array(scope).max(4096) }).strict();
export function parseBrowserReset(input) {
  const checked = BROWSER_RESET.safeParse(input);
  if (!checked.success || checked.data.scopes.some(value => value.host !== checked.data.host)) throw new Error('invalid_browser_reset');
  return checked.data;
}
export function parseBrowserLayout(input) {
  const checked = BROWSER_LAYOUT.safeParse(input);
  if (!checked.success || new Set(checked.data.views.map(view => view.tab)).size !== checked.data.views.length) throw new Error('invalid_browser_layout');
  return checked.data;
}
