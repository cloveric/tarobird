import { test, expect, type Page } from "@playwright/test";
import { build, preview } from "vite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "./fixtures/vite.js";
import { colorPalettes, monoAccents } from "../src/palettes.js";

// OKLab's public-domain linear-sRGB transform:
// https://bottosson.github.io/posts/oklab/#converting-from-linear-srgb-to-oklab
// These are product regression guardrails, not a universal accessibility rating.
type Simulation = "protan" | "deutan";
// Machado et al. 2009 severity-1 matrices, applied in linear RGB.
// https://www.inf.ufrgs.br/~oliveira/pubs_files/CVD_Simulation/CVD_Simulation.html
const cvdMatrices = {
  protan: [[.152286, 1.052583, -.204868], [.114503, .786281, .099216], [-.003882, -.048116, 1.051998]],
  deutan: [[.367322, .860646, -.227968], [.280085, .672501, .047413], [-.01182, .04294, .968881]],
};
function perceptualColor(css: string, simulation?: Simulation) {
  const linear = css.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => { const x = v / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; });
  const [r, g, b] = simulation ? cvdMatrices[simulation].map(row => Math.max(0, Math.min(1, row.reduce((sum, v, i) => sum + v * linear[i], 0)))) : linear;
  const l = Math.cbrt(.4122214708*r + .5363325363*g + .0514459929*b);
  const m = Math.cbrt(.2119034982*r + .6806995451*g + .1073969566*b);
  const s = Math.cbrt(.0883024619*r + .2817188376*g + .6299787005*b);
  return [.2104542553*l + .793617785*m - .0040720468*s, 1.9779984951*l - 2.428592205*m + .4505937099*s, .0259040371*l + .7827717662*m - .808675766*s];
}
function colorDistance(a: string, b: string, simulation?: Simulation) {
  const x = perceptualColor(a, simulation), y = perceptualColor(b, simulation);
  return 100 * Math.hypot(...x.map((value, i) => value - y[i]));
}

test.use({ serviceWorkers: "block" });
async function series(page: Page, kind = "line") {
  return page.locator('.report-chart > svg [data-series]').evaluateAll((nodes, kind) => nodes.map(node => {
    const mark = kind === "line" ? node : node.querySelector("rect")!;
    const style = getComputedStyle(mark);
    return { color: kind === "line" ? style.stroke : style.fill, dash: style.strokeDasharray, opacity: Number(style.opacity) };
  }), kind);
}
async function contrast(page: Page, kind: "line" | "bar") {
  return page.locator('.report-chart').evaluate((chart, kind) => {
    const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number);
    const luma = (c: number[]) => c.slice(0, 3).map(v => { const x = v / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i]!, 0);
    const background = (el: Element): number[] => {
      const c = rgb(getComputedStyle(el).backgroundColor), a = c[3] ?? 1;
      const under = el.parentElement ? background(el.parentElement) : [255, 255, 255];
      return c.slice(0, 3).map((v, i) => v * a + under[i]! * (1 - a));
    };
    const marks = [...chart.querySelectorAll(':scope > svg [data-series]')].map(group => kind === "line" ? group : group.querySelectorAll('rect')[1]!);
    marks.push(...chart.querySelectorAll('.report-legend .report-series-swatch > *, .report-selection .report-series-swatch > *'));
    return marks.map(mark => {
      const style = getComputedStyle(mark), fg = rgb(kind === "line" ? style.stroke : style.fill), a = Number(style.opacity);
      const bg = background(mark), actual = fg.map((v, i) => v * a + bg[i]! * (1 - a));
      const x = luma(actual), y = luma(bg);
      return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
    });
  }, kind);
}

