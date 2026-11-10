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
  if (format === "slides") patch('authorName:au,agent:!0,working:N,footnote:N==="queued"?"Waiting for the agent":"Working…"',
    'authorName:"Bot",agent:!0,footnote:N==="queued"?"Draft ready":"Sent to Bot"');
  else patch('authorName:ef,agent:!0,working:R,footnote:R==="queued"?"Waiting for the agent":"Working…"',
    'authorName:"Bot",agent:!0,footnote:R==="queued"?"Draft ready":"Sent to Bot"');
  // Patch only the editor's viewport consumers, after its native-scroll
  // decision. Keep upstream bytes, touch gestures and unrelated controls intact.
  const wheel = `(${designWheelDelta.toString()})`;
  if (format === "slides") {
    // Upstream's new batch button calls a standalone server endpoint and
    // claims dispatch. Keep the existing reviewable per-thread draft flow.
    patch('Ca.jsx(CG,{controller:e,state:t})', 'null');
    patch('let de=ue.deltaMode===1?16:ue.deltaMode===2?window.innerHeight:1,Le=ue.deltaMode===1?16:ue.deltaMode===2?window.innerWidth:1;if(Se==="zoom"){let{sx:nt,sy:He}=X(ue.clientX,ue.clientY);k.setView(A(k.getView(),nt,He,S(ue.deltaY*de),k.limits))}else k.setView(w(k.getView(),-ue.deltaX*Le,-ue.deltaY*de))',
      `let delta=${wheel}(ue,y.clientWidth,y.clientHeight);if(Se==="zoom"){let{sx:nt,sy:He}=X(ue.clientX,ue.clientY);k.setView(A(k.getView(),nt,He,Math.exp(delta.zoomLog),k.limits))}else k.setView(w(k.getView(),-delta.dx,-delta.dy))`);
    patch('NU({localComments:e=>sW({base:e,toolbar:!0}),room:jU,clashes:YU,mergeText:$U});P9();export{s0 as a,iW as g};', 'NU({base:"https://design.invalid/",localComments:e=>sW({base:e,toolbar:!0}),room:jU});window.slidesHost.downloads={save:window.__tarobotDesignSave};P9();');
    patch('u=i?null:e.localComments?.(r)??null,d=i??u?.link??null','u=e.localComments?.(r)??null,d=u?.link??null');
    patch('n=d?pU(d,u?.pins??fU(t.document)):null,g=i?I9(i):null', 'n=d?pU(d,u?.pins??fU(t.document)):null,g=null');
    patch('flushForUnload:ia,settle:async()=>{He&&bt(),await da.settle()}', 'flushForUnload:ia,settle:window.__tarobotDesignSettle=async()=>{He&&bt(),await da.settle()}');
    patch('const k=await lA(t,s);i.post({type:"editor:flushed",requestId:b.requestId,saved:k})', 'let k=false;try{await t.__tarobotDesignSettle?.();k=await lA(t,s)}catch{}i.post({type:"editor:flushed",requestId:b.requestId,saved:k})');
    patch('import("./woff2-decoder-ByxtpGxr.js")', 'import(window.__tarobotDesignResource("assets/woff2-decoder-ByxtpGxr.js"))');
    patch('return ve.asset!==void 0?lt.get(ve.asset):ve.src', 'return window.__tarobotDesignAssets(ve.asset!==void 0?lt.get(ve.asset):ve.src)');
    patch('import.meta.url', '"https://design.invalid/"');
  } else if (format === "canvas") {
  patch('j.jsx(J$,{controller:e,state:a})', 'null');
  patch('let Be=me.deltaMode===1?16:me.deltaMode===2?window.innerHeight:1,Ae=me.deltaMode===1?16:me.deltaMode===2?window.innerWidth:1;if(Se==="zoom"){let{sx:Re,sy:ie}=se(me.clientX,me.clientY);y.setView(f(y.getView(),Re,ie,h(me.deltaY*Be),y.limits))}else y.setView(c(y.getView(),-me.deltaX*Ae,-me.deltaY*Be))',
    `let delta=${wheel}(me,C.clientWidth,C.clientHeight);if(Se==="zoom"){let{sx:Re,sy:ie}=se(me.clientX,me.clientY);y.setView(f(y.getView(),Re,ie,Math.exp(delta.zoomLog),y.limits))}else y.setView(c(y.getView(),-delta.dx,-delta.dy))`);
  // An artboard is a nested preview which forwards wheel messages rather than
  // bubbling them. Normalize here once, before forwarding, using the same rule.
  patch('var position = fillStyle.deltaMode === 1 ? 16 : fillStyle.deltaMode === 2 ? window.innerHeight : 1;\n      var shaft = fillStyle.deltaMode === 1 ? 16 : fillStyle.deltaMode === 2 ? window.innerWidth : 1;',
    `var delta = ${wheel}(fillStyle, window.innerWidth, window.innerHeight);`);
  patch('Math.max(\n            -0.22314,\n            Math.min(0.22314, -fillStyle.deltaY * position * 0.01)\n          )', 'delta.zoomLog');
  patch('fillStyle.deltaX * shaft,\n          fillStyle.deltaY * position,', 'delta.dx,\n          delta.dy,');
  // Keep upstream's editor controls available when embedded. Host messaging,
  // saves and downloads still go through the original framed host adapter.
  patch('let qb=typeof window<"u"&&window.parent===window', 'let qb=true');
  // Keep local comment UI and room events; writes still obey the strict tab-owned CAS.
  patch('uq({localComments:e=>IY({base:e,toolbar:!0}),room:bq,clashes:Tq});iK();sK();', 'uq({base:"https://design.invalid/",localComments:e=>IY({base:e,toolbar:!0}),room:bq});iK();sK();');
  // TaroBot's virtual project paths allow Unicode names, spaces, parentheses
  // and plus signs. Upstream's ASCII-only component filter silently discarded
  // these saved artboards on load. Keep its traversal/reserved-name/length
  // checks; widen only this character filter inside the isolated editor.
  patch('Wt=/^[A-Za-z0-9_](?:[A-Za-z0-9 ._-]*[A-Za-z0-9_-])?$/',
    String.raw`Wt=/^[\p{L}\p{N}_](?:[\p{L}\p{N}\p{M} ._()+-]*[\p{L}\p{N}\p{M}_()+-])?$/u`);
  // Comments use the tab-owned local bridge even while embedded. The upstream
  // chat bridge stays off; Send to Agent opens a TaroBot draft for review.
  patch('b=o?null:e.localComments?.(n)??null,x=o??b?.link??null','b=e.localComments?.(n)??null,x=b?.link??null');
  patch('p=x?UK(x,b?.pins??VK(a.document)):null,m=o?uK(o):null', 'p=x?UK(x,b?.pins??VK(a.document)):null,m=null');
  // Upstream mirrors live text edits before settling the editable model. Its
  // HTTP host's beforeunload loop alone cannot settle an active text session.
  // Reuse the editor's own settler (also used for export), then retain its full
  // unsaved/publish check. A refused settle must never acknowledge saved=true.
  patch('function Id(we){Ba=we}', 'function Id(we){Ba=we;window.__tarobotDesignSettle=we}');
  patch('const h=await Qw(a,w);o.post({type:"editor:flushed",requestId:c.requestId,saved:h})', 'let h=false;try{await a.__tarobotDesignSettle?.();h=await Qw(a,w)}catch{}o.post({type:"editor:flushed",requestId:c.requestId,saved:h})');
  patch('G=r(N,W);return{doc:l(G,z),parts:k', 'G=window.__tarobotDesignAssets(r(N,W));return{doc:l(G,z),parts:k');
  patch('${JSON.stringify(c.kind)},${JSON.stringify(h)},${c.streaming?"true":"false"}', '${JSON.stringify(c.kind)},${JSON.stringify(window.__tarobotDesignAssets(h))},${c.streaming?"true":"false"}');
  // Runtime files become blob URLs, so retain their full URL instead of its pathname.
  const runtimeUrls = 'return new URL(E,document.baseURI).pathname';
  if (js.split(runtimeUrls).length !== 3) throw new Error("design_runtime_url_contract_changed");
  js = js.replaceAll(runtimeUrls, 'return new URL(E,document.baseURI).href');
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
