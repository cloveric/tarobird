import { MAX_TEXT_BYTES } from '../../src/client-protocol/index.js';
import { t } from './i18n.js';

/** Check before uploading or pinning attachments, and before protocol parsing. */
export function assertMessageTextSize(text: string): void {
  if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) throw new Error(t('消息过大，请作为文件发送'));
}
