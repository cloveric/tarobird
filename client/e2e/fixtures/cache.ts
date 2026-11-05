import type { Page } from '@playwright/test';

/** Inspect the database registered for this paired host instead of assuming
 * the original default name. Fail rather than silently choosing among hosts. */
export async function singleHostCacheName(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve,reject) => {
      const request = indexedDB.open('tarocub-hosts-v1');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const hosts = await new Promise<{databaseName:string}[]>((resolve,reject) => {
        const request = db.transaction('hosts').objectStore('hosts').getAll();
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      if (hosts.length !== 1) throw new Error(`Expected one host cache, found ${hosts.length}`);
      return hosts[0]!.databaseName;
    } finally { db.close(); }
  });
}
