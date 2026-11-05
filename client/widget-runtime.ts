import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
// @ts-expect-error The Node-only build helper has no application-facing types.
import { buildWidgetRuntime } from './scripts/widget-runtime-build.mjs';
export function widgetRuntime(): Plugin {
  return {
    name: 'tarobot-widget-runtime',
    resolveId(id) { return id === 'virtual:widget-runtime' ? '\0virtual:widget-runtime' : undefined; },
    async load(id) {
      if (id !== '\0virtual:widget-runtime') return;
      for (const name of ['worker', 'viewer']) this.addWatchFile(fileURLToPath(new URL(`./src/widget-runtime/${name}.js`, import.meta.url)));
      return `export default ${JSON.stringify(await buildWidgetRuntime())};`;
    },
  };
}
