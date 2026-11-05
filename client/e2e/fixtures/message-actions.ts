import { expect, type Locator, type Page } from '@playwright/test';
import { isPhone } from './mobile.js';

/** Phone holds the message; desktop keeps its inline action bar. */
export async function messageAction(page: Page, article: Locator, name: string) {
  const scope = await messageActionScope(page, article);
  await scope.getByRole('button', { name, exact: true }).click();
}

export async function messageActionScope(page: Page, article: Locator) {
  if (isPhone(page)) {
    // The author/time row is a real hit target even for a native audio player
    // which fills the bubble and must keep its playback/seek gestures.
    const audioOnly = await article.locator('audio').count() > 0
      && await article.locator('.markdown,.file-card,.attachment-image').count() === 0;
    await holdMessage(page, article, article.locator(audioOnly ? '.message-meta' : '.message-blocks'));
    const scope = page.getByRole('dialog', { name: '消息操作', exact: true });
    await expect(scope).toBeVisible();
    return scope;
  }
  return article;
}

/** Cross-browser pointer simulation. Trusted Chromium touch has separate coverage. */
export async function holdMessage(page: Page, article: Locator, target = article.locator('.message-blocks')) {
  // Image hydration and the virtualizer can still move this row after chat
  // selection. A hold during movement correctly cancels; start after it settles.
  await expect.poll(() => article.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete))).toBe(true);
  await target.scrollIntoViewIfNeeded();
  await target.click({ trial: true });
  await target.dispatchEvent('pointerdown', { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, clientX: 90, clientY: 220 });
  await expect(page.getByRole('dialog', { name: '消息操作', exact: true })).toBeVisible();
  await target.dispatchEvent('pointerup', { pointerId: 7, pointerType: 'touch', isPrimary: true });
}
