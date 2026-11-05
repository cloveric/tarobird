import { addPassiveAttachments } from "./passive-attachments.js";
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { useAttachment } from '../../src/use-attachment.js';
import { AttachmentImage } from '../../src/AttachmentImage.js';
import { ImageGalleryContext } from '../../src/image-gallery.js';
import { setLocale } from '../../src/i18n.js';
import type { HubConnection } from '../../src/connection.js';
import '../../src/styles.css';
import '../../src/brand-theme.css';
import '../../src/palette-tokens.css';
import '../../src/safe-area.css';
import '../../src/viewport.css';
import '../../src/message-images.css';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const listeners = new Set<() => void>();
const state = { setStatus: (status: string) => { connection.state.status = status as typeof connection.state.status; listeners.forEach(notify => notify()); }, failures: new Set(['3', '4']), corrupt: new Set<string>(), calls: {} as Record<string, number>, hold: false, release: () => {}, setLocale };
Object.assign(window, { imageRecovery: state });
const connection = { subscribe: (notify: () => void) => { listeners.add(notify); return () => listeners.delete(notify); }, state: { status: 'online' }, blob: async (id: string) => {
  state.calls[id] = (state.calls[id] || 0) + 1;
  if (state.hold) await new Promise<void>(resolve => { state.release = resolve; });
  if (state.failures.has(id)) throw new Error('unexpected end of stream on https://203.0.113.10:8443/private-path-that-must-not-overflow-the-picture');
  if (state.corrupt.has(id)) return new Blob(['invalid image fixture'], { type: 'image/png' });
  return new Blob([Uint8Array.from(atob(png), x => x.charCodeAt(0))], { type: 'image/png' });
} } as unknown as HubConnection;
addPassiveAttachments(connection);
const images = ['1', '2', '3', '4'].map(id => ({ id, title: `图片 ${id}` }));
function ResourceProbe() {
  const [enabled, setEnabled] = useState(false);
  const resource = useAttachment(connection, '5', enabled);
  Object.assign(window, { resourceProbe: { setEnabled, url: resource.url, hasBlob: !!resource.blob } });
  return null;
}
createRoot(document.getElementById('root')!).render(<main style={{ padding: 16, maxWidth: 480 }}><ResourceProbe/><article className="message bot"><ImageGalleryContext.Provider value={images}><div className="image-grid">{images.map(image => <AttachmentImage key={image.id} connection={connection} {...image}/>)}</div></ImageGalleryContext.Provider></article></main>);
