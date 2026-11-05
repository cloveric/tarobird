// Intentionally separate entry. Importing HostApp/ClientCache/HostRegistry here
// could connect or mutate the source before the read-only snapshot is complete.
import { invoke } from '@tauri-apps/api/core';
import { exportDesktopData, indexedDbExportSource, migrationExportError, tauriExportSink } from './desktop-migration-export.js';
import { REGISTRY_DATABASE } from './desktop-migration-format.js';

async function run() {
  const source = indexedDbExportSource();
  const sourceExists = await source.database(REGISTRY_DATABASE) || await source.database('tarocub-v1')
    || [...source.localStorage()].some(([key]) => /^(tarocub|tarobot)/.test(key));
  // A wrong origin/profile must never be accepted as a successful empty import.
  if (!sourceExists) throw new Error('migration_source_empty');
  const sink = tauriExportSink(async (command, args, options) => {
    const result = await invoke(command, args, options?.headers ? { headers: options.headers } : undefined);
    await invoke('migration_export_progress');
    return result as never;
  });
  const mode = await invoke<{ appVersion: string }>('desktop_migration_mode');
  const result = await exportDesktopData(source, sink, { appVersion: mode.appVersion });
  if (result.state !== 'exported') throw new Error('migration_source_empty');
  await invoke('migration_export_finished', { exportId: result.exportId });
}
void run().catch(async error => {
  await invoke('migration_export_finished', { error: migrationExportError(error) });
});
