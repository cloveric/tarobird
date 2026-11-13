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
  if (format === "slides") patch('authorName:su,agent:!0,working:F,footnote:F==="queued"?"Waiting for the agent":"Working…"',
    'authorName:"Bot",agent:!0,footnote:F==="queued"?"Draft ready":"Sent to Bot"');
  else patch('authorName:gf,agent:!0,working:N,footnote:N==="queued"?"Waiting for the agent":"Working…"',
    'authorName:"Bot",agent:!0,footnote:N==="queued"?"Draft ready":"Sent to Bot"');
  // Patch only the editor's viewport consumers, after its native-scroll
  // decision. Keep upstream bytes, touch gestures and unrelated controls intact.
  const wheel = `(${designWheelDelta.toString()})`;
  if (format === "slides") {
    patch('canAsk:!Ma||ca?.mayEdit===!0', 'canAsk:window.__tarobirdDesignRepairEnabled&&(!Ma||ca?.mayEdit===!0)');
    patch('d=(0,e.formatMessage)({defaultMessage:"Someone who can edit this presentation can ask the agent to fix the slide.",id:"6E4gKJHZfQ"})',
      'd=window.__tarobirdDesignRepairEnabled?(0,e.formatMessage)({defaultMessage:"Someone who can edit this presentation can ask the agent to fix the slide.",id:"6E4gKJHZfQ"}):""');
    // Upstream's new batch button calls a standalone server endpoint and
    // claims dispatch. Keep the existing reviewable per-thread draft flow.
    patch('ka.jsx(RW,{controller:e,state:t})', 'null');
    patch('let Xe=ue.deltaMode===1?16:ue.deltaMode===2?window.innerHeight:1,vt=ue.deltaMode===1?16:ue.deltaMode===2?window.innerWidth:1;if(Be==="zoom"){let{sx:Vt,sy:Re}=Q(ue.clientX,ue.clientY);M.setView(E(M.getView(),Vt,Re,A(ue.deltaY*Xe),M.limits))}else M.setView(S(M.getView(),-ue.deltaX*vt,-ue.deltaY*Xe))',
      `let delta=${wheel}(ue,g.clientWidth,g.clientHeight);if(Be==="zoom"){let{sx:Vt,sy:Re}=Q(ue.clientX,ue.clientY);M.setView(E(M.getView(),Vt,Re,Math.exp(delta.zoomLog),M.limits))}else M.setView(S(M.getView(),-delta.dx,-delta.dy))`);
    patch('fG({localComments:e=>fK({base:e,toolbar:!0}),room:yG,clashes:kG,mergeText:LG});d9();export{Sv as a,hK as g};', 'fG({base:"https://design.invalid/",localComments:e=>fK({base:e,toolbar:!0}),room:yG});window.slidesHost.downloads={save:window.__tarobotDesignSave};window.slidesHost.chat={suggestPrompt:window.__tarobotDesignSuggest};d9();');
    patch('f=c?null:e.localComments?.(r)??null,d=c??f?.link??null','f=e.localComments?.(r)??null,d=f?.link??null');
    patch('s=d?q9(d,f?.pins??W9(t.document)):null,h=c?h9(c):null', 's=d?q9(d,f?.pins??W9(t.document)):null,h=null');
    patch('flushForUnload:Wo,settle:async()=>{await ya(),await V,await ya(),await pt.settle()}', 'flushForUnload:Wo,settle:window.__tarobotDesignSettle=async()=>{await ya(),await V,await ya(),await pt.settle()}');
    patch('const M=await yA(t,n);c.post({type:"editor:flushed",requestId:x.requestId,saved:M})', 'let M=false;try{await t.__tarobotDesignSettle?.();M=await yA(t,n)}catch{}c.post({type:"editor:flushed",requestId:x.requestId,saved:M})');
    patch('import("./woff2-decoder-ZKHvEj5x.js")', 'import(window.__tarobotDesignResource("assets/woff2-decoder-ZKHvEj5x.js"))');
    patch('return Te.asset!==void 0?ca.get(Te.asset):Te.src', 'return window.__tarobotDesignAssets(Te.asset!==void 0?ca.get(Te.asset):Te.src)');
    patch('import.meta.url', '"https://design.invalid/"');
  } else if (format === "canvas") {
  // iOS omits every repair entry, including the error-list menu and damaged
  // index notice. The errors, editor and ordinary comment controls remain.
  patch('canAsk:qt&&(0,e.embedMemoryPrefix)()===""', 'canAsk:window.__tarobirdDesignRepairEnabled&&qt&&(0,e.embedMemoryPrefix)()===""');
  patch('ArtboardErrorsPopover,{problems:Dd,canvasTitle:document.title,canEdit:qt,', 'ArtboardErrorsPopover,{problems:Dd,canvasTitle:document.title,canEdit:window.__tarobirdDesignRepairEnabled&&qt,');
  patch('DesignIndexProblemNotice,{problem:kp,canAsk:Xm,', 'DesignIndexProblemNotice,{problem:kp,canAsk:window.__tarobirdDesignRepairEnabled&&Xm,');
  patch('viewOnly:(0,e.formatMessage)({defaultMessage:"Someone who can edit this canvas can ask the agent to fix them.",id:"QhQxoLgUY7"})',
    'viewOnly:window.__tarobirdDesignRepairEnabled?(0,e.formatMessage)({defaultMessage:"Someone who can edit this canvas can ask the agent to fix them.",id:"QhQxoLgUY7"}):""');
  patch('shownReader:(0,e.formatMessage)({defaultMessage:"This design’s saved layout has a problem, so its artboards appear side by side for now. They’re safe. Someone who can edit this design can ask the agent to fix the layout.",id:"R3IUU/OVLu"})',
    'shownReader:window.__tarobirdDesignRepairEnabled?(0,e.formatMessage)({defaultMessage:"This design’s saved layout has a problem, so its artboards appear side by side for now. They’re safe. Someone who can edit this design can ask the agent to fix the layout.",id:"R3IUU/OVLu"}):(0,e.formatMessage)({defaultMessage:"This design’s saved layout has a problem. Artboards are shown side by side and are read-only until the layout is repaired.",id:"tarobird.layoutProblem"})');
  patch('j.jsx(dX,{controller:e,state:a})', 'null');
  patch('let Re=De.deltaMode===1?16:De.deltaMode===2?window.innerHeight:1,Pe=De.deltaMode===1?16:De.deltaMode===2?window.innerWidth:1;if(be==="zoom"){let{sx:me,sy:ye}=se(De.clientX,De.clientY);C.setView(s(C.getView(),me,ye,d(De.deltaY*Re),C.limits))}else C.setView(l(C.getView(),-De.deltaX*Pe,-De.deltaY*Re))',
    `let delta=${wheel}(De,k.clientWidth,k.clientHeight);if(be==="zoom"){let{sx:me,sy:ye}=se(De.clientX,De.clientY);C.setView(s(C.getView(),me,ye,Math.exp(delta.zoomLog),C.limits))}else C.setView(l(C.getView(),-delta.dx,-delta.dy))`);
  // An artboard is a nested preview which forwards wheel messages rather than
  // bubbling them. Normalize here once, before forwarding, using the same rule.
  patch('var position = fillStyle.deltaMode === 1 ? 16 : fillStyle.deltaMode === 2 ? window.innerHeight : 1;\n      var shaft = fillStyle.deltaMode === 1 ? 16 : fillStyle.deltaMode === 2 ? window.innerWidth : 1;',
    `var delta = ${wheel}(fillStyle, window.innerWidth, window.innerHeight);`);
  patch('Math.max(\n            -0.22314,\n            Math.min(0.22314, -fillStyle.deltaY * position * 0.01)\n          )', 'delta.zoomLog');
  patch('fillStyle.deltaX * shaft,\n          fillStyle.deltaY * position,', 'delta.dx,\n          delta.dy,');
  // Keep upstream's editor controls available when embedded. Host messaging,
  // saves and downloads still go through the original framed host adapter.
  patch('let cg=typeof window<"u"&&window.parent===window', 'let cg=true');
  // Keep local comment UI and room events; writes still obey the strict tab-owned CAS.
  patch('Zq({localComments:e=>qX({base:e,toolbar:!0}),room:r$,clashes:f$});$K();qK();', 'Zq({base:"https://design.invalid/",localComments:e=>qX({base:e,toolbar:!0}),room:r$});window.designHost.chat={suggestPrompt:window.__tarobotDesignSuggest};$K();qK();');
  // TaroBot's virtual project paths allow Unicode names, spaces, parentheses
  // and plus signs. Upstream's ASCII-only component filter silently discarded
  // these saved artboards on load. Keep its traversal/reserved-name/length
  // checks; widen only this character filter inside the isolated editor.
  patch('Kt=/^[A-Za-z0-9_](?:[A-Za-z0-9 ._-]*[A-Za-z0-9_-])?$/',
    String.raw`Kt=/^[\p{L}\p{N}_](?:[\p{L}\p{N}\p{M} ._()+-]*[\p{L}\p{N}\p{M}_()+-])?$/u`);
  // Comments use the tab-owned local bridge even while embedded. Upstream
  // dispatch stays off; suggestion actions open a TaroBird draft for review.
  patch('m=c?null:e.localComments?.(n)??null,b=c??m?.link??null','m=e.localComments?.(n)??null,b=m?.link??null');
  patch('p=b?_q(b,m?.pins??Eq(a.document)):null,g=c?ZK(c):null', 'p=b?_q(b,m?.pins??Eq(a.document)):null,g=null');
  // The App opens a reviewable draft; upstream Canvas otherwise calls this
  // fallback "sent" even when suggestPrompt only populated a composer.
  patch('return await re(te),"sent"', 'return await re(te),"staged"');
  // Upstream mirrors live text edits before settling the editable model. Its
  // HTTP host's beforeunload loop alone cannot settle an active text session.
  // Reuse the editor's own settler (also used for export), then retain its full
  // unsaved/publish check. A refused settle must never acknowledge saved=true.
  patch('function uc(Se){Fn=Se}', 'function uc(Se){Fn=Se;window.__tarobotDesignSettle=Se}');
  patch('const d=await kC(a,x);c.post({type:"editor:flushed",requestId:l.requestId,saved:d})', 'let d=false;try{await a.__tarobotDesignSettle?.();d=await kC(a,x)}catch{}c.post({type:"editor:flushed",requestId:l.requestId,saved:d})');
  patch('X=l(R,q);return{doc:s(X,$),parts:T', 'X=window.__tarobotDesignAssets(l(R,q));return{doc:s(X,$),parts:T');
  patch('${JSON.stringify(l.kind)},${JSON.stringify(d)},${l.streaming?"true":"false"}', '${JSON.stringify(l.kind)},${JSON.stringify(window.__tarobotDesignAssets(d))},${l.streaming?"true":"false"}');
  // Runtime files become blob URLs, so retain their full URL instead of its pathname.
  const runtimeUrls = 'return new URL(T,document.baseURI).pathname';
  if (js.split(runtimeUrls).length !== 3) throw new Error("design_runtime_url_contract_changed");
  js = js.replaceAll(runtimeUrls, 'return new URL(T,document.baseURI).href');
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
