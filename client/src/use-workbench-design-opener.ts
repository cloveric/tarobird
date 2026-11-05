import type { DesignFormat } from "../../src/client-protocol/workbench-design.js";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { HubConnection } from "./connection.js";
import type { WorkbenchContext } from "../../src/client-protocol/workbench.js";
import { WorkbenchDesignOpener, type OpenedDesign } from "./workbench-design-opener.js";
import { isElectron, invoke, listen } from "./desktop-bridge.js";

export function useWorkbenchDesignOpener(connection: HubConnection, conversationId: string, active: boolean, panelVisible: boolean,
  open: (requestId: string, check: () => void, signal: AbortSignal, format?: DesignFormat) => Promise<OpenedDesign>) {
  const scope = JSON.stringify([connection.identity.hubPublicKey, connection.identity.deviceId, connection.state.user?.id, conversationId]);
  const current = useRef({ connection, scope, active, open }); current.current = { connection, scope, active, open };
  const owner = useRef<WorkbenchDesignOpener | undefined>(undefined);
  const previousPanel = useRef({ scope, visible: panelVisible });
  const [revision, setRevision] = useState(0);
  const nativeVisible = useRef(!isElectron());
  const [foreground, setForeground] = useState(() => document.visibilityState === "visible" && nativeVisible.current);
  const revoke = useCallback(() => {
    previousPanel.current = { scope: current.current.scope, visible: false };
    owner.current?.dispose(); owner.current = undefined; setRevision(value => value + 1);
  }, []);
  useEffect(() => {
    let disposed = false, revision = 0, stop: (() => void) | undefined;
    const changed = () => {
      const value = document.visibilityState === "visible" && nativeVisible.current;
      if (!value) { owner.current?.dispose(); owner.current = undefined; }
      setForeground(value);
    };
    // Electron keeps Page Visibility visible with backgroundThrottling:false,
    // even after hiding to the tray. Only a confirmed native-visible window
    // may advertise the automatic Design opener; manual opening is separate.
    if (isElectron()) {
      nativeVisible.current = false; changed();
      const apply = (state: { visible?: boolean; minimized?: boolean }) => {
        nativeVisible.current = state.visible === true && state.minimized === false; changed();
      };
      const read = () => {
        const version = ++revision;
        void invoke<{ visible?: boolean; minimized?: boolean }>("desktop_window_read").then(state => {
          if (!disposed && version === revision) apply(state);
        }, () => { if (!disposed && version === revision) apply({}); });
      };
      void listen<{ visible?: boolean; minimized?: boolean } | null>("window-state", event => {
        if (disposed) return;
        if (typeof event.payload?.visible === "boolean") { revision++; apply(event.payload); }
        // Resize/move events have no visibility change and need no extra IPC.
      }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; }, () => {
        // Without native events a successful initial read could remain stale
        // forever. Fail closed for automatic opening, not for ordinary chat.
        if (!disposed) { revision++; apply({}); }
      });
      read();
    }
    document.addEventListener("visibilitychange", changed);
    return () => { disposed = true; revision++; stop?.(); document.removeEventListener("visibilitychange", changed); };
  }, []);
  useLayoutEffect(() => {
    const old = previousPanel.current;
    previousPanel.current = { scope, visible: panelVisible };
    if (old.scope === scope && old.visible && !panelVisible) revoke();
  }, [scope, panelVisible, revoke]);
  useEffect(() => {
    if (!active || !foreground || !conversationId || !connection.state.user || !connection.state.workbenchDesignOpenAvailable) return;
    const eligible = () => current.current.connection === connection && current.current.scope === scope && current.current.active && nativeVisible.current && document.visibilityState === "visible";
    const endpoint = new WorkbenchDesignOpener(connection, conversationId, {
      eligible,
      open: (requestId, check, signal, format) => current.current.open(requestId, check, signal, format),
    });
    owner.current = endpoint;
    return () => { if (owner.current === endpoint) owner.current = undefined; endpoint.dispose(); };
  }, [connection, conversationId, scope, active, foreground, revision, connection.state.workbenchDesignOpenAvailable]);
  const context = useCallback(async (existing?: WorkbenchContext) => {
    if (current.current.scope !== scope || current.current.connection !== connection) return existing;
    return owner.current?.context(existing) ?? existing;
  }, [scope, connection]);
  return { context, revoke };
}
