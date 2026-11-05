import { z } from 'zod';
const empty = z.object({}).strict(), id = z.string().max(128), host = z.string().regex(/^hub_[0-9a-f]{64}$/);
const schemas = {
  desktop_notifications_supported: empty, desktop_notification_context: empty, desktop_notification_peek: empty,
  desktop_notification_permission: z.object({ request: z.boolean() }).strict(),
  desktop_notification_ack: z.object({ id }).strict(),
  desktop_notification_clear: z.object({ documentId: id, hostId: host.optional() }).strict(),
  desktop_notification_show: z.object({ documentId: id, notice: z.object({
    id, hostId: host, conversationId: id, messageId: id, title: z.literal('TaroCub'), body: z.string().max(200),
    kind: z.enum(['answer', 'action', 'error']), at: z.number().int().nonnegative(),
  }).strict() }).strict(),
};
export const NOTIFICATION_COMMANDS = Object.freeze(Object.keys(schemas));
export class DesktopNotifications {
  constructor(window, addon, emit) {
    this.window = window; this.addon = addon;
    if (!addon) return;
    addon.initializeNotifications();
    this.timer = setInterval(() => {
      if (window.isDestroyed() || !addon.notificationActivity()) return;
      if (window.isMinimized()) window.restore();
      window.show(); window.focus();
      emit('tarocub-notification-action', null);
    }, 250);
    this.timer.unref();
  }
  async request(command, input) {
    const parsed = schemas[command]?.safeParse(input);
    if (!parsed?.success) throw new Error('invalid_notification');
    const args = parsed.data, addon = this.addon;
    if (!addon) throw new Error('native_notification_unavailable');
    switch (command) {
      case 'desktop_notifications_supported': return true;
      case 'desktop_notification_context': return addon.notificationContext();
      case 'desktop_notification_permission': return addon.notificationPermission(args.request);
      case 'desktop_notification_peek': return JSON.parse(addon.notificationPeek());
      case 'desktop_notification_ack': addon.notificationAck(args.id); return null;
      case 'desktop_notification_clear': return addon.notificationClear(args.hostId ?? null, args.documentId);
      case 'desktop_notification_show': return addon.notificationShow(JSON.stringify(args.notice), args.documentId);
      default: throw new Error('unknown_notification_command');
    }
  }
  retire() { this.addon?.retireNotifications(); }
  dispose() { clearInterval(this.timer); this.retire(); }
}
