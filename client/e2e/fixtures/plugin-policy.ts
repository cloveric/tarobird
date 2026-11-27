import { wrapSandboxedDocument } from "../../src/plugin-sandbox-runtime.js";

// All descendants and the worker use inert local content. No probe creates a
// WebRTC object or connects to a network service.
const inertGuest = `<!doctype html><html><head>
<meta http-equiv="x-dns-prefetch-control" content="on">
<link rel="dns-prefetch" href="about:blank">
<link rel="preconnect" href="about:blank">
</head><body><main>Guest policy fixture</main>
<iframe srcdoc="<p>Static child sentinel</p>"></iframe>
<iframe src="data:text/html,Static child sentinel"></iframe>
<script>
(async () => {
  const violations = [];
  document.addEventListener("securitypolicyviolation", event => violations.push(event.effectiveDirective));
  const staticFrames = document.querySelectorAll("iframe, frame, object, embed").length;
  const dataFrame = document.createElement("iframe");
  dataFrame.src = "data:text/html,Static%20runtime%20sentinel";
  const srcdocFrame = document.createElement("iframe");
  srcdocFrame.srcdoc = "<p>Static runtime sentinel</p>";
  document.body.append(dataFrame, srcdocFrame);
  let workerStarted = false;
  const blob = URL.createObjectURL(new Blob(['postMessage("inert-ready")'], { type: "text/javascript" }));
  try {
    const worker = new Worker(blob);
    await new Promise(resolve => {
      worker.onmessage = () => { workerStarted = true; resolve(); };
      worker.onerror = () => resolve();
      setTimeout(resolve, 500);
    });
    worker.terminate();
  } catch {}
  URL.revokeObjectURL(blob);
  await new Promise(resolve => setTimeout(resolve, 250));
  parent.postMessage({ protocol: "tarobird.plugin.v1", id: "policy-fixture", result: {
    childFrames: staticFrames,
    hints: document.querySelectorAll("link[rel='dns-prefetch'], link[rel='preconnect']").length,
    dns: document.querySelector("meta[http-equiv='x-dns-prefetch-control']")?.content,
    csp: document.querySelector("meta[http-equiv='Content-Security-Policy']")?.content,
    rtc: [typeof RTCPeerConnection, typeof webkitRTCPeerConnection, typeof RTCDataChannel],
    workerStarted, violations,
  } }, "*");
})();
</script></body></html>`;

const shell = document.querySelector<HTMLIFrameElement>("#shell")!;
const result = document.querySelector("#result")!;
window.addEventListener("message", (event) => {
  if (event.source !== shell.contentWindow) return;
  if (event.data?.type === "tarobird-plugin-shell-ready") {
    shell.contentWindow?.postMessage({ type: "tarobird-plugin-init", document: wrapSandboxedDocument(inertGuest, []) }, "*");
  } else if (event.data?.id === "policy-fixture") {
    result.textContent = JSON.stringify(event.data.result);
  }
});
shell.src = shell.dataset.source!;
