import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { HubConnection } from "./connection.js";
import type { WorkbenchController } from "./workbench-controller.js";
import type { WorkbenchContext } from "../../src/client-protocol/workbench.js";

const noSubscription = () => () => {};

/** Loads the workbench only after an explicit entry. Ordinary chat opens no canvas or native page. */
export function useWorkbench(connection: HubConnection, conversationId: string, userId: string | undefined, visible: boolean) {
  const [loadedController, setController] = useState<WorkbenchController>();
  // Effects clear/restore the owner after a selection change. Never expose the
  // previous owner's surface, context or command listener in that first render.
  const controller = loadedController?.connection === connection
    && loadedController.scope === JSON.stringify([connection.identity.hubPublicKey, userId, conversationId]) ? loadedController : undefined;
  const [error, setError] = useState<string>();
  const readExpanded = useCallback(() => {
    const snapshot = controller?.getSnapshot();
    return !!snapshot && (snapshot.layout.expanded || snapshot.layout.tabs.some(tab => snapshot.browserTabs.get(tab.id)?.fullscreen));
  }, [controller]);
  const expanded = useSyncExternalStore(controller?.subscribe ?? noSubscription, readExpanded);
  const owners = useRef(new Map<string, Promise<WorkbenchController>>());
  const instances = useRef(new Set<WorkbenchController>());
  const current = useRef({ connection, conversationId, userId }); current.current = { connection, conversationId, userId };
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // Dispose initialized and initializing owners synchronously. Waiting for
      // initialize() would let an unmounted surface continue restoring pages.
      for (const owner of instances.current) owner.dispose();
      instances.current.clear(); owners.current = new Map();
    };
  }, [connection]);
  const ensure = useCallback(async () => {
    if (!conversationId || !userId || connection.isReadOnly) throw new Error("workbench_identity_unavailable");
    const key = JSON.stringify([connection.identity.hubPublicKey, userId, conversationId]);
    let pending = owners.current.get(key);
    if (!pending) {
      const registry = owners.current;
      pending = import("./workbench-controller.js").then(async module => {
        if (!alive.current || owners.current !== registry || current.current.connection !== connection || current.current.userId !== userId) throw new Error("workbench_scope_changed");
        const created = module.createWorkbenchController({ connection, conversationId });
        instances.current.add(created);
        try { await created.initialize(); return created; }
        catch (cause) { instances.current.delete(created); created.dispose(); throw cause; }
      });
      owners.current.set(key, pending);
      void pending.catch(() => { if (owners.current.get(key) === pending) owners.current.delete(key); });
    }
    const value = await pending;
    if (!alive.current || current.current.connection !== connection || current.current.userId !== userId) { value.dispose(); throw new Error("workbench_scope_changed"); }
    if (current.current.conversationId === conversationId) setController(value);
    return value;
  }, [connection, conversationId, userId]);
  useEffect(() => {
    setController(undefined); setError(undefined);
    const pending = owners.current.get(JSON.stringify([connection.identity.hubPublicKey, userId, conversationId]));
    let valid = true;
    if (pending) void pending.then(value => { if (valid) setController(value); }, cause => {
      if (valid) setError(cause instanceof Error ? cause.message : "workbench_initialize_failed");
    });
    return () => { valid = false; };
  }, [connection, conversationId, userId]);
  useEffect(() => {
    if (!controller) return;
    controller.setVisible(visible);
    let registered: string | undefined, last = "", sessionEpoch = -1, timer: ReturnType<typeof setTimeout> | undefined, disposed = false;
    const available = () => !disposed && !connection.isClosed && !connection.isReadOnly && connection.state.status === "online" && connection.state.workbenchAvailable;
    const publishNow = () => {
      clearTimeout(timer); timer = undefined;
      if (!available()) { last = ""; return; }
      const registration = controller.getRegistration(); if (!registration) return;
      const key = JSON.stringify([connection.sessionEpoch, registration]); if (key === last) return;
      last = key; registered = registration.windowId;
      void connection.send({ v: 1, type: "workbench.register", registration }).catch(() => { if (last === key) last = ""; });
    };
    const publish = () => {
      // Invalidate synchronously: a local reconnect can complete within the
      // content debounce. Host registrations belong to the old WS peer.
      if (!available()) { clearTimeout(timer); timer = undefined; last = ""; return; }
      if (sessionEpoch !== connection.sessionEpoch) {
        sessionEpoch = connection.sessionEpoch; publishNow(); return;
      }
      // Coalesce from the first change. Streaming chat notifications must not
      // keep postponing a new tab/revision indefinitely; read the latest state.
      if (timer === undefined) timer = setTimeout(publishNow, 80);
    };
    const stopController = controller.subscribe(publish), stopConnection = connection.subscribe(publish);
    const stopCommands = connection.subscribeWorkbench(frame => {
      if (frame.type === "workbench.cancel") { controller.cancel(frame); return; }
      if (frame.conversationId !== conversationId || frame.generation !== controller.getSnapshot().generation || frame.target.windowId !== controller.getSnapshot().windowId) return;
      void controller.handleCommand(frame).then(async receipt => {
        // A newly created tab must become addressable before the Bot can issue
        // its next command. Both frames use the same ordered authenticated WS.
        if (!disposed) {
          const registration = controller.getRegistration();
          if (registration) {
            const epoch = connection.sessionEpoch;
            await connection.send({v:1,type:"workbench.register",registration});
            if (connection.sessionEpoch === epoch) last = JSON.stringify([epoch, registration]);
            registered = registration.windowId;
          }
        }
        await connection.send({ v: 1, type: "workbench.receipt", dispatchId: frame.dispatchId, receipt });
      }).catch(cause => {
        if (!disposed) setError(cause instanceof Error ? cause.message : "workbench_command_failed");
      });
    });
    publish();
    return () => {
      disposed = true; clearTimeout(timer); stopController(); stopConnection(); stopCommands(); controller.setVisible(false);
      if (registered) void connection.send({ v: 1, type: "workbench.unregister", windowId: registered }).catch(() => undefined);
    };
  }, [controller, connection, conversationId, visible]);
  const context = useCallback(async (): Promise<WorkbenchContext | undefined> => {
    if (!visible || !controller || !connection.state.workbenchAvailable) return;
    return controller.context();
  }, [visible, controller, connection]);
  return { controller, ensure, context, expanded, error, clearError: () => setError(undefined) };
}
