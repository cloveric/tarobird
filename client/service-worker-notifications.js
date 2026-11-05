// Included verbatim in the generated service worker. Read only the existing
// language preference; do not import App caches, open host stores or create DBs.
function readNotificationPreferences(databaseName, storeName) {
  return new Promise(resolve => {
    let database, finished = false;
    const finish = value => {
      if (finished) return;
      finished = true; clearTimeout(timer); database?.close(); resolve(value);
    };
    // Storage may be blocked by an upgrade or unavailable in a private context.
    // A fallback notification must still appear instead of waiting indefinitely.
    const timer = setTimeout(() => finish(undefined), 1000);
    try {
      const request = indexedDB.open(databaseName);
      request.onupgradeneeded = () => request.transaction.abort();
      request.onerror = () => finish(undefined);
      request.onblocked = () => finish(undefined);
      request.onsuccess = () => {
        database = request.result;
        if (finished) { database.close(); return; }
        if (!database.objectStoreNames.contains(storeName)) { finish(undefined); return; }
        try {
          const transaction = database.transaction(storeName, 'readonly');
          const preference = transaction.objectStore(storeName).get('preferences');
          preference.onsuccess = () => finish(preference.result);
          preference.onerror = () => finish(undefined);
          transaction.onabort = () => finish(undefined);
        } catch { finish(undefined); }
      };
    } catch { finish(undefined); }
  });
}
async function webPushNotificationBody(payload) {
  if (typeof payload.body === 'string') return payload.body.slice(0, 200);
  let preferences = await readNotificationPreferences('tarocub-hosts-v1', 'meta');
  if (!preferences) preferences = await readNotificationPreferences('tarocub-v1', 'settings');
  try { if (typeof preferences === 'string') preferences = JSON.parse(preferences); } catch { preferences = undefined; }
  return preferences?.locale === 'en' ? 'New message received.' : '收到新消息。';
}
