import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Android's legacy fallback cannot validate the calling frame. iOS uses the
// App-owned WidgetMessageGuard; patching node_modules would not affect SwiftPM's
// prebuilt Capacitor framework. Both platforms also require a native runtime flag.
export async function guardWidgetBridges() {
  const iosController = await readFile(new URL("../ios/App/App/ShareInboxPlugin.swift", import.meta.url), "utf8");
  const iosGuard = await readFile(new URL("../ios/App/App/WidgetMessageGuard.swift", import.meta.url), "utf8");
  const iosProject = await readFile(new URL("../ios/App/App.xcodeproj/project.pbxproj", import.meta.url), "utf8");
  if (!iosController.includes("WidgetMessageGuard.install(in: webView, forwardingTo: nativeBridge.webViewDelegationHandler)") ||
      !iosGuard.includes("guard message.frameInfo.isMainFrame, message.webView === webView else { return }") ||
      !iosProject.includes("WidgetMessageGuard.swift in Sources")) throw new Error("widget_ios_bridge_guard_missing");
  const file = fileURLToPath(new URL("../node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/MessageHandler.java", import.meta.url));
  const source = await readFile(file, "utf8");
  const marker = "// TaroBot: report whether native messages reject subframes.";
  if (!source.includes(marker)) {
    const original = source.replaceAll('throw new IllegalStateException("TaroBot requires a WebView with main-frame native messaging");', 'webView.addJavascriptInterface(this, "androidBridge");');
    const anchor = '        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)';
    const registered = 'WebViewCompat.addWebMessageListener(webView, "androidBridge", bridge.getAllowedOriginRules(), capListener);';
    const end = '    }\n\n    /**\n     * The main message handler';
    if (original.split(anchor).length !== 2 || original.split(registered).length !== 2 || original.split(end).length !== 2 || !original.includes("if (isMainFrame)")) throw new Error("widget_android_bridge_patch_mismatch");
    const patched = original.replace(anchor, '        '+marker+'\n        boolean widgetIsolation = false;\n'+anchor)
      .replace(registered, registered+'\n                widgetIsolation = true;')
      .replace(end, `        final boolean isolated = widgetIsolation;
        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface public boolean supported() { return isolated; }
        }, "tarobotWidgetIsolation");
${end}`);
    await writeFile(file, patched);
  } else if (!source.includes('public boolean supported() { return isolated; }') || !source.includes('widgetIsolation = true;')) throw new Error("widget_android_bridge_patch_mismatch");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await guardWidgetBridges();
