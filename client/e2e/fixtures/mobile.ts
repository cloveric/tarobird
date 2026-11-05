import { expect, type Page } from '@playwright/test';
import { revealDesktopAction, dismissReplyBots } from './desktop-actions.js';
export const mobileHome = (page: Page) => page.locator('.host-workspace:not([hidden]) .mobile-home');
export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1360) <= 760;
/** Connection state remains available in the mounted workspace; the phone
 * deliberately keeps its desktop header hidden while showing the IM inbox. */
export async function waitForClientOnline(page: Page) {
  const workspace = page.locator('.host-workspace:not([hidden])');
  await expect(workspace.locator('.connection-pill.online')).toBeAttached();
  await expect(workspace.locator('.app-shell')).toBeVisible();
  if (!isPhone(page)) await expect(workspace.locator('.connection-pill.online')).toBeVisible();
}
export async function openMobileHome(page: Page) {
  if (!isPhone(page)) return;
  await dismissReplyBots(page);
  const detailsBack = page.getByRole('button', {name:'返回聊天',exact:true});
  if (await detailsBack.isVisible()) await detailsBack.click();
  const back = page.getByRole('button', {name:'打开会话列表',exact:true});
  if (await back.isVisible()) await back.click();
  await expect(mobileHome(page)).toBeVisible();
  // The lazy-loading fallback also has .mobile-home. Wait for the actual tab
  // before helpers choose between the messages options sheet and Bot controls.
  await expect(mobileHome(page)).toHaveAttribute('data-tab', /^(messages|bots|me)$/);
}
/** Historical-message fixtures deliberately have no connected Gateway. Keep
 * opting into their cached Bots explicit; presence/default tests never call it. */
export async function showDisconnectedBots(page: Page) {
  await openMobileHome(page);
  if (isPhone(page)) await mobileHome(page).getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^消息/ }).click();
  await setListOption(page, '显示未连接 Bot', true);
  // A number of history journeys immediately reload after this explicit opt-in.
  await expect.poll(() => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('tarocub-hosts-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { return await new Promise<boolean>((resolve, reject) => { const request = db.transaction('meta').objectStore('meta').get('preferences'); request.onsuccess = () => resolve(!!request.result && JSON.parse(request.result).showDisconnectedBots === true); request.onerror = () => reject(request.error); }); }
    finally { db.close(); }
  })).toBe(true);
}
export async function selectConversation(page: Page, title: string, parentTitle?: string) {
  if (isPhone(page)) {
    await openMobileHome(page);
    await mobileHome(page).getByRole('navigation', {name:'主导航'}).getByRole('button', {name:/^消息/}).click();
    await mobileHome(page).locator('.mh-row').filter({has:page.getByText(parentTitle ?? title,{exact:true})}).click();
    if (parentTitle) {
      await page.getByRole('button', {name:'全部话题',exact:true}).click();
      await page.getByRole('dialog', {name:'群内话题',exact:true}).locator('.topic-directory-row').filter({has:page.getByText(title,{exact:true})}).click();
    }
  } else await page.locator('.conversation-row').filter({has:page.getByText(title,{exact:true})}).click();
  await expect(page.getByRole('heading', {name:title,exact:true,level:1})).toBeVisible();
}
export async function openWorkspacePage(page: Page, name: string) {
  if (isPhone(page)) {
    await openMobileHome(page);
    await mobileHome(page).getByRole('navigation', {name:'主导航'}).getByRole('button', {name:'我的',exact:true}).click();
    await mobileHome(page).getByRole('button', {name,exact:true}).click();
  } else {
    await revealDesktopAction(page, name);
    await page.getByRole('button', {name,exact:true}).filter({visible:true}).click();
  }
}
/** The phone lands on its IM inbox; opening a conversation is an explicit action. */
export async function enterMobileChat(page: Page, title: string) {
  if ((page.viewportSize()?.width ?? 1360) > 760) return;
  await expect(mobileHome(page)).toBeVisible();
  await mobileHome(page).getByRole('button').filter({has:page.getByText(title,{exact:true})}).click();
}
export async function mobileChatAction(page: Page, name: string) {
  if (['对话设置', '调整 Bot 思考强度'].includes(name) && !await page.getByRole('button',{name,exact:true}).filter({visible:true}).count()) {
    await page.getByRole('button',{name:'查看对话详情',exact:true}).click();
  }
  if (name === '调整 Bot 思考强度' && !await page.getByRole('button',{name,exact:true}).filter({visible:true}).count()) await page.getByRole('button',{name:'Bot 设置',exact:true}).click();
  if (!await page.getByRole('button',{name,exact:true}).filter({visible:true}).count()) await page.getByRole('button',{name:'更多聊天操作',exact:true}).filter({visible:true}).click();
  await page.getByRole('button',{name,exact:true}).filter({visible:true}).click();
}

