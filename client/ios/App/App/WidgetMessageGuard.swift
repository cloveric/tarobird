import Foundation
import WebKit

/// App-owned boundary: works with Capacitor's prebuilt SwiftPM framework too.
/// The frame identity comes from WebKit, never from a JavaScript payload.
final class WidgetMessageGuard: NSObject, WKScriptMessageHandler {
    private weak var webView: WKWebView?
    private weak var downstream: WKScriptMessageHandler?

    private init(webView: WKWebView, downstream: WKScriptMessageHandler) {
        self.webView = webView
        self.downstream = downstream
    }

    static func install(in webView: WKWebView, forwardingTo downstream: WKScriptMessageHandler) -> WidgetMessageGuard {
        let guardHandler = WidgetMessageGuard(webView: webView, downstream: downstream)
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: "bridge")
        controller.add(guardHandler, name: "bridge")
        // This capability is exposed only after the native handler was replaced,
        // and only in the App frame. Older binaries remain summary-only.
        controller.addUserScript(WKUserScript(
            source: "Object.defineProperty(window,'tarobotWidgetIsolation',{value:Object.freeze({supported:()=>true}),configurable:false,writable:false});",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        return guardHandler
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.webView === webView else { return }
        downstream?.userContentController(userContentController, didReceive: message)
    }
}
