// The fixed loader runs no project content at the trusted asset origin. Each
// navigation gets a distinct fragment so permission requests identify one live
// opaque editor, including when several editors are open in split view.
export const DESIGN_BOOTSTRAP_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<script>addEventListener('message',function receive(e){if(e.source!==parent||e.data?.type!=='tarobot-design-html')return;removeEventListener('message',receive);document.open();document.write(e.data.html);document.close()});parent.postMessage({type:'tarobot-design-bootstrap'},'*')<\/script>`);
export function isDesignDocumentURL(value) {
  return typeof value === 'string' && value.startsWith(DESIGN_BOOTSTRAP_URL + '#')
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.slice(DESIGN_BOOTSTRAP_URL.length + 1));
}
