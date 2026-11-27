import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { buildSync } from "esbuild";
import type { DesignFormat } from "../src/client-protocol/workbench-design.js";
import { designWheelDelta } from "./src/design-wheel.js";
import { DESIGN_BOOTSTRAP_URL } from "./electron/design-document.mjs";

const escapeScript = (text: string) => text.replace(/<\/script/gi, "<\\/script");
/** The presentation editor bundle is pinned and byte checked. Adapt only its
 * host entry points at build time, inside an opaque-origin editor, never the
 * App document. The Baoyu Design canvas sandbox was removed (#89). */
export function buildDesignSandbox(format: DesignFormat = "slides"): string {
  if (format !== "slides") throw new Error("design_canvas_removed");
  const root = new URL("./vendor/workbench-slides/", import.meta.url);
  const read = (name: string) => readFileSync(new URL(name, root), "utf8");
  const manifest = JSON.parse(read("UPSTREAM.json"));
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (createHash("sha256").update(readFileSync(new URL(name, root))).digest("hex") !== expected) throw new Error(`design_upstream_changed:${name}`);
  }
  const page = read("editor/index.html");
  const script = [...page.matchAll(/src="\.\/([^\"]+\.js)"/g)].at(-1)![1], css = page.match(/href="\.\/([^\"]+\.css)"/)![1];
  let js = read("editor/" + script);
  const patch = (from: string, to: string) => { if (js.split(from).length !== 2) throw new Error("design_adapter_contract_changed:" + from.slice(0,100)); js = js.replace(from, to); };
  // Slides uses the Apache-2.0 Open Artifact editor core via the official
  // window.openartifact capability runtime installed by design-runtime.js.
  js = js.replaceAll("import.meta.url", '"https://design.invalid/"');
  // Register a synchronous text-edit committer so host editor:flush never
  // races the 400ms input debounce or React's async unmount cleanup.
  patch(
    'const I=()=>{g.current&&clearTimeout(g.current),g.current=null,KfA(i,o,l,s,r.current)},C=',
    'const I=()=>{g.current&&clearTimeout(g.current),g.current=null,KfA(i,o,l,s,r.current)};window.__tarobotSlidesCommitText=I;const C=',
  );
  patch(
    '()=>{l.removeEventListener("input",C),l.removeEventListener("keydown",Q),l.removeEventListener("paste",u),l.removeEventListener("blur",E),I(),Vl===l&&(Vl=null),Wl=null}',
    '()=>{l.removeEventListener("input",C),l.removeEventListener("keydown",Q),l.removeEventListener("paste",u),l.removeEventListener("blur",E),I(),window.__tarobotSlidesCommitText===I&&(window.__tarobotSlidesCommitText=null),Vl===l&&(Vl=null),Wl=null}',
  );
  // Ensure Ch.flush() awaits any already in-flight save and re-flushes if
  // another edit landed concurrently.
  patch(
    'let n=null,i=!1,o=!1,s=Qy;const r=new Map;function g(u=A.saveDelay){A.readOnly()||(A.isDirty()&&A.setSave(A.save()==="offline"?"offline":"dirty"),n!==null&&t.clear(n),n=t.set(()=>{n=null,l()},u))}async function l(){if(i){o=!0;return}i=!0;try{for(let E=0;E<=e;E++){const{batch:h,sent:p}=A.collect();if(Object.keys(h).length===0){A.unsent?.(p);break}A.setSave("saving");try{const y=await A.artifact().publish(h);A.acknowledge(p,y.hashes),s=Qy;break}catch(y){if(nF(y,"conflict")&&E<e){await I(y.paths??[]);continue}if(nF(y,"not_writer")){A.lostWriteAccess();return}A.setSave("offline"),s=Math.min(s*2,HtA),g(s);return}}}finally{i=!1}const u=A.isDirty();o||u?(o=!1,g(u?A.saveDelay:0)):(A.setSave("saved"),A.saved?.())}',
    'let n=null,i=!1,o=!1,s=Qy,_p=null;const r=new Map;function g(u=A.saveDelay){A.readOnly()||(A.isDirty()&&A.setSave(A.save()==="offline"?"offline":"dirty"),n!==null&&t.clear(n),n=t.set(()=>{n=null,l()},u))}function l(){if(i){o=!0;return _p?_p.then(()=>{if(o){o=!1;return l()}}):Promise.resolve()}i=!0;return _p=(async()=>{try{for(let E=0;E<=e;E++){const{batch:h,sent:p}=A.collect();if(Object.keys(h).length===0){A.unsent?.(p);break}A.setSave("saving");try{const y=await A.artifact().publish(h);A.acknowledge(p,y.hashes),s=Qy;break}catch(y){if(nF(y,"conflict")&&E<e){await I(y.paths??[]);continue}if(nF(y,"not_writer")){A.lostWriteAccess();return}A.setSave("offline"),s=Math.min(s*2,HtA),g(s);return}}}finally{i=!1;_p=null}const u=A.isDirty();o||u?(o=!1,g(u?A.saveDelay:0)):(A.setSave("saved"),A.saved?.())})()}',
  );
  patch(
    'const t=async()=>{try{return eA.getState().endTextEdit(),await Ux(),!na(oA.getState())}catch{return!1}};',
    'const t=async()=>{try{window.__tarobotSlidesCommitText?.(),eA.getState().endTextEdit(),await Promise.resolve(),await Ux(),na(oA.getState())&&oA.getState().save!=="offline"&&await Ux();return!na(oA.getState())}catch{return!1}};',
  );
  // Keep unsupported standalone batch-send ("Send all to Bot") out of the
  // embedded App, and describe single-thread Send-to-Bot honestly as a draft.
  patch('B.jsx(REA,{comments:A,agent:e,threads:I})', 'null');
  patch(
    'function _v(A,e){return e===!1?{title:`Sent to ${A}`,description:`${A} gets it on its next turn. If it is idle, send it a message there to start one.`}:{title:`Sent to ${A}`}}',
    'function _v(A){return{title:"Added to your message to the agent. Send it when you’re ready.",description:`Review and send your message to ${A} in the conversation.`}}',
  );
  // Treat user-cancelled export confirmations cleanly without a failure modal.
  patch(
    'catch(n){const i=n instanceof Error&&n.message?n.message:String(n);throw new Error(`The file could not be saved: ${i}`)}',
    'catch(n){if(n&&n.code==="declined")throw n;const i=n instanceof Error&&n.message?n.message:String(n);throw new Error(`The file could not be saved: ${i}`)}',
  );
  patch(
    'catch(o){const s=o instanceof Error?o.message:String(o);n?.exportState(e,"failed",s),zt.getState().setNotes({name:"Download failed",notes:[s]})}',
    'catch(o){if(o&&o.code==="declined"){n?.exportState(e,"declined");return}const s=o instanceof Error?o.message:String(o);n?.exportState(e,"failed",s),zt.getState().setNotes({name:"Download failed",notes:[s]})}',
  );
  // Accept live tab renames from the host without remounting the editor.
  patch(
    'document.title=A.title||"Slides",window.parent&&window.parent!==window',
    'window.__tarobotSlidesSetTitle=next=>{if(typeof next==="string"&&next.trim()){oA.setState({title:next.trim()});document.title=next.trim();}},document.title=A.title||"Slides",window.parent&&window.parent!==window',
  );
  patch(
    'function ruA(){const A=oA.getState();return A.index.title.trim()?jF(A.index):A.title.trim()||jF(A.index)}',
    'function ruA(){const A=oA.getState();return A.title.trim()||jF(A.index)}',
  );
  // Show the compact slide pager on narrow viewports (when the rail is hidden)
  // as well as read-only preview mode.
  patch(
    'e&&s==="edit"&&o.length>1?B.jsx("div",{className:"pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3"',
    '(e||!E)&&s==="edit"&&o.length>1?B.jsx("div",{className:"pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3"',
  );
  // Without an external Open Artifact Shell, Comments button / C / Escape
  // toggle embedded comment-pin mode directly.
  patch(
    'onClick:()=>{const o=Ut.getState(),s=!o.listOpen;o.setListOpen(s),!s&&o.on&&o.setOn(!1)}',
    'onClick:()=>{const o=Ut.getState(),s=!o.listOpen;o.setListOpen(s),Ig()&&o.setOn(s)}',
  );
  patch(
    'Ut.getState().on?Ii()?.shell?.requestCommentMode(!1):',
    'Ut.getState().on?(Ii()?.shell?Ii().shell.requestCommentMode(!1):Ut.getState().setOn(!1)):',
  );
  patch(
    'if(o==="c"&&!e.shiftKey&&Ut.getState().available){Ii()?.shell?.requestCommentMode(!Ut.getState().on);return}',
    'if(o==="c"&&!e.shiftKey&&Ut.getState().available){Ii()?.shell?Ii().shell.requestCommentMode(!Ut.getState().on):Ut.getState().setOn(!Ut.getState().on);return}',
  );
  // Normalize stage wheel zoom and overflow pan with one bounded curve,
  // and rebind once the stage ref mounts (I transitions from null to the slide root).
  const wheel = `(${designWheelDelta.toString()})`;
  patch(
    'const v=F=>{if(!(F.ctrlKey||F.metaKey))return;F.preventDefault();const J=eA.getState();J.setZoom(eE(J)*Math.exp(-F.deltaY*.01))};return K.addEventListener("wheel",v,{passive:!1}),()=>K.removeEventListener("wheel",v)},[]',
    `const v=F=>{const d=${wheel}(F,K.clientWidth,K.clientHeight);if(F.ctrlKey||F.metaKey){F.preventDefault();const J=eA.getState();J.setZoom(eE(J)*Math.exp(d.zoomLog));return}if((K.scrollHeight>K.clientHeight||K.scrollWidth>K.clientWidth)&&!(F.target instanceof Element&&F.target.closest("[data-open-artifact-notes],[data-open-artifact-comment-ui],[data-comments-panel]"))){F.preventDefault();K.scrollLeft+=d.dx;K.scrollTop+=d.dy}};return K.addEventListener("wheel",v,{passive:!1}),()=>K.removeEventListener("wheel",v)},[I]`,
  );
  const resources: Record<string, { type: string; base64: string }> = {};
  // Keep standalone sharing, workers (inline fallback runs in-thread), and Node exporters out of the App frame.
  for (const name of Object.keys(manifest.files)) if (name.startsWith("editor/") && !name.startsWith("editor/node/") && name !== "editor/share-ui.js" && !/^editor\/assets\/worker-.*\.js$/.test(name)) {
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
  return `<!doctype html><html lang="en" class="cds-root" data-density="comfortable"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src blob: data:; worker-src blob:; media-src blob: data:; frame-src blob: data:; base-uri https://design.invalid; form-action 'none'; object-src 'none'"><base href="https://design.invalid/"><meta name="viewport" content="width=device-width,initial-scale=1">${(page.match(/<meta name="appifact-capabilities"[^>]+>/) ?? [""])[0]}<title>Presentation</title><style>${style}</style></head><body><div id="root"></div><script>${escapeScript(bridge)}\nDesignRuntime.startDesignRuntime(${JSON.stringify(resources)},()=>{${escapeScript(js)}},"slides");</script></body></html>`;
}
// Only this fixed trusted trampoline runs at the asset origin. It never reads
// messages, query parameters or project data. The actual editor is created
// after navigating to an opaque data origin, inheriting this document's CSP.
export const designLoaderHtml = () => {
  const policy = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src blob: data:; worker-src blob:; media-src blob: data:; frame-src blob: data:; base-uri https://design.invalid; form-action 'none'; object-src 'none'";
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><script>if(parent!==window)location.replace(${JSON.stringify(DESIGN_BOOTSTRAP_URL)}+"#"+crypto.randomUUID());<\/script>`;
};
export function designAssets(): Plugin {
  let slidesHtml: string | undefined;
  const buildSlides = () => (slidesHtml ??= buildDesignSandbox("slides"));
  return {
    name: "tarobot-design-sandbox",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === "/design-loader.html") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(designLoaderHtml()); return; }
        if (req.url === "/slides-sandbox.html") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(buildSlides()); return; }
        next();
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "design-loader.html", source: designLoaderHtml() });
      this.emitFile({ type: "asset", fileName: "slides-sandbox.html", source: buildSlides() });
      // THIRD-PARTY-NOTICES.txt is ours: upstream ships no notice for what its bundle compiles in.
      for (const name of ["LICENSE", "NOTICE", "UPSTREAM.json", "THIRD-PARTY-NOTICES.txt"]) {
        this.emitFile({ type: "asset", fileName: `licenses/workbench-slides/${name}`, source: readFileSync(new URL(`./vendor/workbench-slides/${name}`, import.meta.url), "utf8") });
      }
    },
  };
}
