import Capacitor
import Foundation
#if canImport(UIKit)
import UIKit
#endif

@objc(HubTransportPlugin)
public final class HubTransportPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HubTransportPlugin"
    public let jsName = "TaroCubHubTransport"
    public let pluginMethods: [CAPPluginMethod] = ["document", "allocate", "cancel", "httpOpen", "httpRead", "socketOpen", "socketSend", "socketAck", "socketClose", "screenOpen", "screenSend", "screenRead", "screenAck", "screenClose", "screenWindow", "screenRtc"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private var transport: HubTransport?
#if canImport(UIKit)
    private var screenObservers: [NSObjectProtocol] = []
    private weak var screenScene: UIWindowScene?
    private var screenSceneBlocked = false, screenProtectedUnavailable = false
#endif
    // Epoch is sampled at the ObjC entry before hopping to main. The page nonce
    // also fences calls Capacitor queued before reset but dispatched afterward.
    private let epochLock = NSLock()
    private var generation: UInt64 = 0
    private var activeDocument: String?
    private var activePageToken: String?
    private func epoch(bump: Bool = false) -> UInt64 {
        epochLock.lock(); defer { epochLock.unlock() }
        if bump { generation &+= 1 }; return generation
    }

    public override func load() {
        onMain {
            self.transport = HubTransport { [weak self] event in
                DispatchQueue.main.async {
                    guard let self = self, let document = event["document"] as? String,
                          document == self.activeDocument, let token = self.activePageToken else { return }
                    guard self.transport?.acceptScreenEvent(event) == true else { return }
                    self.notifyListeners("socket:" + token, data: event)
                }
            }
            self.observeScreenLifecycle()
        }
    }
    private func observeScreenLifecycle() {
#if canImport(UIKit)
        let center = NotificationCenter.default
        for name in [UIScene.willDeactivateNotification, UIScene.didEnterBackgroundNotification, UIScene.didDisconnectNotification] {
            screenObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                guard let self = self, let scene = note.object as? UIWindowScene,
                      scene === self.screenScene || scene === self.webView?.window?.windowScene else { return }
                self.screenSceneBlocked = true; self.transport?.setScreenActive(false)
            })
        }
        screenObservers.append(center.addObserver(forName: UIApplication.protectedDataWillBecomeUnavailableNotification, object: nil, queue: .main) { [weak self] _ in
            self?.screenProtectedUnavailable = true; self?.transport?.setScreenActive(false)
        })
        screenObservers.append(center.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main) { [weak self] note in
            guard let self = self, let scene = note.object as? UIWindowScene,
                  scene === self.screenScene || scene === self.webView?.window?.windowScene else { return }
            self.screenSceneBlocked = false; self.refreshScreenActivity()
        })
        screenObservers.append(center.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main) { [weak self] _ in
            self?.screenProtectedUnavailable = false; self?.refreshScreenActivity()
        })
