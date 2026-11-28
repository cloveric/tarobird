import { readFile, writeFile, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const integration = path.dirname(fileURLToPath(import.meta.url));
export async function patchUpstream(sourceDir, version) {
  const embedded = path.join(sourceDir, 'apps/web/src/tarobird');
  await mkdir(embedded, { recursive: true });
  await cp(path.join(integration, 'overlay'), embedded, { recursive: true });

  async function patch(file, changes) {
    const target = path.join(sourceDir, file);
    let input = await readFile(target, 'utf8');
    for (const [before, after] of changes) {
      if (typeof before === 'string' ? !input.includes(before) : !before.test(input)) throw Error(`infinite_canvas_patch_context_missing: ${file}`);
      input = input.replace(before, after);
    }
    await writeFile(target, input);
  }

  const workbench = 'packages/workbench/src';
  await patch('apps/web/src/bootstrap.tsx', [
    ['import { initAnalytics } from "@/lib/analytics";\n', ''],
    ['initAnalytics();\n', ''],
  ]);
  await patch('apps/web/src/router.tsx', [
    [/createBrowserRouter/g, 'createMemoryRouter'],
    ['import { AnalyticsTracker } from "@/components/layout/analytics-tracker";\n', ''],
    ['                <AnalyticsTracker />\n', ''],
  ]);
  await patch(`${workbench}/layouts/user-layout.tsx`, [
    ['"url(/logo.svg) center / contain no-repeat"', '`url("${__TAROBIRD_CANVAS_LOGO__}") center / contain no-repeat`'],
    // Name and author on two lines: one long line ran under the sidebar's collapse button in the 220px sidebar.
    // The author line uses em so the collapsed sidebar's text-[0px] still hides it.
    [' />无限画布', version === '1.0.0' ? ' />无限画布 · basketikun' : ' /><span className="flex min-w-0 flex-col leading-tight">无限画布<span className="text-[0.6875em] font-normal text-muted-foreground">basketikun</span></span>'],
  ]);
  await writeFile(path.join(sourceDir, workbench, 'hooks/use-version-check.ts'), `
import { useState } from "react";
import { APP_VERSION } from "@workbench/constant/env";
export function useVersionCheck() {
    const [open, setOpen] = useState(false);
    return {
        open, setOpen, openReleaseModal: () => setOpen(true),
        latestVersion: APP_VERSION, releases: __APP_RELEASES__, checking: false,
        hasNewVersion: false, checkLatestRelease: async () => true,
    };
}
`);
  await patch(`${workbench}/components/layout/config-channels.tsx`, [
    ['sponsors={newChannel ? <ChannelSponsorPicker onPick={applySponsor} /> : undefined}', ''],
  ]);
  await writeFile(path.join(sourceDir, workbench, 'components/layout/config-plugins.tsx'), 'export { ConfigPlugins } from "@tarobird-canvas/node-addons";\n');
  await patch(`${workbench}/components/layout/app-config-modal.tsx`, [
    [/^    \{ id: "builtin:(?:object-storage|local-storage)",[^\n]*\n/gm, ''],
  ]);
  await patch(`${workbench}/services/api/prompt-source-presets.ts`, [
    ['homepage, enabled: true, builtIn: true', 'homepage, enabled: false, builtIn: true'],
  ]);
  await patch(`${workbench}/services/api/prompt-source-runtime.ts`, [
    ['import { network } from "@workbench/services/network/runtime";', 'import { fetchApprovedPromptSource } from "@tarobird-canvas/provider";'],
    ['fetch(network.url(source.url), { cache: "no-store", signal: options?.signal })', 'fetchApprovedPromptSource(source.url, options?.signal)'],
    ['const referenceImageUrls = stringArray(record.referenceImageUrls).map((url) => absoluteUrl(source.url, url));', 'const referenceImageUrls: string[] = [];'],
    ['const coverUrl = absoluteUrl(source.url, stringValue(record.coverUrl)) || referenceImageUrls[0] || "";', 'const coverUrl = "";'],
  ]);
  await patch(`${workbench}/services/api/prompts.ts`, [
    ['import { appDatabase } from "@workbench/utils/indexed-db";\nimport localforage from "localforage";', 'import { makeCollection } from "@tarobird-canvas/collection";'],
    ['localforage.createInstance({ name: appDatabase, storeName: "prompt_cache" })', 'makeCollection("prompt-cache")'],
  ]);
  await patch(`${workbench}/stores/use-prompt-source-store.ts`, [
    ['intervalMinutes: 30,', 'intervalMinutes: 0,'],
    ['return { ...current, sources: [...builtIn, ...custom],', 'return { ...current, sources: builtIn,'],
  ]);
  await patch(`${workbench}/components/layout/config-prompt-sources.tsx`, [
    [/<Button type="button" ref=\{addButton\}[\s\S]*?新增来源[\s\S]*?<\/Button>/, ''],
  ]);
  await patch(`${workbench}/hooks/use-copy-text.ts`, [
    ['import copy from "copy-to-clipboard";', 'import { hostBridge } from "@tarobird-canvas/host-bridge";'],
    ['await copy(value)', 'await hostBridge.clipboardWrite(value)'],
  ]);
  for (const file of [
    'services/config-file.ts', 'pages/create/index.tsx', 'lib/canvas/canvas-export.ts',
    'pages/assets/asset-transfer.ts', 'pages/assets/index.tsx', 'pages/canvas/project.tsx',
    'components/layout/model-call-select-modal.tsx',
  ]) await patch(`${workbench}/${file}`, [[/\bsaveAs\(/g, 'await saveAs(']]);
  await patch(`${workbench}/stores/use-config-store.ts`, [
    ['    void importChannelFromUrl();\n', ''],
  ]);
  await patch(`${workbench}/services/config-file.ts`, [
    ['config, callScripts: { scripts, removedBuiltinIds }', 'config: { ...config, apiKey: "", channels: config.channels.map(channel => ({ ...channel, groups: channel.groups.map(group => ({ ...group, apiKey: "" })) })) }, callScripts: { scripts: [], removedBuiltinIds }'],
    ['await updateCallScripts(() => ({ scripts, removedBuiltinIds }));', 'await updateCallScripts(() => ({ scripts: [], removedBuiltinIds }));'],
    ['await saveWorkspaceConfig(workspace.data);', ''],
    ['usePromptSourceStore.getState().saveConfig(data.promptSources);', ''],
  ]);

  await patch(`${workbench}/components/agent/canvas-mcp-bridge.tsx`, [
    ['import { openLocalSocket } from "@workbench/lib/local-socket";', 'import { openAgentTransport, agentRequest } from "@tarobird-canvas/agent";'],
    ['openLocalSocket(`/events?clientId=${canvasMcpClientId}`', 'openAgentTransport(canvasMcpClientId'],
    ['    const response = await fetch(`${path}?clientId=${canvasMcpClientId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });\n    if (!response.ok) throw new Error("CANVAS_CONNECTION_FAILED");', '    await agentRequest(canvasMcpClientId, path, body, signal);'],
  ]);
  await writeFile(path.join(sourceDir, workbench, 'components/layout/config-external-agent.tsx'), 'export { ConfigExternalAgent } from "@tarobird-canvas/agent-panel";\n');

  await patch(`${workbench}/lib/plugins/client-files.ts`, [
    ['if (typeof navigator !== "undefined") navigator.serviceWorker?.addEventListener("message", serve);', ''],
  ]);
  await patch(`${workbench}/lib/plugins/runtime.ts`, [
    ['source?: string | InstalledPlugin, signal?: AbortSignal)', 'source?: string | InstalledPlugin, signal?: AbortSignal, bundled?: CanvasPlugin)'],
    ['const plugin = source === undefined ? {} : await importPlugin(pkg, source, scope);', 'if (source !== undefined) throw new PluginError("PLUGIN_LOAD_FAILED");\n        const plugin = bundled ?? {};'],
  ]);

  await patch(`${workbench}/components/layout/model-call-select-modal.tsx`, [
    [/<ChannelRemoveConfirmation question="只导入来源可信的脚本包"[\s\S]*?<\/ChannelRemoveConfirmation>/, ''],
    [/<Button type="button" size="xs" variant="ghost" onClick=\{\(event\) => \{[\s\S]*?另存修改[\s\S]*?<\/Button>/, ''],
    [/<button type="button" className="col-span-full[\s\S]*?新增脚本[\s\S]*?<\/button>/, ''],
    ['["all", "builtin", "plugin", "custom"] as const', '["all", "builtin"] as const'],
  ]);
  await patch(`${workbench}/services/api/models/browser.ts`, [
    ['import { network }', 'import { providerFetch } from "@tarobird-canvas/provider";\nimport { network }'],
    ['await fetch(target, init)', 'await providerFetch(target, init)'],
  ]);

  const modelRuntime = 'packages/model-runtime/src';
  const packageRequire = createRequire(path.join(sourceDir, 'package.json'));
  const { tsImport } = packageRequire('tsx/esm/api');
  const scriptPath = path.join(sourceDir, modelRuntime, 'call-scripts/openai.ts');
  const { openaiScripts } = await tsImport(scriptPath, import.meta.url);
  const compiled = openaiScripts.map(({ source }) => `  [${JSON.stringify(source)}, (() => { ${source}\nreturn main; })()],`).join('\n');
  await writeFile(path.join(sourceDir, modelRuntime, 'call-scripts/tarobird-compiled.ts'), `const scripts = new Map<string, (args: any) => unknown>([\n${compiled}\n]);\nexport const getBuiltinMain = (source: string) => scripts.get(source);\n`);
  await writeFile(path.join(sourceDir, modelRuntime, 'call-scripts/builtin.ts'), 'export { openaiScripts as builtinCallScripts } from "./openai.js";\n');
  await patch(`${modelRuntime}/script.ts`, [
    ['import axios,', 'import { providerFetch } from "@tarobird-canvas/provider";\nimport { getBuiltinMain } from "./call-scripts/tarobird-compiled.js";\nimport axios,'],
    ['await fetch(host.mapUrl(url)', 'await providerFetch(host.mapUrl(url)'],
    [/const main = new Function\([^\n]*\)\(\);/, 'const main = getBuiltinMain(args.script);'],
  ]);

  await patch('plugins/multi-format-renderer/src/nodes/html.tsx', [
    ['import { saveSource }', 'import DOMPurify from "dompurify";\nimport { saveSource }'],
    [/<iframe[\s\S]*?\/>/, `<div aria-label="html-preview" className="h-full overflow-auto" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html, {
                    ALLOWED_TAGS: ["article", "blockquote", "br", "code", "div", "em", "h1", "h2", "h3", "h4", "hr", "li", "ol", "p", "pre", "section", "span", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul"],
                    ALLOWED_ATTR: [], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
                }) }} />`],
  ]);
}
