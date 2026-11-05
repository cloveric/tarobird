// Type-check aid only: the real Capacitor Objective-C headers are imported,
// while three Swift convenience methods normally supplied by Capacitor's iOS
// module are declared here. This is never linked or included in the app target.
// It is not an iOS SDK build or a Capacitor runtime acceptance test.
import Capacitor
extension CAPPluginCall {
    func getString(_ key: String) -> String? { options[key] as? String }
    func resolve(_ value: [String: Any] = [:]) { fatalError("typecheck only") }
    func reject(_ value: String) { fatalError("typecheck only") }
}
