import { readFile } from "node:fs/promises";
import type { FrameLocator, Page } from "@playwright/test";
// @ts-expect-error The Node-only build helper has no application-facing types.
import { buildWidgetRuntime } from "../../scripts/widget-runtime-build.mjs";
import { widgetDocument, type WidgetTheme } from "../../src/widget-document.js";

/** The production relay, trusted viewer and Worker runtime without the App or
 * Hub. The host page plays the App's role and records relayed messages. */
const origin = "https://widget-runtime.test";
let runtime: Promise<{ worker: string; viewer: string }> | undefined;
export const lightTheme: WidgetTheme = { text: "#1f2328", muted: "#6b7280", surface: "#ffffff", card: "#f3f4f6", border: "#e5e7eb", accent: "#3b6fd4", "primary-bg": "#3b6fd4", "on-primary": "#ffffff", "accent-soft": "#e8efff", "font-size": "14px", scheme: "light" };

export type RuntimeHost = { guest: FrameLocator; messages: () => Promise<{ type: string; [key: string]: unknown }[]>; composeAccepted: (value: boolean) => Promise<void> };
export async function mountWidget(page: Page, html: string, options: { width?: number; restore?: string; theme?: WidgetTheme } = {}): Promise<RuntimeHost> {
  runtime ??= buildWidgetRuntime();
  const key = "runtime-host-key", relay = await readFile(new URL("../../public/widget-sandbox.html", import.meta.url), "utf8");
  const source = widgetDocument({ title: "Runtime", summary: "Runtime", html, version: 1 }, key, { ...lightTheme, ...options.theme }, await runtime, options.restore);
  // ASCII-only inline data: independent of how an engine guesses the host page encoding.
  const config = JSON.stringify({ key, source }).replace(/[<\u007f-\uffff]/g, char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
  await page.route(`${origin}/**`, route => route.fulfill({ contentType: "text/html; charset=utf-8", body: route.request().url().endsWith("/widget-sandbox.html") ? relay
    : `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:16px"><input id="composer" aria-label="宿主输入框"><div style="width:${options.width ?? 600}px"><iframe title="widget" sandbox="allow-scripts" src="${origin}/widget-sandbox.html" style="border:0;width:100%;height:320px;display:block"></iframe></div><script>
const {key,source}=${config};window.__host={messages:[],accept:true};const frame=document.querySelector('iframe');
addEventListener('message',event=>{if(event.source!==frame.contentWindow||!event.data||typeof event.data!=='object')return;const data=event.data;window.__host.messages.push(data);
 if(data.type==='tarobot-widget-shell-ready')frame.contentWindow.postMessage({type:'tarobot-widget-init',key,title:'Runtime',document:source},'*');
 if(data.key!==key)return;
 if(data.type==='tarobot-widget-height')frame.style.height=data.height+'px';
 if(data.type==='tarobot-widget-compose')frame.contentWindow.postMessage({type:'tarobot-widget-compose-result',key,id:data.id,accepted:window.__host.accept},'*');
});</script></body></html>` }));
  await page.goto(`${origin}/`);
  await page.waitForFunction(() => (window as unknown as { __host: { messages: { type: string }[] } }).__host.messages.some(message => message.type === "tarobot-widget-ready"));
  return {
    guest: page.frameLocator("iframe").frameLocator("iframe"),
    messages: () => page.evaluate(() => (window as unknown as { __host: { messages: { type: string }[] } }).__host.messages),
    composeAccepted: value => page.evaluate(value => { (window as unknown as { __host: { accept: boolean } }).__host.accept = value; }, value),
  };
}
