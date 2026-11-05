// macOS WKWebView regression for the App-owned iOS bridge guard.
// Compile this with ../App/App/WidgetMessageGuard.swift; this is not an iOS device test.
import Cocoa
import WebKit

final class Probe: NSObject, WKScriptMessageHandler {
    var forwarded: [String] = []
    var webView: WKWebView!
    var guardHandler: WidgetMessageGuard!
    var window: NSWindow!
    func start() {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "result")
        webView = WKWebView(frame: NSRect(x:0,y:0,width:500,height:400), configuration: config)
        guardHandler = WidgetMessageGuard.install(in: webView, forwardingTo: self)
        window = NSWindow(contentRect: webView.frame, styleMask:[.titled,.closable],backing:.buffered,defer:false)
        window.title = "TaroBot iOS bridge guard probe"
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        webView.loadHTMLString("""
        <p>Main frame bridge guard probe</p><script>
        window.webkit.messageHandlers.bridge.postMessage({tag:'main'});
        addEventListener('message',event=>{if(event.data?.tag==='guest-result'){
          window.webkit.messageHandlers.result.postMessage({mainFlag:window.tarobotWidgetIsolation?.supported()===true,guestRan:true,guestFlag:event.data.flag});
        }});
        </script><iframe sandbox="allow-scripts" srcdoc="<script>window.webkit.messageHandlers.bridge.postMessage({tag:'guest'});parent.postMessage({tag:'guest-result',flag:!!window.tarobotWidgetIsolation},'*');</script>"></iframe>
        """,baseURL:URL(string:"https://widget-audit.invalid"))
        DispatchQueue.main.asyncAfter(deadline:.now()+12){self.finish(["error":"timeout"],false)}
    }
    func userContentController(_ controller: WKUserContentController,didReceive message: WKScriptMessage) {
        let data = message.body as? [String:Any] ?? [:]
        if message.name == "bridge" { forwarded.append(data["tag"] as? String ?? "unknown"); return }
        if message.name == "result" {
            let passed = forwarded == ["main"] && data["mainFlag"] as? Bool == true && data["guestRan"] as? Bool == true && data["guestFlag"] as? Bool == false
            var receipt=data;receipt["forwarded"]=forwarded;receipt["surface"]="macOS WKWebView running the exact iOS App-owned WidgetMessageGuard.swift"
            finish(receipt,passed)
        }
    }
    func finish(_ data:[String:Any],_ passed:Bool) {
        var receipt=data;receipt["passed"]=passed
        let file=ProcessInfo.processInfo.environment["TAROBOT_WIDGET_GUARD_OUTPUT"]!
        try! JSONSerialization.data(withJSONObject:receipt,options:[.prettyPrinted,.sortedKeys]).write(to:URL(fileURLWithPath:file))
        exit(passed ? 0 : 1)
    }
}
@main struct Main {
    static func main() { let app=NSApplication.shared;app.setActivationPolicy(.accessory);let probe=Probe();probe.start();app.run() }
}
