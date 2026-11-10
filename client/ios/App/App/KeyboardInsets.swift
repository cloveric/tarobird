import Foundation
import CoreGraphics

/// All rectangles are in the WebView's own coordinates. The keyboard guide's
/// resting frame includes the home indicator; it is not keyboard occlusion.
enum KeyboardInsetGeometry {
    static func isBackEdge(_ x: CGFloat, safeLeft: CGFloat) -> Bool {
        x.isFinite && safeLeft.isFinite && x >= safeLeft && x <= safeLeft + 24
    }

    static func overlap(bounds: CGRect, guide: CGRect, restingBottom: CGFloat) -> CGFloat {
        guard !bounds.isEmpty, !guide.isNull, !guide.isInfinite,
              restingBottom.isFinite, guide.minY < restingBottom - 0.5 else { return 0 }
        let covered = bounds.intersection(guide)
        guard !covered.isNull, !covered.isEmpty,
              covered.maxY >= bounds.maxY - 0.5,
              covered.minX <= bounds.minX + 0.5,
              covered.maxX >= bounds.maxX - 0.5 else { return 0 }
        return min(bounds.height, max(0, bounds.maxY - covered.minY))
    }
}

/// Only the first changed guide frame borrows the keyboard animation. Later
/// layout corrections and display/scene resizes must not restart it.
struct KeyboardInsetMotion {
    private var start: Double?
    private var duration: Double = 0

    mutating func begin(at: Double, duration: Double) {
        start = at.isFinite ? at : nil
        self.duration = duration.isFinite ? min(1_000, max(0, duration)) : 0
    }

    mutating func consume(at now: Double, animate: Bool) -> (at: Double, duration: Double) {
        defer { start = nil; duration = 0 }
        guard animate, let start, now >= start, now - start < duration else { return (now, 0) }
        return (start, duration)
    }
}

#if canImport(UIKit)
import UIKit
import WebKit

private final class KeyboardInsetProbe: UIView {
    var changed: (() -> Void)?
    override func layoutSubviews() {
        super.layoutSubviews()
        changed?()
    }
}

/// App-owned keyboard geometry, independent of the Capacitor plugin's
/// single-screen/iPad heuristics. It leaves the native WebView edge-to-edge;
/// the existing CSS shell owns keyboard avoidance and motion.
final class TaroBotKeyboardInsets: NSObject, WKScriptMessageHandler {
    private weak var view: UIView?
    private weak var webView: WKWebView?
    private var observer: NSObjectProtocol?
    private var lastHeight: CGFloat?
    private var lastBounds: CGRect?
    private var motion = KeyboardInsetMotion()
    private var ready = false
    private var layoutPending = false
    private static let readyMessage = "tarobotKeyboardReady"

    init(view: UIView, webView: WKWebView) {
        self.view = view
        self.webView = webView
        super.init()

        let controller = webView.configuration.userContentController
        controller.add(self, name: Self.readyMessage)
        controller.addUserScript(WKUserScript(source: """
            Object.defineProperty(window,'tarobotKeyboardInsets',{value:Object.freeze({supported:()=>true}),configurable:false,writable:false});
            window.webkit.messageHandlers.tarobotKeyboardReady.postMessage(null);
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        // Track every keyboard in this scene; overlap() reserves a band only
        // for full-width bottom occlusion. Floating/split keyboards still
        // return zero, while a full-width keyboard is not lost solely because
        // UIKit classified its current presentation as undocked.
        let guide = view.keyboardLayoutGuide
        guide.followsUndockedKeyboard = true
        let probe = KeyboardInsetProbe()
        probe.translatesAutoresizingMaskIntoConstraints = false
        probe.isUserInteractionEnabled = false
        probe.accessibilityElementsHidden = true
        probe.alpha = 0
        probe.changed = { [weak self] in self?.layoutChanged() }
        view.addSubview(probe)
        NSLayoutConstraint.activate([
            probe.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            probe.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            probe.topAnchor.constraint(equalTo: guide.topAnchor),
            probe.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        observer = NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { [weak self] notification in
            // Timing only: never read the notification's screen-sized frame.
            let duration = (notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0
            self?.motion.begin(at: Date().timeIntervalSince1970 * 1_000, duration: duration * 1_000)
        }
    }

    deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }

    func layoutChanged() {
        guard !layoutPending else { return }
        layoutPending = true
        // UIKit can lay out the guide immediately before delivering the
        // keyboard notification. Coalesce this run-loop turn so its duration
        // is available for the first frame instead of publishing a jump.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.layoutPending = false
            self.publish(force: false)
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.readyMessage, message.frameInfo.isMainFrame, message.webView === webView else { return }
        ready = true
        // Navigation creates a fresh JS world. A still-open keyboard needs a
        // fresh snapshot even though its native geometry has not changed.
        publish(force: true)
    }

    private func publish(force: Bool) {
        guard ready, let view, let webView, webView.window != nil else { return }
        let bounds = webView.bounds
        let guide = webView.convert(view.keyboardLayoutGuide.layoutFrame, from: view)
        let restingBottom = webView.convert(view.safeAreaLayoutGuide.layoutFrame, from: view).maxY
        let height = KeyboardInsetGeometry.overlap(bounds: bounds, guide: guide, restingBottom: restingBottom)
        let resized = lastBounds != nil && lastBounds != bounds
        lastBounds = bounds
        guard force || lastHeight != height else { return }
        lastHeight = height
        let timing = motion.consume(at: Date().timeIntervalSince1970 * 1_000, animate: !force && !resized)
        let data = "{height:\(height),at:\(timing.at),duration:\(timing.duration)}"
        webView.evaluateJavaScript("window.__tarobotKeyboard=\(data);window.dispatchEvent(new CustomEvent('tarobot-keyboard',{detail:window.__tarobotKeyboard}));", completionHandler: nil)
    }
}
#endif
