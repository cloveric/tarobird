import { addPassiveAttachments } from "./passive-attachments.js";
import { createRoot } from 'react-dom/client';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { AttachmentImage } from '../../src/AttachmentImage.js';
import { imageExportFilename } from '../../src/image-export.js';
import { setLocale } from '../../src/i18n.js';
import type { HubConnection } from '../../src/connection.js';
import '../../src/styles.css';
import '../../src/brand-theme.css';
import '../../src/palette-tokens.css';
import '../../src/safe-area.css';
import '../../src/viewport.css';
import '../../src/message-images.css';

const parameters = new URLSearchParams(location.search);
const platform = parameters.get('platform') || 'android';
Capacitor.isNativePlatform = () => true; Capacitor.getPlatform = () => platform;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const state = { mode: 'hold', saved: [] as { uri: string; mime: string }[], shared: [] as unknown[], removed: [] as string[], bytes: [] as number[], release: (_value: unknown) => {}, filename: imageExportFilename, setLocale };
Object.assign(window, { imageExport: state });
const filesystem = {
  readdir: async () => ({ files: [] }), mkdir: async () => {}, rmdir: async ({ path }: { path: string }) => { state.removed.push(path); },
  writeFile: async () => { state.bytes = []; },
  appendFile: async ({ data }: { data: string }) => { state.bytes.push(...Uint8Array.from(atob(data), x => x.charCodeAt(0))); },
  getUri: async ({ path }: { path: string }) => ({ uri: `file:///cache/${path}` }),
};
registerPlugin('Filesystem', { web: async () => filesystem, android: async () => filesystem, ios: async () => filesystem });
registerPlugin('TaroBotAttachmentSaver', { web: async () => ({ save: async (args: { uri: string; mime: string }) => {
  state.saved.push(args);
  if (state.mode === 'fail') throw new Error('disk full');
  if (state.mode === 'hold') return new Promise(resolve => { state.release = resolve; });
  return { saved: state.mode !== 'cancel', location: 'Download/TaroBot/说明.png' };
} }) });
registerPlugin('Share', { web: async () => ({ share: async (args: unknown) => { state.shared.push(args); if (state.mode === 'cancel') throw new Error('Share canceled'); } }) });
// Visual review can supply a representative image through the fixture route;
// export regressions retain their tiny, byte-exact original by default.
const connection = { subscribe: () => () => {}, state: { status: 'online' }, blob: async () => parameters.has('preview') ? (await fetch('/preview-fixture.png')).blob() : new Blob([Uint8Array.from(atob(png), x => x.charCodeAt(0))], { type: 'image/png' }) } as unknown as HubConnection;
addPassiveAttachments(connection);
createRoot(document.getElementById('root')!).render(<AttachmentImage connection={connection} id="original" title={parameters.has('preview') ? '截图.png' : '说明'}/>);
