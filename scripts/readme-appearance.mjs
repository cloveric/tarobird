// Documentation fixtures only. These are normal saved App preferences, not
// screenshot-specific CSS or changes to the user's own appearance settings.
import assert from 'node:assert/strict';

export const readmeAvatars = Object.freeze({
  codex: 'pastel-fox', claude: 'peach-patch-cat', kimi: 'cream-bunny',
  deepseek: 'mini-octopus', gemini: 'mini-matcha', agy: 'mini-clownfish',
  studio: 'mini-bluebird',
});

export async function readmePreferences(page, locale, sidebarLayout = 'conversations', theme = 'light') {
  await page.evaluate(async prefs => {
    for (const info of await indexedDB.databases()) {
      if (!info.name?.startsWith('tarocub-')) continue;
      await new Promise((resolve, reject) => {
        const request = indexedDB.open(info.name); request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const store = db.objectStoreNames.contains('settings') ? 'settings' : info.name === 'tarocub-hosts-v1' ? 'meta' : undefined;
          if (!store) { db.close(); resolve(); return; }
          const tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).put(store === 'meta' ? JSON.stringify(prefs) : prefs, 'preferences');
          tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
        };
      });
    }
  }, { locale, theme, palette: 'mono', monoAccent: 'warm-gray', fontSize: 14, sidebarLayout, showModelIcons: true, showDisconnectedBots: true, quietStart: '', quietEnd: '' });
}

export async function readmeAppearance(page) {
  const actual = await page.locator('html').evaluate(html => ({
    palette: html.dataset.palette, monoAccent: html.dataset.monoAccent,
    theme: html.dataset.theme, accentFill: getComputedStyle(html).getPropertyValue('--mono-control-bg').trim(),
  }));
  assert.equal(actual.palette, 'mono');
  assert.equal(actual.monoAccent, 'warm-gray');
  assert.equal(actual.accentFill, '#e7e2dc');
  const layoutSwitches = await page.locator('.sidebar-layout-switch').evaluateAll(nodes =>
    nodes.filter(node => node.getBoundingClientRect().width > 0).map(node => ({
      width: node.clientWidth,
      buttons: [...node.querySelectorAll('button')].map(button => {
        const bounds = button.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(button);
        const content = range.getBoundingClientRect();
        return { label: button.innerText.trim(), width: bounds.width,
          fits: button.scrollWidth <= button.clientWidth && content.left >= bounds.left && content.right <= bounds.right };
      }),
    })));
  for (const group of layoutSwitches) for (const button of group.buttons) {
    assert.ok(button.fits, `Sidebar label overflows its button: ${button.label}`);
  }
  return { ...actual, layoutSwitches };
}

export async function visibleReadmeAvatars(page) {
  const avatars = await page.locator('[data-avatar^="bot:"][data-preset]').evaluateAll(nodes =>
    [...new Set(nodes.filter(node => {
      const r = node.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    }).map(node => node.dataset.preset))]);
  return avatars;
}

// Fold other Bots through the real disclosure controls so every mascot fits.
export async function compactReadmeBots(page, activeBotId) {
  const toggles = page.locator(`.sidebar .bot-tree:not([data-bot-id="${activeBotId}"]) .bot-tree-toggle[aria-expanded="true"]`);
  while (await toggles.count()) await toggles.first().click();
  await page.locator('.sidebar .bot-tree').first().scrollIntoViewIfNeeded();
}
