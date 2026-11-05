import { z } from 'zod';
import { screenQualityProfile } from '../../src/client-protocol/screen-quality.ts';
import { WebSocket } from 'ws';
import { screenJoinSchema, screenStreamSchema, screenViewerCommandSchema, screenViewerEventSchema } from '../../src/client-protocol/remote-screen.ts';
import { readScreenFrame } from '../../src/client-protocol/screen-wire.ts';
import { openScreenSocket, screenNetworkSchema, screenPin, screenRoute } from './screen-network.mjs';
import { SCREEN_PORT } from './contract.mjs';
const argsSchema = z.object({ channelId: z.string().uuid(), network: screenNetworkSchema, join: screenJoinSchema }).strict();

/** Per-document viewer; neither its port nor its short tickets outlive the page. */
export class ScreenViewers {
  constructor(window, electron) { this.window = window; this.electron = electron; this.viewers = new Map(); this.epoch = 0; }
  async open(raw, active) {
    const args = argsSchema.parse(raw), epoch = this.epoch, id = args.join.session.id;
    const limit=screenQualityProfile(args.join.quality);
    const checkQuality=value=>{
      if(Math.max(value.width,value.height)>limit.longEdge||value.width*value.height>limit.area||limit.h264Only&&value.codec!=='h264')throw new Error('screen_stream_invalid');
    };
    if (this.viewers.size >= 2 || this.viewers.has(id)) throw new Error('screen_viewers_full');
    const abort = new AbortController(), viewer = { args, abort, pending: new Map(), visible: true, controlReady: false, inputFocused: false, canControl: false, queued: [], queuedBytes: 0 };
    this.viewers.set(id, viewer);
    const current = () => active() && this.epoch === epoch && this.viewers.get(id) === viewer && !abort.signal.aborted && !this.window.isDestroyed();
    const fail = reason => this.close(id, reason);
    try {
      const route = screenRoute(args.network), pin = await screenPin(route, abort.signal);
      if (!current()) throw new Error('native_document_retired');
      const { port1, port2 } = new this.electron.MessageChannelMain(); viewer.port = port1;
      const post = value => { if (!current()) return; try { port1.postMessage(value); } catch { fail('screen_port_failed'); } };
      viewer.post = post;
      const send = value => {
        if (!current()) return;
        const text = JSON.stringify(value), bytes = Buffer.byteLength(text);
        if (bytes > 16384) { fail('screen_control_size'); return; }
        // Renderer visibility/release may arrive before the authenticated hello
        // completes. Keep this tiny, bounded queue until the control attached
        // receipt; sending during Hub authentication would close the socket.
        if (!viewer.controlReady) {
          if (viewer.queued.length >= 8 || viewer.queuedBytes + bytes > 16384) { fail('screen_control_backpressure'); return; }
          viewer.queued.push(value); viewer.queuedBytes += bytes; return;
        }
        if (viewer.control?.readyState !== WebSocket.OPEN || viewer.control.bufferedAmount + bytes > 16384) { fail('screen_control_closed'); return; }
        try { viewer.control.send(text, error => { if (error) fail('screen_control_closed'); }); }
        catch { fail('screen_control_closed'); }
      };
      const base = { sessionId: id, generation: args.join.session.generation };
      viewer.send = send;
      port1.on('message', ({ data }) => {
        try {
          if (!current() || !data || typeof data !== 'object' || JSON.stringify(data).length > 16384) throw new Error('screen_port_invalid');
          if (data.type === 'received' && Number.isSafeInteger(data.sequence) && Object.keys(data).length === 2) { viewer.pending.delete(data.sequence); return; }
          if (data.type === 'input-focus') {
            if (Object.keys(data).length !== 4 || typeof data.enabled !== 'boolean' || data.sessionId !== id || data.generation !== base.generation) throw new Error('screen_port_invalid');
            viewer.inputFocused = data.enabled && viewer.canControl && viewer.visible && this.window.isFocused() && this.window.isVisible() && !this.window.isMinimized();
            this.syncMenuShortcuts(); return;
          }
          const command = screenViewerCommandSchema.parse(data);
          if (command.sessionId !== id || command.generation !== base.generation) throw new Error('screen_session_changed');
          if (['input', 'control', 'renew'].includes(command.type) && (!viewer.visible || !this.window.isFocused() || !this.window.isVisible() || this.window.isMinimized())) { send({ type: 'release', ...base }); return; }
          if (command.type === 'visibility') viewer.visible = command.visible;
          if (['release', 'disconnect'].includes(command.type) || command.type === 'visibility' && !command.visible) { viewer.inputFocused = false; viewer.canControl = false; this.syncMenuShortcuts(); }
          send(command);
        } catch { fail('screen_port_invalid'); }
      });
      port1.on('close', () => fail('screen_viewer_closed')); port1.start();
      viewer.control = openScreenSocket(route, pin, 'control', args.join.controlTicket, { signal: abort.signal, close: fail, receive: value => {
        const event = screenViewerEventSchema.parse(value);
        if (event.type === 'state' ? event.session.id !== id || event.session.generation !== base.generation : event.sessionId !== id) throw new Error('screen_session_changed');
        if (event.type === 'state') { viewer.canControl = event.session.state === 'controlling' && !!event.lease; if (!viewer.canControl) { viewer.inputFocused = false; this.syncMenuShortcuts(); } }
        if (event.type === 'attached') {
          if (viewer.controlReady) throw new Error('screen_control_attached_twice');
          viewer.controlReady = true;
          const queued = viewer.queued.splice(0); viewer.queuedBytes = 0;
          for (const value of queued) send(value);
        }
        post(event);
      } });
      viewer.media = openScreenSocket(route, pin, 'media', args.join.mediaTicket, { signal: abort.signal, close: fail, receive: value => {
        if (value instanceof Uint8Array) {
          const header = readScreenFrame(value);checkQuality(header);
          if (viewer.pending.size >= 3) { fail('screen_viewer_congested'); return; }
          viewer.pending.set(header.sequence, Date.now());
          // Electron MessagePortMain structured clones ArrayBuffers (no video JSON).
          // At most three packets may be awaiting receipt in this hop.
          post(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
        } else if (value.type === 'attached') { if (screenViewerEventSchema.parse(value).sessionId !== id) throw new Error('screen_session_changed'); }
        else {const stream=screenStreamSchema.parse(value);checkQuality(stream);post(stream);}
      } });
      viewer.timer = setInterval(() => { if ([...viewer.pending.values()].some(at => Date.now() - at > 2000)) fail('screen_viewer_congested'); }, 500); viewer.timer.unref();
      // Window events can arrive while TLS pinning is pending, before post/send
      // exist. Take a fresh snapshot in both directions before port handoff.
      viewer.visible = this.window.isVisible() && !this.window.isMinimized();
      if (!viewer.visible) {
        post({ type: 'native-visibility', visible: false });
        send({ type: 'visibility', ...base, visible: false });
      }
      this.window.webContents.postMessage(SCREEN_PORT, { channelId: args.channelId, sessionId: id }, [port2]);
      return { sessionId: id };
    } catch (error) { fail('screen_open_failed'); throw error; }
  }
  syncMenuShortcuts() {
    if (!this.window.isDestroyed()) this.window.webContents.setIgnoreMenuShortcuts?.(
      [...this.viewers.values()].some(viewer => viewer.inputFocused && viewer.canControl && viewer.visible));
  }
  visibility(id, visible) {
    const viewer = this.viewers.get(id); if (!viewer) return;
    viewer.visible = visible; if (!visible) { viewer.inputFocused = false; viewer.canControl = false; this.syncMenuShortcuts(); }
    viewer.send?.({ type: 'visibility', sessionId: id, generation: viewer.args.join.session.generation, visible });
  }
  windowVisibility(visible) {
    for (const [id, viewer] of this.viewers) {
      // Notify the document too: its decoder generation must retire on native
      // hide, and show must restore only the panel visibility it requested.
      viewer.post?.({ type: "native-visibility", visible });
      if (!visible) this.visibility(id, false);
    }
  }
  releaseAll() {
    for (const [id, viewer] of this.viewers) { viewer.inputFocused = false; viewer.canControl = false; viewer.send?.({ type: 'release', sessionId: id, generation: viewer.args.join.session.generation }); }
    this.syncMenuShortcuts();
  }
  close(id, reason = 'screen_disconnected') {
    const viewer = this.viewers.get(id); if (!viewer) return;
    this.viewers.delete(id); this.syncMenuShortcuts(); clearInterval(viewer.timer);
    try { viewer.port?.postMessage({ type: 'closed', reason }); } catch {}
    viewer.abort.abort(); viewer.port?.close(); viewer.pending.clear(); viewer.queued.length = 0; viewer.queuedBytes = 0;
  }
  retire() { this.epoch++; for (const id of this.viewers.keys()) this.close(id, 'native_document_retired'); }
}