#endif
    }
    private func refreshScreenActivity() {
#if canImport(UIKit)
        let scene = webView?.window?.windowScene
        screenScene = scene
        transport?.setScreenActive(!screenSceneBlocked && !screenProtectedUnavailable && scene?.activationState == .foregroundActive && UIApplication.shared.isProtectedDataAvailable)
#else
        transport?.setScreenActive(false)
#endif
    }
    private func onMain(_ action: @escaping () -> Void) {
        if Thread.isMainThread { action() } else { DispatchQueue.main.async(execute: action) }
    }
    private func clearDocument(resetPage: Bool) {
        activeDocument = nil
        if resetPage { activePageToken = nil }
        eventListeners?.removeAllObjects(); retainedEventArguments?.removeAllObjects()
        transport?.reset()
    }
    // CapacitorBridge.reset() calls this selector with nil on actual navigation
    // and WebKit process termination. Keep the parameter nullable for that
    // native call; do not mistake a cancelled external link for a navigation.
    public override func removeAllListeners(_ call: CAPPluginCall?) {
        let captured = epoch(bump: call == nil)
        onMain { guard self.epoch() == captured else { return }; self.clearDocument(resetPage: call == nil); call?.resolve() }
    }
    public override func addListener(_ call: CAPPluginCall) {
        let captured = epoch()
        onMain {
            guard self.epoch() == captured, let token = self.activePageToken, call.getString("eventName") == "socket:" + token else { return }
            super.addListener(call)
        }
    }
    public override func removeListener(_ call: CAPPluginCall) {
        let captured = epoch()
        onMain {
            guard self.epoch() == captured, let token = self.activePageToken, call.getString("eventName") == "socket:" + token else { return }
            super.removeListener(call)
        }
    }

    private func perform(_ method: String, _ call: CAPPluginCall) {
        let captured = epoch()
        onMain {
            guard self.epoch() == captured else { return }
            guard let transport = self.transport else { call.reject("native_transport_unavailable"); return }
            guard let token = call.getString("pageToken"), token.utf8.count == 32,
                  token.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { call.reject("native_page_token_required"); return }
            if method == "document" {
                guard let webView = self.webView else { call.reject("native_transport_unavailable"); return }
                webView.evaluateJavaScript("window.__TAROCUB_NATIVE_PAGE_TOKEN__") { [weak self] value, error in
                    guard let self = self, self.epoch() == captured else { return }
                    // A delayed claim from a destroyed document must neither
                    // reset this document nor send its callback into this page.
                    guard error == nil, value as? String == token else { return }
                    self.activePageToken = token; self.activeDocument = nil
                    self.dispatch(method, call, transport, captured)
                }
                return
            }
            guard token == self.activePageToken else { return }
            if method.hasPrefix("screen") || (method == "allocate" && call.getString("kind") == "screen") { self.refreshScreenActivity() }
            if (method == "socketOpen" || method == "screenOpen"), !self.hasListeners("socket:" + token) {
                if let id = call.getString("id") { transport.invoke("cancel", ["id": id]) { _ in } }
                call.reject("native_socket_listener_required"); return
            }
            self.dispatch(method, call, transport, captured)
        }
    }
    private func dispatch(_ method: String, _ call: CAPPluginCall, _ transport: HubTransport, _ captured: UInt64) {
            transport.invoke(method, call.options as? [String: Any] ?? [:]) { [weak self] result in
                DispatchQueue.main.async {
                    // Old callback IDs must never be injected into the new page.
                    guard let self = self, self.epoch() == captured else { return }
                    switch result {
                    case .success(let value):
                        if method == "document" { self.activeDocument = value["value"] as? String }
                        call.resolve(value)
                    case .failure(let error):
                        call.reject(HubNetworkError.classify(error, host: Self.requestHost(method, call.options as? [String: Any])))
                    }
                }
            }
    }
    private static func requestHost(_ method: String, _ options: [String: Any]?) -> String? {
        guard let options = options else { return nil }
        let rawOrigin: String?
        if method == "httpOpen", let input = options["input"] as? [String: Any] {
            rawOrigin = input["origin"] as? String
        } else if method == "screenOpen", let network = options["network"] as? [String: Any] {
            rawOrigin = network["url"] as? String
        } else {
            rawOrigin = options["origin"] as? String
        }
        guard let origin = rawOrigin, let url = URL(string: origin) else { return nil }
        let host = HubTLS.hostname(url)
        return host.isEmpty ? nil : host
    }
    @objc func document(_ call: CAPPluginCall) { perform("document", call) }
    @objc func allocate(_ call: CAPPluginCall) { perform("allocate", call) }
    @objc func cancel(_ call: CAPPluginCall) { perform("cancel", call) }
    @objc func httpOpen(_ call: CAPPluginCall) { perform("httpOpen", call) }
    @objc func httpRead(_ call: CAPPluginCall) { perform("httpRead", call) }
    @objc func socketOpen(_ call: CAPPluginCall) { perform("socketOpen", call) }
    @objc func socketSend(_ call: CAPPluginCall) { perform("socketSend", call) }
    @objc func socketAck(_ call: CAPPluginCall) { perform("socketAck", call) }
    @objc func socketClose(_ call: CAPPluginCall) { perform("socketClose", call) }
    @objc func screenOpen(_ call: CAPPluginCall) { perform("screenOpen", call) }
    @objc func screenSend(_ call: CAPPluginCall) { perform("screenSend", call) }
    @objc func screenRead(_ call: CAPPluginCall) { perform("screenRead", call) }
    @objc func screenAck(_ call: CAPPluginCall) { perform("screenAck", call) }
    @objc func screenClose(_ call: CAPPluginCall) { perform("screenClose", call) }
    /// The most packets of one stream generation this layer holds for the page (see HubScreenSession.BINARY_WINDOW).
    @objc func screenRtc(_ call: CAPPluginCall) { call.resolve(["value": true]) }
    @objc func screenWindow(_ call: CAPPluginCall) { call.resolve(["value": HubScreenSession.BINARY_WINDOW]) }
    deinit {
#if canImport(UIKit)
        screenObservers.forEach { NotificationCenter.default.removeObserver($0) }
#endif
        transport?.setScreenActive(false); transport?.reset(destroy: true)
    }
}