for (const width of [390, 1360]) test(`all chart palettes retain distinct series, contrast and identity at ${width}px`, async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width, height: 900 });
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0]! + "e2e/fixtures/report-palette.html");
    const panel = page.locator('.inline-report'); await expect(panel).toBeVisible();
    // A missing value must still break the connected path. Dense dashed series
    // use one path per series so the dash phase is not reset at every sample.
    const gap = panel.locator('.report-chart > svg [data-series="3"] > path');
    await expect(gap).toHaveCount(1);
    expect((await gap.getAttribute('d'))!.match(/M/g)).toHaveLength(2);
    expect((await gap.getAttribute('d'))!.match(/L/g)).toHaveLength(50);
    const sets = new Set<string>();
    for (const palette of colorPalettes) {
      for (const theme of ['light', 'dark']) {
        await page.evaluate(({ palette, theme }) => Object.assign(document.documentElement.dataset, { palette, theme }), { palette: palette.id, theme });
        const actual = await series(page); expect(new Set(actual.map(x => x.color)).size, `${palette.id}/${theme}`).toBe(4);
        expect(new Set(actual.map(x => x.dash)).size).toBe(4);
        // String inequality alone would accept two almost identical colours.
        for (let i = 0; i < actual.length; i++) for (let j = i + 1; j < actual.length; j++) {
          expect(colorDistance(actual[i].color, actual[j].color), `${palette.id}/${theme} slots ${i+1}/${j+1}`).toBeGreaterThanOrEqual(j === i + 1 ? 15 : 6);
          if (j === i + 1) for (const simulation of ["protan", "deutan"] as const) expect(colorDistance(actual[i].color, actual[j].color, simulation), `${palette.id}/${theme} ${simulation} slots ${i+1}/${j+1}`).toBeGreaterThanOrEqual(8);
        }
        sets.add(JSON.stringify(actual.map(x => x.color)));
        // Theme changes animate existing button surfaces; measure the settled palette.
        await expect.poll(async () => Math.min(...await contrast(page, 'line')), { message: `${palette.id}/${theme}` }).toBeGreaterThanOrEqual(3);
        const swatches = await panel.locator('.report-legend .report-series-swatch path').evaluateAll(nodes => nodes.map(node => ({ color: getComputedStyle(node).stroke, dash: getComputedStyle(node).strokeDasharray })));
        expect(swatches).toEqual(actual.map(({ color, dash }) => ({ color, dash })));
        expect(await panel.locator('.report-selection .report-series-swatch path').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).stroke))).toEqual(actual.map(x => x.color));
        for (const button of await panel.locator('.report-legend button').all()) {
          await button.hover();
          await expect.poll(async () => Math.min(...await contrast(page, 'line')), { message: `hover ${palette.id}/${theme}` }).toBeGreaterThanOrEqual(3);
        }
        expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        const forwarded = await page.evaluate(() => (window as any).reportPalette.theme());
        for (let i = 1; i <= 4; i++) expect(forwarded[`chart-series-${i}`]).toMatch(/^#[0-9a-f]{6}$/i);
        if (['mono', 'white-violet', 'white-orange', 'pixel', 'paper'].includes(palette.id)) await panel.screenshot({ path: info.outputPath(`${palette.id}-${theme}-${width}.png`), animations: 'disabled' });
        const first = panel.getByRole('button', { name: '计划进度', exact: true }); await first.click();
        expect(await series(page)).toEqual(actual.slice(1)); await first.click();
        await page.evaluate(() => (window as any).reportPalette.render('bar'));
        await expect(panel.locator('.report-chart > svg [data-series] rect')).toHaveCount(211);
        expect((await series(page, 'bar')).map(x => x.color)).toEqual(actual.map(x => x.color));
        const frame = panel.locator('.report-bar-selection');
        await expect(frame).toHaveAttribute('fill', 'none');
        await expect(frame).toHaveAttribute('stroke', 'var(--text)');
        await panel.getByRole('combobox', { name: '选择记录查看数值' }).selectOption('0');
        const before = await frame.getAttribute('x');
        await panel.getByRole('combobox', { name: '选择记录查看数值' }).selectOption('20');
        expect(await frame.getAttribute('x')).not.toBe(before);
        if (['mono', 'paper'].includes(palette.id)) await panel.screenshot({ path: info.outputPath(`${palette.id}-${theme}-${width}-bar.png`), animations: 'disabled' });
        await expect.poll(async () => Math.min(...await contrast(page, 'bar')), { message: `bar ${palette.id}/${theme}` }).toBeGreaterThanOrEqual(3);
        await page.evaluate(() => (window as any).reportPalette.render('line'));
        await expect(panel.locator('.report-chart > svg [data-series]')).toHaveCount(4);
        await expect(panel.locator('.report-chart > svg [data-series] rect')).toHaveCount(0);
      }
    }
    expect(sets.size).toBe(colorPalettes.length * 2);
    await page.evaluate(() => Object.assign(document.documentElement.dataset, { palette: 'mono', theme: 'system' }));
    await page.emulateMedia({ colorScheme: 'light' }); const light = await series(page);
    await page.emulateMedia({ colorScheme: 'dark' }); expect(await series(page)).not.toEqual(light);
    await page.evaluate(() => document.documentElement.dataset.theme = 'light'); expect(await series(page)).toEqual(light);
    const picker = panel.getByRole('combobox', { name: '选择记录查看数值' });
    await picker.selectOption('20'); await panel.getByRole('button', { name: '实际进度', exact: true }).click();
    await page.evaluate(() => Object.assign(document.documentElement.dataset, { palette: 'white-orange', theme: 'dark' }));
    await expect(picker).toHaveValue('20');
    await expect(panel.getByRole('button', { name: '实际进度', exact: true })).toHaveAttribute('aria-pressed', 'false');
    const retained = await series(page); await panel.getByRole('button', { name: '放大交互组件', exact: true }).click();
    expect(await series(page)).toEqual(retained); await expect(picker).toHaveValue('20');
    await panel.getByRole('button', { name: '收起交互组件', exact: true }).click();
    await panel.getByRole('searchbox').fill('2026-01'); expect(await series(page)).toEqual(retained);
    await page.setViewportSize({ width: 320, height: 844 });
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => (window as any).reportPalette.render('line', true));
    for (const width of [320, 390]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(theme => Object.assign(document.documentElement.dataset, { palette: 'mono', theme }), theme);
      const labels = panel.locator('.report-selection > div:not(.report-selection-category) dt');
      await expect(labels).toHaveCount(4);
      await expect(labels.first()).toHaveText('本季度项目计划完成进度');
      const lines = await labels.evaluateAll(nodes => nodes.map(el => {
        const range = document.createRange(); range.selectNodeContents(el.lastChild!);
        return new Set([...range.getClientRects()].filter(r => r.width > 0).map(r => Math.round(r.top))).size;
      }));
      for (const count of lines) { expect(count).toBeGreaterThanOrEqual(1); expect(count).toBeLessThanOrEqual(3); }
      expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await panel.screenshot({ path: info.outputPath(`long-labels-${theme}-${width}.png`), animations: 'disabled' });
    }
  } finally { await page.close(); await server.close(); }
});

