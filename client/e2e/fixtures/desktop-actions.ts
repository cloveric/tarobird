import { type Locator, type Page } from '@playwright/test';

/** Follow the same progressive-disclosure route as a user. Component fixtures
 * and already-open dialogs keep their direct controls; phone helpers own IM navigation. */
export async function revealDesktopAction(page: Page, name: string) {
  if ((page.viewportSize()?.width ?? 1360) <= 760) return;
  if (await page.getByRole('button', { name, exact: true }).filter({ visible: true }).count()) return;
  if (['新建对话', '新建 Bot', '新建群组', '新建定时任务'].includes(name)) {
    await page.getByRole('button', { name: '新建', exact: true }).filter({ visible: true }).click();
  } else if (['连接状态与线路', 'Connection status & routes', '定时任务', '文件中心', 'Skills 与 MCP', '运行状态', '设备与网络', '连接另一台主机', '已归档对话', 'Operations', 'File center', 'Skills & MCP'].includes(name)) {
    await page.getByRole('button', { name: /^(工作台：|Workspace:)/ }).filter({ visible: true }).click();
  } else if (name === '对话设置' || name === '调整 Bot 思考强度') {
    await page.getByRole('button', { name: '查看对话详情', exact: true }).filter({ visible: true }).click();
  } else if (name === '全部话题') {
    // Desktop's labelled topic switcher opens the same directory as the phone strip.
    await page.locator('.host-workspace:not([hidden]) .header-topic, body:not(:has(.host-workspace)) .header-topic').click();
  } else {
    await page.getByRole('button', { name: '更多聊天操作', exact: true }).filter({ visible: true }).click();
  }
}

export async function clickAppAction(page: Page, name: string, target?: Locator) {
  if ((page.viewportSize()?.width ?? 1360) <= 760 && ['引导当前任务', '停止当前轮次'].includes(name) && !await page.getByRole('button', { name, exact: true }).filter({ visible: true }).count()) {
    await page.getByRole('button', { name: '更多聊天操作', exact: true }).click();
  }
  if (name === '全部话题' && (page.viewportSize()?.width ?? 1360) > 760) {
    await revealDesktopAction(page, name);
    return;
  }
  await revealDesktopAction(page, name);
  await (target ?? page.getByRole('button', { name, exact: true }).filter({ visible: true })).click();
}

export async function revealReplyBots(page: Page) {
  const toggle = page.getByRole('button', { name: /^让谁回复：/ }).filter({ visible: true });
  const choices = page.getByRole('group', { name: '回复的 Bot', exact: true }).or(page.getByRole('dialog', { name: '回复的 Bot', exact: true })).getByRole('checkbox');
  if (await toggle.count() && !await choices.filter({ visible: true }).count()) await toggle.click();
}

export async function dismissReplyBots(page: Page) {
  const close = page.getByRole('button', { name: '关闭回复选择', exact: true });
  if (await close.isVisible()) await close.click();
  else {
    const trigger = page.getByRole('button', { name: /^让谁回复：/ }).filter({visible:true});
    if (await trigger.count() && await trigger.getAttribute('aria-expanded') === 'true') await trigger.click();
  }
}
