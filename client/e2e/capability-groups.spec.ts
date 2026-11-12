import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";

const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module">
import React from 'react'; import { createRoot } from 'react-dom/client';
import { CapabilitiesPanel } from '/src/CapabilitiesPanel.tsx';
import { setLocale } from '/src/i18n.ts';
import '/src/styles.css'; import '/src/brand-theme.css'; import '/src/palette-tokens.css';
import '/src/mobile-im.css'; import '/src/mobile-shell.css'; import '/src/viewport.css';
const skill=(id,name,source,status='discovered',description='整理资料并核对来源。',scope='plugin')=>({id,kind:'skill',name,source,status,description,scope});
const entries=[skill('report-a','report','plugin:alpha/skills/report/SKILL.md'),skill('report-b','report','plugin:beta/skills/report/SKILL.md','disabled','生成季度财务报告。'),skill('web','vercel-react-best-practices','user/web/SKILL.md','discovered','网页开发。','user'),skill('native','vercel-react-native-skills','user/native/SKILL.md','discovered','手机应用开发。','user'), ...['a','b'].map(id=>({id:'mcp-'+id,kind:'mcp',name:'search',source:'plugin:'+id+'/.mcp.json',scope:'plugin',status:'configured',description:'',transport:'stdio'}))];
const f=window.capabilityGroups={entries,requests:[],closed:0,setLocale,skill};
const data=()=>({generatedAt:new Date().toISOString(),engine:'claude',workspace:'/test/workspace',runtime:'unverified',coverage:'partial',entries:f.entries,sources:[],warnings:['runtime_unverified','partial_catalog']});
createRoot(document.getElementById('root')).render(React.createElement(CapabilitiesPanel,{connection:{identity:{hubPublicKey:'test-host'},state:{status:'online'},subscribe:()=>()=>{},http:async()=>data()},bots:[{id:'alpha',name:'研究助手',engine:'claude',model:'',effort:'',online:1}],initialBot:'alpha',close:()=>f.closed++,help:r=>f.requests.push(r)}));
</script></body></html>`;

for (const screen of [
  { name: 'desktop', width: 1360, height: 900, touch: false },
  { name: 'narrow desktop', width: 640, height: 400, touch: false },
  { name: 'phone', width: 390, height: 844, touch: true },
  { name: 'small phone', width: 320, height: 700, touch: true },
  { name: 'landscape phone', width: 844, height: 390, touch: true },
]) test(`same-name Skills retain source-specific state and actions on ${screen.name}`, async ({ browser }, info) => {
  const vite = await createServer({ plugins: [{ name: 'capability-groups-fixture', configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.url !== '/__capability-groups') return next();
      response.setHeader('Content-Type', 'text/html'); response.end(await server.transformIndexHtml('/__capability-groups', html));
    });
  } }], server: { port: 0, host: '127.0.0.1', hmr: false } });
  await vite.listen();
  const context = await browser.newContext({ viewport: { width: screen.width, height: screen.height }, isMobile: screen.touch, hasTouch: screen.touch, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(vite.resolvedUrls!.local[0]! + '__capability-groups');
    await expect(page.locator('.capability-card')).toHaveCount(3);
    await expect(page.getByRole('button', { name: /^Skills/ })).toContainText('3');
    const report = page.locator('.capability-card').filter({ has: page.locator('.capability-summary strong', { hasText: /^report$/ }) });
    await expect(report).toContainText('2 个来源');
    await expect(report).toContainText('部分禁用');
    await report.locator('.capability-summary').click();
    await expect(report.locator('.capability-source')).toHaveCount(2);
    await expect(report).toContainText('整理资料并核对来源。');
    await expect(report).toContainText('生成季度财务报告。');
    const beta = report.locator('.capability-source').filter({ hasText: 'plugin:beta/skills/report/SKILL.md' });
    await expect(beta).toContainText('配置已禁用');
    await beta.getByRole('button', { name: '让 Bot 检查', exact: true }).click();
    expect(await page.evaluate(() => (window as any).capabilityGroups.requests)).toEqual([{botId:'alpha',kind:'skill',name:'report',source:'plugin:beta/skills/report/SKILL.md',intent:'check'}]);
    await page.keyboard.press('Escape');
    await expect(report.locator('.capability-summary')).toHaveAttribute('aria-expanded', 'false');
    await expect(report.locator('.capability-summary')).toBeFocused();
    const search = page.getByLabel('搜索能力', { exact: true });
    await search.fill('plugin:beta');
    await expect(page.locator('.capability-card')).toHaveCount(1);
    await report.locator('.capability-summary').click();
    await expect(report.locator('.capability-source')).toHaveCount(1);
    await expect(report).toContainText('1 / 2');
    await expect(report).not.toContainText('plugin:alpha/');
    await expect(report).toHaveAttribute('data-status', 'partial-disabled');
    await expect(report.locator('.capability-summary')).toContainText('部分禁用');
    const states = page.getByRole('group', { name: '配置状态', exact: true });
    await states.getByRole('button', { name: /^已发现\/配置/ }).click();
    await expect(page.locator('.capability-card')).toHaveCount(0);
    await search.fill('');
    await expect(page.locator('.capability-card')).toHaveCount(3);
    await states.getByRole('button', { name: /^已禁用/ }).click();
    await expect(page.locator('.capability-card')).toHaveCount(1);
    await report.locator('.capability-summary').click();
    await expect(report.locator('.capability-source')).toHaveCount(1);
    await expect(report).toContainText('plugin:beta/skills/report/SKILL.md');
    await expect(report).toHaveAttribute('data-status', 'partial-disabled');
    await states.getByRole('button', { name: /^全部/ }).click();
    await page.getByLabel('能力来源', { exact: true }).selectOption('user');
    await expect(page.locator('.capability-card')).toHaveCount(2);
    await page.getByLabel('能力来源', { exact: true }).selectOption('');
    await page.getByRole('button', { name: /^MCP/ }).click();
    await expect(page.locator('.capability-card')).toHaveCount(2);
    await page.getByRole('button', { name: /^Skills/ }).click();
    for (const [locale, theme] of [['zh','light'],['en','dark']]) {
      await page.evaluate(([locale,theme]) => { (window as any).capabilityGroups.setLocale(locale); document.documentElement.dataset.theme=theme; }, [locale,theme]);
      await report.locator('.capability-summary').click();
      await report.scrollIntoViewIfNeeded();
      expect(await page.locator('.capabilities-panel').evaluate(e => e.scrollWidth <= e.clientWidth && document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const action = report.locator('.capability-source').last().getByRole('button');
      await action.scrollIntoViewIfNeeded();
      if (screen.touch) expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await action.evaluate(e => { const b=e.getBoundingClientRect();return e.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)); })).toBe(true);
      await page.screenshot({ path: info.outputPath(`groups-${locale}-${theme}.png`) });
      await page.keyboard.press('Escape');
    }
    // Identical descriptions are shown once, with one review hint for the group.
    await page.evaluate(() => {
      const f = (window as any).capabilityGroups;
      f.entries = Array.from({length:4}, (_,index) => f.skill('copy-'+index, 'sheet-audit', 'plugin:source-'+index+'/skills/sheet-audit/SKILL.md'));
    });
    await page.getByRole('button', { name: 'Refresh inventory', exact: true }).click();
    await page.locator('.capability-summary').click();
    await expect(page.locator('.capability-source')).toHaveCount(4);
    await expect(page.getByText('整理资料并核对来源。', { exact: true })).toHaveCount(1);
    for (const source of await page.locator('.capability-source').all()) {
      const action = source.getByRole('button');
      await expect(action).toHaveAccessibleDescription(/plugin:source-/);
      await action.click();
    }
    expect(await page.evaluate(() => (window as any).capabilityGroups.requests.slice(-4).map((r:any)=>r.source))).toEqual(Array.from({length:4}, (_,i)=>'plugin:source-'+i+'/skills/sheet-audit/SKILL.md'));
    await page.locator('.capability-summary').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('groups-four-sources.png') });
    // Group before pagination: all sources stay together, including the final page.
    await page.evaluate(() => {
      const f = (window as any).capabilityGroups;
      f.entries = Array.from({length:62}, (_,index) => f.skill('paged-'+index, 'skill-'+(index % 31), 'plugin:source-'+index+'/skills/report/SKILL.md'));
    });
    await page.getByRole('button', { name: 'Refresh inventory', exact: true }).click();
    await expect(page.locator('.capability-card')).toHaveCount(30);
    await expect(page.getByRole('button', { name: /^Skills/ })).toContainText('31');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.locator('.capability-card')).toHaveCount(1);
    await page.locator('.capability-summary').click();
    await expect(page.locator('.capability-source')).toHaveCount(2);
    await expect(page.locator('.capability-card')).toContainText('source-30');
    await expect(page.locator('.capability-card')).toContainText('source-61');
    await page.evaluate(() => { const f=(window as any).capabilityGroups; f.entries=[f.entries[30]]; });
    await page.getByRole('button', { name: 'Refresh inventory', exact: true }).click();
    await expect(page.locator('.capability-card')).toHaveCount(1);
    await expect(page.locator('.capabilities-pages')).toHaveCount(0);
    await expect(page.locator('.capability-summary')).toHaveAttribute('aria-expanded', 'false');
    await page.locator('.capability-summary').click();
    await expect(page.locator('.capability-detail')).toContainText('source-30');
    await expect(page.locator('.capability-detail')).not.toContainText('source-61');
    expect(errors).toEqual([]);
  } finally { await context.close(); await vite.close(); }
});
