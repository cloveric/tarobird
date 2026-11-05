/** Vditor's runtime resources are pinned, local and lazy. Never relax the App's
 * script CSP for its default synchronous inline icon loader. */
export const VDITOR_ROOT = "/vditor/4.0.1";
const loads = new Map<string, Promise<void>>();
const locales = new Map<string, ITips>();
function script(path: string, id: string) {
  if (document.getElementById(id)) return Promise.resolve();
  const prior = loads.get(id); if (prior) return prior;
  const loading = new Promise<void>((resolve, reject) => {
    const errors = Error as ErrorConstructor & { stackTraceLimit?: number }, traceLimit = errors.stackTraceLimit;
    const element = document.createElement("script"); element.src = `${VDITOR_ROOT}/${path}`; element.async = true;
    const timer = setTimeout(() => { element.remove(); loads.delete(id); reject(Error("markdown_editor_load_failed")); }, 15000);
    element.onload = () => { if (path.includes("/lute/")) { if (traceLimit === undefined) Reflect.deleteProperty(errors, "stackTraceLimit"); else errors.stackTraceLimit = traceLimit; } clearTimeout(timer); element.id = id; if (path.includes("/i18n/")) locales.set(id, window.VditorI18n); resolve(); };
    element.onerror = () => { clearTimeout(timer); element.remove(); loads.delete(id); reject(Error("markdown_editor_load_failed")); };
    document.head.appendChild(element);
  }); loads.set(id, loading); return loading;
}
export async function loadVditor(en: boolean) {
  const lang = en ? "en_US" : "zh_CN";
  const [module] = await Promise.all([import("vditor"), script("dist/js/lute/lute.min.js", "vditorLuteScript"), script(`dist/js/i18n/${lang}.js`, `vditorI18nScript${lang}`), script("dist/js/icons/ant.js", "tarobotVditorIcons")]);
  // destroy() removes Vditor's marker but leaves the sprite. Keep our own load
  // marker and reinstall only this inert sentinel for future/split editors.
  if (!document.getElementById("vditorIconScript")) { const marker = document.createElement("script"); marker.type = "application/json"; marker.id = "vditorIconScript"; document.head.appendChild(marker); }
  return { Constructor: module.default, i18n: locales.get(`vditorI18nScript${lang}`)! };
}