for (const width of [390, 1360]) test(`monochrome data follows accents without recolouring surfaces or resetting interaction at ${width}px`, async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width, height: 960 });
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0]! + "e2e/fixtures/report-palette.html");
    const panel = page.locator('.inline-report'); await expect(panel).toBeVisible();
    const picker = panel.getByRole('combobox', { name: '选择记录查看数值' });
    await picker.selectOption('20');
    const surfaces = () => panel.evaluate(el => ({
      page: getComputedStyle(document.documentElement).backgroundColor,
      panel: getComputedStyle(el).backgroundColor,
      grid: getComputedStyle(el.querySelector('.report-chart > svg line')!).stroke,
      label: getComputedStyle(el.querySelector('.report-y-label')!).fill,
      text: getComputedStyle(el.querySelector('.report-conclusion')!).color,
    }));
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => Object.assign(document.documentElement.dataset, { palette: 'mono', theme, monoAccent: 'none' }), theme);
      const neutral = await series(page), baseline = await surfaces(), seen = new Set<string>();
      for (const entry of neutral) {
        const rgb = entry.color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
        expect(new Set(rgb).size, 'no accent means neutral data, not a blue companion').toBe(1);
      }
      for (const accent of monoAccents) {
        await page.evaluate(accent => document.documentElement.dataset.monoAccent = accent, accent.id);
        const actual = await series(page); seen.add(JSON.stringify(actual.map(x => x.color)));
        expect(new Set(actual.map(x => x.color)).size).toBe(4);
        expect(new Set(actual.map(x => x.dash)).size).toBe(4);
        for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
          expect(colorDistance(actual[i].color, actual[j].color), `${accent.id}/${theme} ${i}/${j}`).toBeGreaterThanOrEqual(j === i + 1 ? 15 : 6);
          if (j === i + 1) for (const simulation of ['protan', 'deutan'] as const) expect(colorDistance(actual[i].color, actual[j].color, simulation)).toBeGreaterThanOrEqual(8);
        }
        expect(await surfaces()).toEqual(baseline);
        await expect(picker).toHaveValue('20');
        await expect.poll(async () => Math.min(...await contrast(page, 'line'))).toBeGreaterThanOrEqual(3);
        const legend = await panel.locator('.report-legend .report-series-swatch path').evaluateAll(nodes => nodes.map(node => ({ color: getComputedStyle(node).stroke, dash: getComputedStyle(node).strokeDasharray })));
        expect(legend).toEqual(actual.map(({ color, dash }) => ({ color, dash })));
        const emphasis = await panel.locator('.report-metrics dd').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color));
        expect(emphasis[1]).toBe(baseline.text);
        if (!['none', 'graphite'].includes(accent.id)) { expect(actual).not.toEqual(neutral); expect(emphasis[0]).toBe(actual[0].color); }
        expect(actual.slice(1)).toEqual(neutral.slice(1));
        const textContrast = await panel.evaluate(el => {
          const luminance = (s: string) => s.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
          const ratio = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
          const tab = getComputedStyle(el.querySelector('.report-views [aria-pressed=true]')!);
          return [ratio(getComputedStyle(el.querySelector('.report-metrics dd')!).color, getComputedStyle(el).backgroundColor), ratio(tab.color, tab.backgroundColor)];
        });
        expect(Math.min(...textContrast)).toBeGreaterThanOrEqual(4.5);
        if (['none', 'mist', 'rose', 'sage', 'warm-gray'].includes(accent.id)) await panel.screenshot({ path: info.outputPath(`mono-${accent.id}-${theme}-${width}-line.png`), animations: 'disabled' });
        await panel.getByRole('button', { name: '实际进度', exact: true }).click();
        expect(await series(page)).toEqual([actual[0], ...actual.slice(2)]);
        await panel.getByRole('button', { name: '实际进度', exact: true }).click();
        await page.evaluate(() => (window as any).reportPalette.render('bar'));
        await expect(panel.locator('.report-chart > svg [data-series] rect')).toHaveCount(211);
        expect((await series(page, 'bar')).map(x => x.color)).toEqual(actual.map(x => x.color));
        await expect.poll(async () => Math.min(...await contrast(page, 'bar'))).toBeGreaterThanOrEqual(3);
        await expect(panel.locator('.report-bar-selection')).toHaveCSS('stroke', baseline.text);
        if (['mist', 'warm-gray'].includes(accent.id)) await panel.screenshot({ path: info.outputPath(`mono-${accent.id}-${theme}-${width}-bar.png`), animations: 'disabled' });
        await page.evaluate(() => (window as any).reportPalette.render('line'));
        await picker.selectOption('20');
      }
      expect(seen.size).toBe(monoAccents.length - 1); // graphite and none intentionally share neutral data
      await page.evaluate(() => document.documentElement.dataset.monoAccent = 'unknown'); expect(await series(page)).toEqual(neutral);
      await page.evaluate(() => { delete document.documentElement.dataset.monoAccent; }); expect(await series(page)).toEqual(neutral);
      await page.evaluate(() => { delete document.documentElement.dataset.palette; }); expect(await series(page)).toEqual(neutral);
      await page.evaluate(() => document.documentElement.dataset.palette = 'mono');
    }
    await page.evaluate(() => Object.assign(document.documentElement.dataset, { palette: 'mono', theme: 'system', monoAccent: 'sage' }));
    await page.emulateMedia({ colorScheme: 'light' }); const light = await series(page);
    await page.emulateMedia({ colorScheme: 'dark' }); const dark = await series(page); expect(dark).not.toEqual(light);
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark'); expect(await series(page)).toEqual(dark);
    await panel.getByRole('button', { name: '实际进度', exact: true }).click();
    await panel.getByRole('button', { name: '放大交互组件', exact: true }).click();
    await page.evaluate(() => document.documentElement.dataset.monoAccent = 'rose');
    await expect(picker).toHaveValue('20');
    await expect(panel.getByRole('button', { name: '实际进度', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await panel.getByRole('button', { name: '收起交互组件', exact: true }).click();
    await page.evaluate(() => Object.assign(document.documentElement.dataset, { palette: 'white-orange', monoAccent: 'none' }));
    const orange = await series(page);
    await page.evaluate(() => document.documentElement.dataset.monoAccent = 'rose'); expect(await series(page)).toEqual(orange);
    await page.setViewportSize({ width: 320, height: 844 });
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.setViewportSize({ width, height: 960 });
    await page.evaluate(() => { Object.assign(document.documentElement.dataset, { palette: 'mono', theme: 'light', monoAccent: 'mist' }); (window as any).reportPalette.render('bar', false, 8); });
    await expect(panel.locator('.report-chart > svg [data-series] rect')).toHaveCount(32);
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await panel.screenshot({ path: info.outputPath(`mono-mist-light-${width}-bar-eight.png`), animations: 'disabled' });
    await page.evaluate(() => { Object.assign(document.documentElement.dataset, { palette: 'mono', theme: 'light', monoAccent: 'sage' }); (window as any).reportPalette.render('timeline'); });
    await expect(panel.locator('.report-timeline')).toBeVisible();
    const node = await panel.locator('.report-timeline li').first().evaluate(el => getComputedStyle(el, '::before').backgroundColor);
    await page.evaluate(() => document.documentElement.dataset.monoAccent = 'rose');
    expect(await panel.locator('.report-timeline li').first().evaluate(el => getComputedStyle(el, '::before').backgroundColor)).not.toBe(node);
  } finally { await page.close(); await server.close(); }
});


