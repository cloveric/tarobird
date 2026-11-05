import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { buildSync } from "esbuild";
import type { DesignFormat } from "../src/client-protocol/workbench-design.js";
import { designWheelDelta } from "./src/design-wheel.js";
import { DESIGN_BOOTSTRAP_URL } from "./electron/design-document.mjs";

const root = new URL("./vendor/baoyu-design/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, root), "utf8");
const escapeScript = (text: string) => text.replace(/<\/script/gi, "<\\/script");
/** Upstream is pinned, byte checked and kept intact. Adapt only its host entry
 * points at build time, inside an opaque-origin editor, never the App document. */
export function buildDesignSandbox(format: DesignFormat = "canvas"): string {
  const directory = {canvas:"baoyu-design",slides:"baoyu-slides"}[format];
  const root = new URL(`./vendor/${directory}/`, import.meta.url);
  const read = (name: string) => readFileSync(new URL(name, root), "utf8");
  const manifest = JSON.parse(read("UPSTREAM.json"));
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (createHash("sha256").update(readFileSync(new URL(name, root))).digest("hex") !== expected) throw new Error(`design_upstream_changed:${name}`);
  }
  const page = read("editor/index.html");
  const script = [...page.matchAll(/src="\.\/([^\"]+\.js)"/g)].at(-1)![1], css = page.match(/href="\.\/([^\"]+\.css)"/)![1];
  let js = read("editor/" + script);
  const patch = (from: string, to: string) => { if (js.split(from).length !== 2) throw new Error("design_adapter_contract_changed:" + from.slice(0,100)); js = js.replace(from, to); };
  // A chat receipt proves delivery, not that a Bot has started working. Keep
  // the status readable without the upstream activity spinner or that claim.
  patch('authorName:"Agent",agent:!0,working:T,footnote:T==="queued"?"Waiting for the agent":"Working…"',
    'authorName:"Bot",agent:!0,footnote:T==="queued"?"Draft ready":"Sent to Bot"');
  // Patch only the editor's viewport consumers, after its native-scroll
  // decision. Keep upstream bytes, touch gestures and unrelated controls intact.
  const wheel = `(${designWheelDelta.toString()})`;
  if (format === "slides") {
    patch('let be=ne.deltaMode===1?16:ne.deltaMode===2?window.innerHeight:1,De=ne.deltaMode===1?16:ne.deltaMode===2?window.innerWidth:1;if(ve==="zoom"){let{sx:Ie,sy:Be}=J(ne.clientX,ne.clientY);C.setView(y(C.getView(),Ie,Be,m(ne.deltaY*be),C.limits))}else C.setView(x(C.getView(),-ne.deltaX*De,-ne.deltaY*be))',
      `let delta=${wheel}(ne,w.clientWidth,w.clientHeight);if(ve==="zoom"){let{sx:Ie,sy:Be}=J(ne.clientX,ne.clientY);C.setView(y(C.getView(),Ie,Be,Math.exp(delta.zoomLog),C.limits))}else C.setView(x(C.getView(),-delta.dx,-delta.dy))`);
    patch('SU({localComments:e=>xG({base:e,toolbar:!0}),room:TU,clashes:IU,mergeText:BU});b9();export{j0 as a,wG as g};', 'SU({base:"https://design.invalid/",localComments:e=>xG({base:e,toolbar:!0}),room:TU});window.slidesHost.downloads={save:window.__tarobotDesignSave};b9();');
    patch('f=i?null:e.localComments?.(r)??null,u=i??f?.link??null','f=e.localComments?.(r)??null,u=f?.link??null');
    patch('n=u?tU(u,f?.pins??$9(t.document)):null,h=i?A9(i):null', 'n=u?tU(u,f?.pins??$9(t.document)):null,h=null');
    patch('flushForUnload:ut,settle:async()=>{Be&&He(),await ea.settle()}', 'flushForUnload:ut,settle:window.__tarobotDesignSettle=async()=>{Be&&He(),await ea.settle()}');
    patch('const C=await zS(t,s);i.post({type:"editor:flushed",requestId:v.requestId,saved:C})', 'let C=false;try{await t.__tarobotDesignSettle?.();C=await zS(t,s)}catch{}i.post({type:"editor:flushed",requestId:v.requestId,saved:C})');
    patch('import("./woff2-decoder-BvG5IStQ.js")', 'import(window.__tarobotDesignResource("assets/woff2-decoder-BvG5IStQ.js"))');
    patch('return he.asset!==void 0?ge.get(he.asset):he.src', 'return window.__tarobotDesignAssets(he.asset!==void 0?ge.get(he.asset):he.src)');
    patch('import.meta.url', '"https://design.invalid/"');
  } else if (format === "canvas") {
  patch('let fe=me.deltaMode===1?16:me.deltaMode===2?window.innerHeight:1,Ee=me.deltaMode===1?16:me.deltaMode===2?window.innerWidth:1;if(se==="zoom"){let{sx:_e,sy:Le}=ie(me.clientX,me.clientY);w.setView(v(w.getView(),_e,Le,S(me.deltaY*fe),w.limits))}else w.setView(r(w.getView(),-me.deltaX*Ee,-me.deltaY*fe))',
    `let delta=${wheel}(me,k.clientWidth,k.clientHeight);if(se==="zoom"){let{sx:_e,sy:Le}=ie(me.clientX,me.clientY);w.setView(v(w.getView(),_e,Le,Math.exp(delta.zoomLog),w.limits))}else w.setView(r(w.getView(),-delta.dx,-delta.dy))`);
  // An artboard is a nested preview which forwards wheel messages rather than
  // bubbling them. Normalize here once, before forwarding, using the same rule.
  patch('var position = fillStyle.deltaMode === 1 ? 16 : fillStyle.deltaMode === 2 ? window.innerHeight : 1;\n      var shaft = fillStyle.deltaMode === 1 ? 16 : fillStyle.deltaMode === 2 ? window.innerWidth : 1;',
    `var delta = ${wheel}(fillStyle, window.innerWidth, window.innerHeight);`);
  patch('Math.max(\n            -0.22314,\n            Math.min(0.22314, -fillStyle.deltaY * position * 0.01)\n          )', 'delta.zoomLog');
  patch('fillStyle.deltaX * shaft,\n          fillStyle.deltaY * position,', 'delta.dx,\n          delta.dy,');
  // Keep upstream's editor controls available when embedded. Host messaging,
  // saves and downloads still go through the original framed host adapter.
  patch('let Cb=typeof window<"u"&&window.parent===window', 'let Cb=true');
  // Keep local comment UI and room events; writes still obey the strict tab-owned CAS.
  patch('sK({localComments:e=>lq({base:e,toolbar:!0}),room:hK,clashes:SK});rW();nW();', 'sK({base:"https://design.invalid/",localComments:e=>lq({base:e,toolbar:!0}),room:hK});rW();nW();');
  // TaroBot's virtual project paths allow Unicode names, spaces, parentheses
  // and plus signs. Upstream's ASCII-only component filter silently discarded
  // these saved artboards on load. Keep its traversal/reserved-name/length
  // checks; widen only this character filter inside the isolated editor.
  patch('$t=/^[A-Za-z0-9_](?:[A-Za-z0-9 ._-]*[A-Za-z0-9_-])?$/',
    String.raw`$t=/^[\p{L}\p{N}_](?:[\p{L}\p{N}\p{M} ._()+-]*[\p{L}\p{N}\p{M}_()+-])?$/u`);
  // Comments use the tab-owned local bridge even while embedded. The upstream
  // chat bridge stays off; Send to Agent opens a TaroBot draft for review.
  patch('m=f?null:e.localComments?.(n)??null,g=f??m?.link??null','m=e.localComments?.(n)??null,g=m?.link??null');
  patch('h=g?HW(g,m?.pins??OW(a.document)):null,d=f?sW(f):null', 'h=g?HW(g,m?.pins??OW(a.document)):null,d=null');
  // Upstream mirrors live text edits before settling the editable model. Its
  // HTTP host's beforeunload loop alone cannot settle an active text session.
  // Reuse the editor's own settler (also used for export), then retain its full
  // unsaved/publish check. A refused settle must never acknowledge saved=true.
  patch('function kn(Me){wn=Me}', 'function kn(Me){wn=Me;window.__tarobotDesignSettle=Me}');
  patch('const S=await Sw(a,b);f.post({type:"editor:flushed",requestId:r.requestId,saved:S})', 'let x=false;try{await a.__tarobotDesignSettle?.();x=await Sw(a,b)}catch{}f.post({type:"editor:flushed",requestId:r.requestId,saved:x})');
  patch('K=l(A,G);return{doc:s(K,B),parts:C', 'K=window.__tarobotDesignAssets(l(A,G));return{doc:s(K,B),parts:C');
  patch('${JSON.stringify(l.kind)},${JSON.stringify(v)},${l.streaming?"true":"false"}', '${JSON.stringify(l.kind)},${JSON.stringify(window.__tarobotDesignAssets(v))},${l.streaming?"true":"false"}');
  // Runtime files become blob URLs, so retain their full URL instead of its pathname.
  const runtimeUrls = 'return new URL(M,document.baseURI).pathname';
  if (js.split(runtimeUrls).length !== 3) throw new Error("design_runtime_url_contract_changed");
  js = js.replaceAll(runtimeUrls, 'return new URL(M,document.baseURI).href');
  }
  const resources: Record<string, { type: string; base64: string }> = {};
  // Keep standalone sharing and the Node exporter pinned, but out of the App frame.
  for (const name of Object.keys(manifest.files)) if (name.startsWith("editor/") && !name.startsWith("editor/node/") && name !== "editor/share-ui.js") {
    resources[name.slice(7)] = { type: name.endsWith(".js") ? "text/javascript" : name.endsWith(".json") ? "application/json" : name.endsWith(".woff2") ? "font/woff2" : name.endsWith(".html") ? "text/html" : name.endsWith(".css") ? "text/css" : "text/plain", base64: readFileSync(new URL(name, root)).toString("base64") };
  }
  // Script/CSS are already inline, not duplicated in the resource map.
  delete resources[script]; delete resources[css];
  const style = read("editor/" + css).replace(/url\((?:["']?)([^)'" ]+\.woff2)(?:["']?)\)/g, (_all, name) => {
    const file = name.replace(/^\.\//, "").replace(/^\/assets\//, "assets/");
    const resource = resources[file] ?? resources[`assets/${file}`] ?? resources[`artifact-type/${file}`];
    if (!resource) throw new Error("design_font_missing:" + name);
    return `url(data:font/woff2;base64,${resource.base64})`;
  });
  const bridge = buildSync({ entryPoints: [fileURLToPath(new URL("./src/design-runtime.js", import.meta.url))], bundle: true, write: false, platform: "browser", format: "iife", globalName: "DesignRuntime", target: "es2022" }).outputFiles[0].text;
  return `<!doctype html><html lang="en" class="cds-root" data-density="comfortable"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src blob: data:; worker-src blob:; media-src blob: data:; frame-src blob: data:; base-uri https://design.invalid; form-action 'none'; object-src 'none'"><base href="https://design.invalid/"><meta name="viewport" content="width=device-width,initial-scale=1">${(page.match(/<meta name="appifact-capabilities"[^>]+>/) ?? [""])[0]}<meta name="dc-runtime-file" content="artifact-type/dc-runtime.js"><meta name="dc-babel-file" content="artifact-type/babel.min.js"><title>${format === "slides" ? "PPT" : "Canvas"}</title><style>${style}</style></head><body><div id="root"></div><script>${escapeScript(bridge)}\nDesignRuntime.startDesignRuntime(${JSON.stringify(resources)},()=>{${escapeScript(js)}},${JSON.stringify(format)});</script></body></html>`;
}
// Only this fixed trusted trampoline runs at the asset origin. It never reads
// messages, query parameters or project data. The actual editor is created
// after navigating to an opaque data origin, inheriting this document's CSP.
export const designLoaderHtml = () => {
  const policy = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src blob: data:; worker-src blob:; media-src blob: data:; frame-src blob: data:; base-uri https://design.invalid; form-action 'none'; object-src 'none'";
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><script>if(parent!==window)location.replace(${JSON.stringify(DESIGN_BOOTSTRAP_URL)}+"#"+crypto.randomUUID());<\/script>`;
};
export function designAssets(): Plugin {
  const formats: DesignFormat[] = ["canvas","slides"];
  const names = {canvas:"design",slides:"slides"};
  const cache = new Map<DesignFormat,string>();
  const build = (format: DesignFormat) => { if (!cache.has(format)) cache.set(format,buildDesignSandbox(format)); return cache.get(format)!; };
  return {
    name: "tarobot-design-sandbox",
    configureServer(server) { server.middlewares.use((req,res,next)=>{
      if(req.url === "/design-loader.html") {res.setHeader("Content-Type","text/html; charset=utf-8");res.end(designLoaderHtml());return;}
      const format=formats.find(format=>req.url===`/${names[format]}-sandbox.html`);
      if(!format)return next();res.setHeader("Content-Type","text/html; charset=utf-8");res.end(build(format));
    }); },
    generateBundle() {
      this.emitFile({type:"asset",fileName:"design-loader.html",source:designLoaderHtml()});
      for(const format of formats) {
        this.emitFile({type:"asset",fileName:`${names[format]}-sandbox.html`,source:build(format)});
        const directory = {canvas:"baoyu-design",slides:"baoyu-slides"}[format];
        for(const name of ["LICENSE","NOTICE.md","UPSTREAM.json","editor/third-party-licenses.txt"])
          this.emitFile({type:"asset",fileName:`licenses/${directory}/${name.replace("editor/","")}`,source:readFileSync(new URL(`./vendor/${directory}/${name}`,import.meta.url),"utf8")});
      }
    }
  };
}
