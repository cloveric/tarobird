import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { appAgentInstructions, appCapabilityInstructions, appTurnInstructions } from '../src/gateway/agent-instructions.js';
import { validateWidget } from '../src/runtime/widget.js';
import { parseTimelineEvents } from '../src/state/timeline-log.js';
import { widgetFormatPolicy } from '../src/gateway/widget-guidance.js';
import { createAppPlatformTools } from '../src/gateway/app-tools.js';
import { GatewayReceipts } from '../src/gateway/receipts.js';
import { runWidgetsCommand, WIDGET_PUBLISH_USAGE } from '../src/host-cli/widgets.js';
import { runHostCli } from '../src/host-cli/cli.js';
import { runWorkbenchCommand } from '../src/host-cli/workbench.js';
import { deliverCoreResponse } from '../src/core/delivery.js';
import { createCoreServiceRuntime } from '../src/core/runtime.js';
import type { CoreChannelLike } from '../src/core/types.js';

const roots: string[] = [];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('uses one HTML-default policy for all engines, native tools, compatibility fences and static CLI guidance', async () => {
  for (const engine of ['codex', 'claude', 'kimi', 'deepseek', 'antigravity'] as const) {
    for (const nativeWidgets of [true, false]) {
      const options = { engine, nativeWidgets, widgetsEnabled: true };
      const standing = appAgentInstructions(options);
      expect(standing).toContain(widgetFormatPolicy);
      if (nativeWidgets) expect(standing).toContain('app_show_widget({title,summary,html})');
      else expect(standing).toMatch(/"payload":\{"title":"[^"]+","summary":"[^"]+","html":"[^"]+"\}/);
      expect(standing).not.toContain('html|report');
      expect(standing.length).toBeLessThan(nativeWidgets ? 1600 : 1700);
      const guide = appCapabilityInstructions('widgets', options);
      expect(guide).toContain(widgetFormatPolicy);
      expect(guide.indexOf('Publish with app_show_widget')).toBeLessThan(guide.indexOf('Report schema'));
      expect(guide).not.toMatch(/Prefer bounded report|Use report data for ordinary|Use HTML only when/);
      expect(guide).toContain('complete company/category names');
      if (!nativeWidgets) expect(appTurnInstructions('比较本周趋势', options)).toContain(widgetFormatPolicy);
    }
  }
  const guide = await runWorkbenchCommand('', 'guide', 'widgets', {});
  expect(guide.instructions).toContain(widgetFormatPolicy);
  expect(guide.instructions).toContain('"html":"<section>...</section>"');
  expect(guide.instructions).not.toContain('"report":{...}');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await runHostCli(['--help']);
  const help = log.mock.calls.flat().join('\n');
  expect(help).toContain(WIDGET_PUBLISH_USAGE);
  expect(help).not.toContain('html|report');
  expect(help).toContain('仅在用户明确要求时使用 report');
  expect(WIDGET_PUBLISH_USAGE).toContain('Default: HTML. Only for an explicit structured-report request');
  const request = vi.fn();
  await expect(runWidgetsCommand({ request }, undefined, undefined, {})).rejects.toThrow(WIDGET_PUBLISH_USAGE);
  expect(request).not.toHaveBeenCalled();
});

it('provides the explicit report recipe on compatibility engines without turning written reports or code fixes into charts', () => {
  for (const text of ['用 report 格式展示这三个月的销售额', '请用结构化报表展示这些数据', 'use the structured report format for these numbers', 'use report format for these numbers', '使用 --report-file 发布这些数据']) {
    expect(appTurnInstructions(text, { widgetsEnabled: true, nativeWidgets: false })).toContain('Report schema');
    expect(appTurnInstructions(text, { widgetsEnabled: true, nativeWidgets: true }) ?? '').not.toContain('Report schema');
    expect(appTurnInstructions(text, { widgetsEnabled: false, nativeWidgets: false }) ?? '').not.toContain('Report schema');
  }
  for (const text of ['写一份季度分析报告', 'write a weekly report', '修复 report 格式的解析代码', 'fix the structured report parser']) {
    expect(appTurnInstructions(text, { widgetsEnabled: true, nativeWidgets: false }) ?? '').not.toContain('Report schema');
  }
  expect(appCapabilityInstructions('widgets')).toContain('Asking for a written report');
});

it('keeps frozen v7/v8 sessions while new tools recommend HTML and add Design', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'widget-format-')); roots.push(root);
  const signal = new AbortController().signal;
  const make = (widgetsEnabled: boolean) => createAppPlatformTools({ stateDir: root, conversationId: 'chat', options: { widgetsEnabled }, receipts: new GatewayReceipts(root), signal, channel: { sendWidget: vi.fn(), sendArtifact: vi.fn(), sendArtifactBatch: vi.fn() } });
  const current = make(true);
  // v8 is persisted exactly; new Design operations use a separate v9 digest.
  const v8Digest='aaa794422bb0ae09f32d181aac6bd366ae6927ef8fc8d4d8b243405fee4ceb3d';
  await mkdir(path.join(root,'app-tool-threads'),{recursive:true});
  await writeFile(path.join(root,'app-tool-threads',hash('old-v8')+'.json'),JSON.stringify({toolVersion:v8Digest}));
  const oldV8=(await current.forSession!('old-v8'))!;
  expect(hash(JSON.stringify(oldV8.definitions))).toBe(v8Digest);
  expect(JSON.stringify(oldV8.definitions)).not.toContain('design.create');
  expect(JSON.stringify(current.definitions)).toContain('design.create');
  const fresh = current.definitions.find(tool => tool.name === 'app_show_widget')!;
  expect(fresh.description).toContain('Use HTML by default');
  expect(fresh.description).not.toContain('Prefer bounded report');
  expect(fresh.description).toContain('Use proactively when helpful; text when clearer');
  expect(fresh.description).toContain('No network or host APIs');
  expect(JSON.stringify(fresh.inputSchema)).toContain('Only on explicit user request');
  expect(fresh.inputSchema.oneOf).toEqual([{ required: ['html'] }, { required: ['report'] }]);
  await current.register('v8');
  expect((await current.forSession!('v8'))?.definitions).toEqual(current.definitions);
  expect(await current.isRegistered('v8')).toBe(true);

  // Recorded from the compiled pre-change main (2f08459), not derived from v8.
  for (const [enabled, digest] of [[true, '92202956da40e7404b34c2b21ffe57b4bb63994fe9312f3111a7d078ab122cfe'], [false, 'bdbd4830237db124c714e155b056aa4522988e892ddb7ac34232706407dcbd6a']] as const) {
    const id = `v7-${enabled}`, file = path.join(root, 'app-tool-threads', hash(id) + '.json');
    await mkdir(path.dirname(file), { recursive: true });
    const saved = JSON.stringify({ toolVersion: digest }); await writeFile(file, saved);
    const tools = make(enabled), resumed = (await tools.forSession!(id))!;
    expect(await tools.isRegistered(id)).toBe(true);
    expect(hash(JSON.stringify(resumed.definitions))).toBe(digest);
    expect(await readFile(file, 'utf8')).toBe(saved);
    if (enabled) {
      expect(resumed.instructions).toContain(widgetFormatPolicy);
      const recipe = await resumed.call({ name: 'app_capability', arguments: { topic: 'widgets' }, callId: 'recipe', sessionId: id, abortSignal: signal });
      expect(recipe.text).toContain(widgetFormatPolicy);
      expect(recipe.text).not.toContain('Use HTML only when');
    } else {
      expect(JSON.stringify(resumed.definitions)).not.toContain('design.create');
      expect(JSON.stringify(tools.definitions)).toContain('design.create');
      expect(resumed.instructions).not.toContain(widgetFormatPolicy);
      expect(resumed.definitions.some(tool => tool.name === 'app_show_widget')).toBe(false);
    }
  }
});

