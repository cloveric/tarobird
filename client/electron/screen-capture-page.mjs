// Isolated capture renderer (tarobot-screen://capture). No App bridge, no
// network, no Node. Main hands over one MessagePort; everything arrives and
// leaves through it. Main chooses the display; getDisplayMedia here never
// shows a picker because main answers the request with that bound source.
import { writeScreenFrame } from '../../src/client-protocol/screen-wire.ts';
import { createCaptureCore } from './screen-capture-core.mjs';

let port;
addEventListener('message', event => {
  if (port || event.source !== window || event.data?.type !== 'tarobot-screen-port' || event.ports.length !== 1) return;
  port = event.ports[0];
  const core = createCaptureCore({ send: message => port.postMessage(message), getDisplayMedia: constraints => navigator.mediaDevices.getDisplayMedia(constraints),
    VideoEncoder, VideoFrame, OffscreenCanvas, MediaStreamTrackProcessor, writeScreenFrame });
  port.onmessage = ({ data }) => { void core.handle(data); };
  port.postMessage({ type: 'ready' });
});
