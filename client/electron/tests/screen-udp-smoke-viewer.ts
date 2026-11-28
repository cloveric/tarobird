import { RemoteScreenViewer, type ViewerState } from '../../src/remote-screen-viewer.js';
import type { ScreenViewerTransport } from '../../src/screen-viewer-transport.js';
import type { ScreenRtcSignaling } from '../../src/screen-rtc-receiver.js';
import { SCREEN_RTC_SEQUENCE_START } from '../../../src/client-protocol/screen-rtc.js';
import type { ScreenJoin } from '../../../src/client-protocol/remote-screen.js';

const state = { value: undefined as ViewerState | undefined, tcpAcks: 0, udpAcks: 0, closed: 0, lastTcpAt: 0, lastUdpAt: 0, ready: false, rtcFrames: 0, closeCode: "", attached: 0 };
const canvas = document.querySelector('canvas')!;
const post = async (path: string, body?: unknown) => {
  const response = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`fixture HTTP ${response.status}`);
  return response.json();
};
const { join, url } = await post('/fixture') as { join: ScreenJoin; url: string };
const signaling: ScreenRtcSignaling = {
  request: (request) => {
    // The fixture selects a route while keeping real UDP sockets and signaling.
    // The standard app path supplies every attempt to the same Hub endpoint.
    if (request.type === 'prepare' && request.mode !== new URLSearchParams(location.search).get('mode')) return Promise.reject(new Error('other route'));
    return post('/signal', request);
  },
  signOffer: (scope, nonce, mode, sdp) => post('/sign', { sessionId: scope.id, generation: scope.generation, nonce, mode, sdp }),
  verifyAnswer: (text, signature) => {
    // The fixture verifies the Hub key through the same verifier as production.
    return verifyAnswer(text, signature);
  },
};
import { verifyEd25519 } from '../../src/native.js';
const hubKey: string = await post('/identity');
const verifyAnswer = (text: string, signature: string) => verifyEd25519(hubKey, signature, new TextEncoder().encode(text));

const transport: ScreenViewerTransport = session => {
  let receive: (value: unknown) => void, closed = false;
  function socket(kind: 'control' | 'media', ticket: string) {
    const connection = new WebSocket(url + '/screen/v1/' + kind);
    connection.binaryType = 'arraybuffer';
    connection.onopen = () => connection.send(JSON.stringify({ type: 'hello', ticket }));
    connection.onmessage = ({ data }) => {
      const event = typeof data === 'string' ? JSON.parse(data) : data;
      if (event?.type === 'rtc-frame') state.rtcFrames++;
      if (event?.type === 'attached') state.attached++;
      receive(event);
    };
    connection.onclose = event => { if (!closed) { state.closed++; state.closeCode = String(event.reason || event.code); } };
    return connection;
  }
  let control: WebSocket, media: WebSocket;
  return {
    async open(_network, events) {
      control = socket('control', session.controlTicket);
      media = socket('media', session.mediaTicket);
      events.attach({
        start: callback => { receive = callback; },
        close: () => { closed = true; control.close(); media.close(); },
        postMessage: message => {
          if (message.type === 'ack') {
            if (Number(message.frameSequence) >= SCREEN_RTC_SEQUENCE_START) { state.udpAcks++; state.lastUdpAt = performance.now(); }
            else { state.tcpAcks++; state.lastTcpAt = performance.now(); }
          }
          if (control.readyState === WebSocket.OPEN && message.type !== 'received' && message.type !== 'input-focus') control.send(JSON.stringify(message));
        },
      });
    },
    close: () => { closed = true; control.close(); media.close(); },
  };
};
const viewer = new RemoteScreenViewer(join, canvas, value => { state.value = value; }, {
  transport, inputActive: () => true, rtcSignaling: signaling, udpRequested: true, serverTimeOffsetMs: 0,
});
Object.assign(window, { receipt: state, viewer });
await viewer.open(undefined);
state.ready = true;