it.each([
  { title: 'HTML', summary: 'Readable summary', html: '<p>Result</p>' },
  { title: 'Explicit report', summary: 'Readable summary', report: { version: 1, columns: ['Item', 'Count'], rows: [['A', 2]] } },
])('preserves the send.widget fence delivery for $title without leaking the directive as text', async widget => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'widget-fence-')); roots.push(root);
  const send = vi.fn(async (_chatId: string, _content: unknown, _options?: unknown) => ({ messageId: 'published' }));
  const channel = { profile: 'gateway', send } as unknown as CoreChannelLike;
  const text = '```tool-call\n' + JSON.stringify({ name: 'send.widget', payload: widget }) + '\n```';
  const result = await deliverCoreResponse({ channel, runtime: createCoreServiceRuntime(), chatId: 'chat', text, stateDir: root });
  expect(result.ok).toBe(true);
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]?.slice(0, 2)).toEqual(['chat', { widget }]);
});

it.each(['antigravity', 'kimi'] as const)('%s receives a complete executable widget envelope even without topic guidance', async engine => {
  const guide = appAgentInstructions({ engine, nativeWidgets: false, widgetsEnabled: true });
  const fence = guide.match(/```tool-call\r?\n([\s\S]*?)\r?\n```/);
  expect(fence, 'Standing guidance must not omit the name/payload envelope').not.toBeNull();
  const envelope = JSON.parse(fence![1]!);
  expect(envelope.name).toBe('send.widget');
  expect(envelope.payload).toMatchObject({ title: expect.any(String), summary: expect.any(String), html: expect.any(String) });
  const root = await mkdtemp(path.join(os.tmpdir(), 'widget-guide-')); roots.push(root);
  const send = vi.fn(async () => ({ messageId: 'guide-widget' }));
  const result = await deliverCoreResponse({ channel: { profile: 'gateway', send } as unknown as CoreChannelLike,
    runtime: createCoreServiceRuntime(), chatId: 'chat', text: fence![0], stateDir: root });
  expect(result.ok).toBe(true);
  expect(send).toHaveBeenCalledExactlyOnceWith('chat', { widget: envelope.payload }, undefined);
});