export async function openMobileSearch(page: Page) {
  const trigger = mobileHome(page).getByRole('button', { name: '搜索会话或 Bot', exact: true });
  if (await trigger.isVisible()) await trigger.click();
}

/** Phone messages put device list settings inside the same options sheet. */
export async function openMobileListOptions(page: Page) {
  if (!isPhone(page)) return;
  const dialog = page.getByRole('dialog', { name: '列表选项', exact: true });
  if (!await dialog.isVisible()) await mobileHome(page).getByRole('button', { name: '列表选项', exact: true }).click();
  await expect(dialog).toBeVisible();
}
export async function closeMobileListOptions(page: Page) {
  const dialog = page.getByRole('dialog', { name: '列表选项', exact: true });
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: '关闭列表选项', exact: true }).click();
}
export async function openDesktopListOptions(page: Page) {
  const menu = page.getByRole('menu', { name: '列表选项', exact: true });
  if (!await menu.isVisible()) {
    const directory = page.locator('.sidebar-list-context').filter({ visible: true });
    // Keyboard focus alone does not wait for a pending viewport/Host transition.
    // Match pointer actionability before opening a menu that closes on resize.
    await directory.click({ trial: true, position: { x: 1, y: 1 } });
    await directory.focus(); await page.keyboard.press('Shift+F10');
  }
  await expect(menu).toBeVisible();
  return menu;
}
async function closeListOptions(page: Page) {
  if (isPhone(page)) await closeMobileListOptions(page);
  else if (await page.getByRole('menu', { name: '列表选项', exact: true }).isVisible()) await page.keyboard.press('Escape');
}
async function listOption(page: Page, name: string) {
  if (!isPhone(page)) return (await openDesktopListOptions(page)).getByRole('checkbox', { name, exact: true });
  const home = mobileHome(page);
  if (isPhone(page) && await home.getAttribute('data-tab') === 'messages') await openMobileListOptions(page);
  return (isPhone(page) ? home : page.locator('.host-workspace:not([hidden]) .sidebar')).getByRole('checkbox', { name, exact: true });
}
export async function setListOption(page: Page, name: string, checked: boolean) {
  const option = await listOption(page, name);
  // Regrouping dismisses the context menu when its original section is replaced.
  // Click the requested transition; do not require a detached checkbox to persist.
  if (await option.isChecked() !== checked) await option.click();
  await closeListOptions(page);
}
export async function expectListOption(page: Page, name: string, checked: boolean) {
  await expect(await listOption(page, name)).toBeChecked({ checked });
  await closeListOptions(page);
}
export async function openFolderManager(page: Page, hostName?: string) {
  if (!isPhone(page)) {
    await (await openDesktopListOptions(page)).getByRole('button', { name: '管理分组', exact: true }).click();
    return;
  }
  await openMobileListOptions(page);
  await page.getByRole('button', { name: hostName ? `管理 ${hostName} 的分组` : '管理分组', exact: true }).filter({ visible: true }).click();
}
