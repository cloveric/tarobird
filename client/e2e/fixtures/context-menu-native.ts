import type { PredefinedMenuItemOptions } from "@tauri-apps/api/menu/predefinedMenuItem";
export const bridge = { calls: [] as { kind: string; items?: PredefinedMenuItemOptions[] }[], pending: undefined as (() => void) | undefined, hold: false, fail: false };
export class Menu {
  static async new({ items }: { items: PredefinedMenuItemOptions[] }) {
    bridge.calls.push({ kind: "new", items });
    if (bridge.hold) await new Promise<void>(resolve => { bridge.pending = resolve; });
    if (bridge.fail) throw new Error("test menu failure");
    return new Menu();
  }
  async popup() { bridge.calls.push({ kind: "popup" }); }
  async close() { bridge.calls.push({ kind: "close" }); }
}
