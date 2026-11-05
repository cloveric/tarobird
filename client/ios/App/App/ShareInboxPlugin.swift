import Capacitor
import Foundation
import UIKit

@objc(ShareInboxPlugin)
public class ShareInboxPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShareInboxPlugin"
    public let jsName = "TaroCubShareInbox"
    public let pluginMethods: [CAPPluginMethod] = ["setMaxFileBytes", "list", "prepare", "readChunk", "remove", "clear", "pushTokenSnapshot"].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }
    @objc func pushTokenSnapshot(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var snapshot: [String: Any] = ["revision": AppDelegate.pushRevision, "failed": AppDelegate.pushFailed]
            if let token = AppDelegate.pushToken { snapshot["token"] = token }
            call.resolve(snapshot)
        }
    }
    private let queue = DispatchQueue(label: "com.tarobot.share-inbox")
    private func perform(_ call: CAPPluginCall, action: @escaping (ShareInboxStore) throws -> [String: Any]) {
        queue.async { do { call.resolve(try action(ShareInboxStore())) } catch { call.reject(error.localizedDescription) } }
    }
    @objc func list(_ call: CAPPluginCall) { perform(call) { ["items": try $0.list()] } }
    @objc func setMaxFileBytes(_ call: CAPPluginCall) {
        guard let value = call.getDouble("maxFileBytes"), value.isFinite, value.rounded(.towardZero) == value, value > 0, value <= 9007199254740991 else { call.reject("share_limit_invalid"); return }
        perform(call) { try $0.setMaxFileBytes(Int(value)); return [:] }
    }
    @objc func prepare(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let delivery = call.getObject("delivery") else { call.reject("share_delivery_invalid"); return }
        perform(call) { try $0.prepare(id, delivery: delivery) }
    }
    @objc func readChunk(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let index = call.getInt("index"), let offset = call.getInt("offset"), let length = call.getInt("length") else { call.reject("share_chunk_invalid"); return }
        perform(call) { ["data": try $0.chunk(id, index: index, offset: offset, length: length)] }
    }
    @objc func remove(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("share_id_invalid"); return }
        perform(call) { try $0.remove(id); return [:] }
    }
    @objc func clear(_ call: CAPPluginCall) { perform(call) { try $0.clear(); return [:] } }
}

class TaroCubBridgeViewController: CAPBridgeViewController, UIGestureRecognizerDelegate {
    private var widgetMessageGuard: WidgetMessageGuard?
    private var keyboardInsets: TaroBotKeyboardInsets?
    private var edgeBackStart: CGPoint?
    override func capacitorDidLoad() {
        if let nativeBridge = bridge as? CapacitorBridge, let webView = webView {
            widgetMessageGuard = WidgetMessageGuard.install(in: webView, forwardingTo: nativeBridge.webViewDelegationHandler)
            keyboardInsets = TaroBotKeyboardInsets(view: view, webView: webView)
            // A SPA has no WKWebView history to swipe through. Use the same
            // modal-aware Back stack as Android, starting only at the screen edge
            // so ordinary horizontal code/table/image gestures stay local.
            let back = UIPanGestureRecognizer(target: self, action: #selector(edgeBack(_:)))
            back.maximumNumberOfTouches = 1
            back.delegate = self
            back.cancelsTouchesInView = false
            webView.addGestureRecognizer(back)
            webView.scrollView.panGestureRecognizer.require(toFail: back)
        }
        bridge?.registerPluginInstance(ShareInboxPlugin())
        bridge?.registerPluginInstance(AttachmentSaverPlugin())
        bridge?.registerPluginInstance(HubTransportPlugin())
        bridge?.registerPluginInstance(DeviceIdentityPlugin())
        bridge?.registerPluginInstance(NotificationSettingsPlugin())
        bridge?.registerPluginInstance(QrPhotoSaverPlugin())
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        keyboardInsets?.layoutChanged()
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        true
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        let point = touch.location(in: view)
        let atEdge = KeyboardInsetGeometry.isBackEdge(point.x, safeLeft: view.safeAreaInsets.left)
        edgeBackStart = atEdge ? point : nil
        return atEdge
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
        let velocity = pan.velocity(in: view)
        return velocity.x > abs(velocity.y)
    }

    @objc private func edgeBack(_ gesture: UIPanGestureRecognizer) {
        if gesture.state == .cancelled || gesture.state == .failed { edgeBackStart = nil; return }
        guard gesture.state == .ended, let start = edgeBackStart else { return }
        edgeBackStart = nil
        let end = gesture.location(in: view)
        // Measure from touch-down, including quick flicks whose first movement
        // is also the recognizer's .began (its translation may still be zero).
        let movement = CGPoint(x: end.x - start.x, y: end.y - start.y)
        let speed = gesture.velocity(in: view)
        guard movement.x > abs(movement.y), speed.x >= 0,
              movement.x >= max(60, view.bounds.width * 0.15) || movement.x > 24 && speed.x > 500 else { return }
        bridge?.triggerWindowJSEvent(eventName: "tarocub-native-back")
    }
}
