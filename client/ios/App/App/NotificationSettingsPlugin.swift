import Capacitor
import UIKit

/// Opens only Apple's fixed Settings destinations; no caller-supplied URL.
@objc(NotificationSettingsPlugin)
public final class NotificationSettingsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NotificationSettingsPlugin"
    public let jsName = "TaroBotNotificationSettings"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise)]

    @objc func open(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            // iOS 16 links straight to TaroBot's notification page; iOS 15
            // falls back to TaroBot's own page in Settings.
            let destination: String
            if #available(iOS 16.0, *) { destination = UIApplication.openNotificationSettingsURLString }
            else { destination = UIApplication.openSettingsURLString }
            guard let url = URL(string: destination) else { call.reject("notification_settings_unavailable"); return }
            UIApplication.shared.open(url) { opened in
                if opened { call.resolve() } else { call.reject("notification_settings_unavailable") }
            }
        }
    }
}
