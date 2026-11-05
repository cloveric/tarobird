import { ipcRenderer } from 'electron';
import { CAPTURE_PORT_CHANNEL, CAPTURE_URL } from './screen-capture-contract.mjs';

// Sandboxed preload for the capture renderer only. It exposes no API: it hands
// the single main-created MessagePort to the page and nothing else.
if (process.isMainFrame && location.href === CAPTURE_URL) {
  ipcRenderer.once(CAPTURE_PORT_CHANNEL, event => {
    if (event.ports.length === 1) window.postMessage({ type: 'tarobot-screen-port' }, '*', event.ports);
  });
}
