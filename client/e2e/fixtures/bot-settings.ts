import { type Page } from '@playwright/test';

/** Bot configuration lives beside conversation settings in the details page. */
export async function openBotSettings(page: Page) {
  const manage = page.getByRole('button', { name: '关闭对话设置', exact: true });
  if (await manage.isVisible()) await manage.click();
  const settings = page.getByRole('button', { name: 'Bot 设置', exact: true });
  if (!await settings.isVisible()) await page.getByRole('button', { name: '查看对话详情', exact: true }).click();
  await settings.click();
}

export async function closeBotSettings(page: Page) {
  await page.getByRole('button', { name: '关闭 Bot 设置', exact: true }).click();
  await page.getByRole('button', { name: /^(返回聊天|关闭对话详情)$/ }).click();
}
