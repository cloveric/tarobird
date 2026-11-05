import { contextBridge, ipcRenderer } from 'electron';
import { BRIDGE_VERSION, SCREEN_PORT, APP_ORIGIN, NATIVE_REQUEST, NATIVE_BOOTSTRAP, NATIVE_EVENT, DESKTOP_EVENT, DESKTOP_EVENTS, DESKTOP_COMMANDS, VIEW_COMMANDS, isEntryURL, isObject } from './contract.mjs';
import { installExternalLinks } from './external-links.mjs';

// Built as one CJS file for a sandboxed preload. Never expose ipcRenderer,
// Electron event objects, require, filesystem paths or child process handles.
if (process.isMainFrame && isEntryURL(location.href)) {
  let sequence = 0;
  // Captured once per preload document and kept in its isolated world. An old
  // page cannot renew this capability while its navigation is being committed.
  let token;
  const subscriptions = new Map();
  const socketSubscriptions = new Map();
  const desktopListeners = new Map();
  let retired = false;
  addEventListener('pagehide', () => { retired = true; subscriptions.clear(); socketSubscriptions.clear(); desktopListeners.clear(); }, { once: true });
  ipcRenderer.on(SCREEN_PORT, (event, value) => {
    if (retired || !isObject(value) || typeof value.channelId !== 'string' || typeof value.sessionId !== 'string' || event.ports.length !== 1) { for (const port of event.ports) port.close(); return; }
    window.postMessage({ type: SCREEN_PORT, ...value }, APP_ORIGIN, event.ports);
  });
  ipcRenderer.on(DESKTOP_EVENT, (_event, event) => {
    if (retired || !isObject(event) || !DESKTOP_EVENTS.includes(event.name)) return;
    for (const receive of desktopListeners.get(event.name) ?? []) { try { receive(event.payload); } catch { /* independent consumers */ } }
  });
  ipcRenderer.on(NATIVE_EVENT, (_event, event) => {
    if (!isObject(event) || !isObject(event.payload)) return;
    const subscription = subscriptions.get(event.subscription);
    if (!subscription) return;
    if (event.payload.kind === 'close') {
      subscriptions.delete(event.subscription); socketSubscriptions.delete(subscription.id);
    }
    try { subscription.receive(event.payload); } catch { /* consumer failure cannot break other sockets */ }
  });
  const bootstrap = async () => {
    for (let attempt = 0; ; attempt++) {
      if (retired) throw new Error('native_document_retired');
      try {
        const value = await ipcRenderer.invoke(NATIVE_BOOTSTRAP);
        if (retired) throw new Error('native_document_retired');
        return value;
      } catch (error) {
        if (retired || attempt >= 4 || !String(error).includes('native_document_not_committed')) throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  };
  const send = async request => {
    if (retired) throw new Error('native_document_retired');
    if (!token) {
      const pending = bootstrap(); token = pending;
      void pending.catch(() => { if (token === pending) token = undefined; });
    }
    const response = await ipcRenderer.invoke(NATIVE_REQUEST, { ...request, token: await token });
    if (!isObject(response) || typeof response.ok !== 'boolean') throw new Error('invalid_native_response');
    if (!response.ok) throw new Error(typeof response.error === 'string' ? response.error : 'native_request_failed');
    return response.result;
  };
  installExternalLinks(addEventListener, url => send({ command: 'desktop_open_url', args: { url } }));
  contextBridge.exposeInMainWorld('tarobotDesktop', {
    version: BRIDGE_VERSION, engine: 'electron', platform: process.platform,
    on: (name, receive) => {
      if (retired || !DESKTOP_EVENTS.includes(name) || typeof receive !== 'function') throw new Error('invalid_desktop_listener');
      const listeners = desktopListeners.get(name) ?? new Set();
      if (listeners.size >= 256) throw new Error('desktop_listener_limit');
      listeners.add(receive); desktopListeners.set(name, listeners);
      return () => { listeners.delete(receive); };
    },
    invoke: async (command, args = {}) => {
      if (![...VIEW_COMMANDS, ...DESKTOP_COMMANDS].includes(command) || command === 'net_socket_open' || !isObject(args)) throw new Error('unknown_native_command');
      if (command === 'net_document') { subscriptions.clear(); socketSubscriptions.clear(); }
      if (command === 'net_cancel') {
        subscriptions.delete(socketSubscriptions.get(args.id)); socketSubscriptions.delete(args.id);
      }
      return send({ command, args });
    },
    openSocket: async (args, receive) => {
      if (!isObject(args) || typeof args.id !== 'string' || typeof receive !== 'function' || socketSubscriptions.has(args.id)
        || subscriptions.size >= 64) throw new Error('invalid_native_subscription');
      const subscription = ++sequence;
      subscriptions.set(subscription, { id: args.id, receive }); socketSubscriptions.set(args.id, subscription);
      try { return await send({ command: 'net_socket_open', args, subscription }); }
      catch (error) { subscriptions.delete(subscription); socketSubscriptions.delete(args.id); throw error; }
    },
  });
}