test('production-minified data tokens remain usable by existing widget scripts', async ({ page }) => {
  test.setTimeout(120_000);
  const outDir = await mkdtemp(path.join(tmpdir(), 'mono-chart-production-'));
  let server: Awaited<ReturnType<typeof preview>> | undefined;
  try {
    await build({ logLevel: 'error', build: { outDir, emptyOutDir: true, rollupOptions: { input: path.resolve('e2e/fixtures/report-palette.html') } } });
    server = await preview({ build: { outDir }, preview: { host: '127.0.0.1', port: 0, strictPort: false } });
    await page.goto(server.resolvedUrls.local[0]! + 'e2e/fixtures/report-palette.html');
    await expect(page.locator('.inline-report')).toBeVisible();
    for (const theme of ['light', 'dark']) for (const accent of monoAccents) {
      await page.evaluate(({ theme, accent }) => Object.assign(document.documentElement.dataset, { palette: 'mono', theme, monoAccent: accent }), { theme, accent: accent.id });
      const result = await page.evaluate(() => {
        const theme = (window as any).reportPalette.theme() as Record<string, string>;
        const probe = document.createElement('span'); document.body.append(probe);
        const roles: Record<string, string> = { accent: '--data-accent', 'primary-bg': '--data-primary-bg', 'accent-soft': '--data-accent-soft', 'on-primary': '--on-primary', ...Object.fromEntries([1,2,3,4].map(i => [`chart-series-${i}`, `--chart-series-${i}`])) };
        const result = Object.entries(roles).map(([key, token]) => {
          probe.style.color = `var(${token})`; const expected = getComputedStyle(probe).color;
          probe.style.color = theme[key]; return { key, token: theme[key], actual: getComputedStyle(probe).color, expected };
        }); probe.remove(); return result;
      });
      for (const entry of result) {
        expect(entry.token, `${accent.id}/${theme}/${entry.key}`).toMatch(/^#[0-9a-f]{6}$/i);
        expect(entry.actual).toBe(entry.expected);
      }
    }
  } finally { if (server) await new Promise<void>((resolve, reject) => server!.httpServer.close(error => error ? reject(error) : resolve())); await rm(outDir, { recursive: true, force: true }); }
});