it.each(['antigravity', 'kimi'] as const)('%s receives visual authoring instructions for ordinary drawing requests', engine => {
  for (const text of ['画个图', '这个结构能画图给我看吗？', '请画一张示意图', '画个架构图', '做个对比图', '画一个封装结构的图', 'draw a diagram of these layers']) {
    expect(appTurnInstructions(text, { engine, nativeWidgets: false, widgetsEnabled: true }), text).toContain('Only tool-call fences execute');
  }
  for (const text of ['修复画图按钮', '审计示意图组件的代码', '修复绘制结构图的代码', '这段 send 代码是什么意思', 'explain this send code block', '画一张图片：一只猫', '帮我画图片', 'Windows 画图软件打不开', '这张结构图是谁画的', '示意图里第三层是什么材料', '生成一张图片', '生成图片：赛博朋克城市', '画一张猫的图片', '画一张猫的图', '帮我生成一张海报图', '做个图片压缩工具', '展示一下这张截图']) {
    expect(appTurnInstructions(text, { engine, nativeWidgets: false, widgetsEnabled: true }) ?? '', text).not.toContain('128 KiB');
  }
  expect(appTurnInstructions('画个图', { engine, nativeWidgets: false, widgetsEnabled: false })).not.toContain('send.widget');
});

it.each(['send', 'send.widget', 'html', 'json'])('keeps a %s fence as text instead of publishing it', async language => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'widget-example-')); roots.push(root);
  const send = vi.fn(async () => ({ messageId: 'example-text' }));
  const payload = { title: 'Example', summary: 'Example only', html: '<p>Example</p>' };
  for (const content of [payload, { name: 'send.widget', payload }]) {
    send.mockClear();
    const text = `\`\`\`${language}\n${JSON.stringify(content)}\n\`\`\``;
    const result = await deliverCoreResponse({ channel: { profile: 'gateway', send } as unknown as CoreChannelLike,
      runtime: createCoreServiceRuntime(), chatId: 'chat', text, stateDir: root });
    expect(result.ok).toBe(true); // Text delivery is not a widget publication receipt.
    expect(send).toHaveBeenCalledExactlyOnceWith('chat', { markdown: text }, undefined);
  }
});

