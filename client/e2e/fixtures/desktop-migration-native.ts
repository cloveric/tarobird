import { invoke } from '@tauri-apps/api/core';
import { HostRegistry } from '../../src/host-registry.js';
import { exportDesktopData, indexedDbExportSource, tauriExportSink } from '../../src/desktop-migration-export.js';

async function run() {
  const registry = new HostRegistry();
  const spki = btoa(String.fromCharCode(...[0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00], ...new Uint8Array(32).fill(7)));
  const record = await registry.add({ deviceId: 'device_migration_acceptance', keyRef: 'device_migration_acceptance',
    name: '隔离迁移验收', platform: 'macos', publicKey: spki, hubPublicKey: spki, routes: [] }, 'Migration acceptance');
  await registry.recoverPreparations();
  const handle = await registry.open(record.id);
  await handle.cache.enqueue({ v: 1, type: 'message.send', conversationId: 'conv_migration', clientMsgId: 'client_migration_once', text: '保留队列，不重新发送' });
  await handle.cache.saveDraft('conv_migration', '来自 WKWebView 的草稿');
  const bytes = new Uint8Array(150_000).map((_, i) => i % 251);
  await handle.cache.saveConversationDraft('conv_migration', { files: [new File([bytes], '迁移附件.txt', { type: 'text/plain', lastModified: 1700000000000 })], previewStyle: 'card' }, handle.identity);
  const preferences = await registry.preferences(); await registry.savePreferences({ ...preferences, theme: 'dark', fontSize: 17 });
  await registry.selectHost(record.id); handle.cache.close(); registry.close();
  localStorage.setItem('tarobot-migration-acceptance', 'retain');
  localStorage.setItem('unrelated-acceptance', 'omit');
  if (await invoke<boolean>('audit_mode')) {
    await invoke('audit_result', { value: { passed: true, seeded: true, hostId: record.id, databaseName: record.databaseName, origin: location.origin } });
    return;
  }
  const result = await exportDesktopData(indexedDbExportSource(), tauriExportSink((command, args, options) => invoke(command, args, options?.headers ? { headers: options.headers } : undefined)), { appVersion: '1.0.120' });
  const status = await invoke<{ exports: string[] }>('desktop_migration_status');
  if (result.state !== 'exported' || status.exports[0] !== result.exportId) throw new Error('native_export_receipt_missing');
  await invoke('audit_result', { value: { passed: true, hostId: record.id, databaseName: record.databaseName, result } });
}
void run().catch(async error => { await invoke('audit_result', { value: { passed: false, error: String(error) } }); });
