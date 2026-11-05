import { test, expect } from '@playwright/test';
import { imageViewerFixture } from './fixtures/image-viewer.js';

test('desktop adds the selected original to a whiteboard through the image context menu', async ({page},info) => {
  const f=await imageViewerFixture(page);
  try {
    await expect(page.locator('.workbench-add-image')).toHaveCount(0);
    const image=page.getByRole('button',{name:'第二张',exact:true});
    await image.click({button:'right'});
    const menu=page.getByRole('menu',{name:'图片操作',exact:true});
    await expect(menu.getByRole('menuitem',{name:'放到白板',exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath('image-whiteboard-menu.png')});
    await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
    await expect(image).toBeFocused(); await image.press('Shift+F10');
    await menu.getByRole('menuitem',{name:'放到白板',exact:true}).click();
    const panel=page.getByRole('complementary',{name:'工作台',exact:true});
    await expect(panel).toBeVisible(); await expect(panel.getByRole('tab',{name:'白板',exact:true})).toBeVisible();
    await expect(panel.locator('.workbench-canvas')).toHaveAttribute('data-board-revision','1');
  } finally {await page.close();await f.close();}
});
for (const agent of ['iPhone','Android']) test(`mobile has no inline or context whiteboard command (${agent})`, async ({browser}) => {
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,userAgent:agent});
  const page=await context.newPage(), f=await imageViewerFixture(page);
  try {
    await expect(page.locator('.workbench-add-image')).toHaveCount(0);
    const image=page.getByRole('button',{name:'第一张',exact:true});
    await image.dispatchEvent('contextmenu',{clientX:100,clientY:200});
    await expect(page.getByRole('menuitem',{name:'放到白板',exact:true})).toHaveCount(0);
    await page.keyboard.press('Escape'); await image.click();
    await expect(page.getByRole('dialog',{name:'图片预览',exact:true})).toBeVisible();
  } finally {await context.close();await f.close();}
});