it('does not execute widget examples inside quotes or enclosing code fences', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'widget-quoted-')); roots.push(root);
  const send = vi.fn(async () => ({ messageId: 'quoted-example' }));
  const example = '```tool-call\n' + JSON.stringify({ name: 'send.widget', payload: {
    title: 'Example', summary: 'Example only', html: '<p>Example</p>' } }) + '\n```';
  for (const text of [example.split('\n').map(line => `> ${line}`).join('\n'), `\`\`\`\`markdown\n${example}\n\`\`\`\``]) {
    send.mockClear();
    const result = await deliverCoreResponse({ channel: { profile: 'gateway', send } as unknown as CoreChannelLike,
      runtime: createCoreServiceRuntime(), chatId: 'chat', text, stateDir: root });
    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledExactlyOnceWith('chat', { markdown: text }, undefined);
  }
});

it.each(['zh', 'en'])('distinguishes widget execution and JSON syntax failures (%s)', async locale => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'widget-failure-')); roots.push(root);
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ locale }));
  const published: unknown[] = [];
  const send = vi.fn(async (_chatId: string, content: any) => {
    if (content.widget) published.push(validateWidget(content.widget));
    return { messageId: 'error-notice' };
  });
  for (const html of ['<script>let = ;</script>', '<meta name="example">']) {
    send.mockClear();
    const text = '```tool-call\n' + JSON.stringify({ name: 'send.widget', payload: {
      title: 'Invalid widget', summary: 'Readable summary', html } }) + '\n```';
    const result = await deliverCoreResponse({ channel: { profile: 'gateway', send } as unknown as CoreChannelLike,
      runtime: createCoreServiceRuntime(), chatId: 'chat', text, stateDir: root });
    expect(result.ok).toBe(false);
    expect(published).toEqual([]);
    const notices = send.mock.calls.map(call => call[1]?.text).filter(Boolean).join('\n');
    expect(notices).not.toMatch(/JSON|飞书|Lark/);
    expect(notices).toContain(locale === 'en' ? 'Widget publication' : '图形');
    const events = parseTimelineEvents(await readFile(path.join(root, 'timeline.log.jsonl'), 'utf8'));
    expect(events.at(-1)).toMatchObject({ type: 'service.error', metadata: { tool: 'send.widget' } });
  }
  send.mockClear();
  const result = await deliverCoreResponse({ channel: { profile: 'gateway', send } as unknown as CoreChannelLike,
    runtime: createCoreServiceRuntime(), chatId: 'chat', text: '```tool-call\n{"name":"send.widget",\n```', stateDir: root });
  expect(result.ok).toBe(false);
  expect(send.mock.calls.map(call => call[1]?.text).join('\n')).toContain('JSON');
  expect(published).toEqual([]);
});

it('reports an uncertain widget transport failure without replaying the widget', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'widget-transport-')); roots.push(root);
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ locale: 'en' }));
  const send = vi.fn(async (_chatId: string, content: any) => {
    if (content.widget) throw new Error('request timed out');
    return { messageId: 'notice' };
  });
  const text = '```tool-call\n' + JSON.stringify({ name: 'send.widget', payload: {
    title: 'Diagram', summary: 'Three nodes', html: '<p>A → B → C</p>' } }) + '\n```';
  const result = await deliverCoreResponse({ channel: { profile: 'gateway', send } as unknown as CoreChannelLike,
    runtime: createCoreServiceRuntime(), chatId: 'chat', text, stateDir: root });
  expect(result.ok).toBe(false);
  expect(send.mock.calls.filter(call => call[1]?.widget)).toHaveLength(1);
  expect(send.mock.calls.filter(call => call[1]?.text)).toHaveLength(1);
  expect(send.mock.calls.at(-1)?.[1].text).toContain('delivery status before retrying');
});
