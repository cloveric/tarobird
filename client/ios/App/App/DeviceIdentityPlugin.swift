import Capacitor
import Foundation
import CoreFoundation

@objc(DeviceIdentityPlugin)
public final class DeviceIdentityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DeviceIdentityPlugin"
    public let jsName = "TaroCubDeviceIdentity"
    public let pluginMethods: [CAPPluginMethod] = ["create", "sign", "signAction", "forget", "getLock", "setLock"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private let identity = DeviceIdentity(store: DeviceKeyStore())
    private let queue = DispatchQueue(label: "com.tarobot.device-identity")
    private func perform(_ call: CAPPluginCall, action: @escaping (DeviceIdentity) throws -> [String: Any]) {
        queue.async {
            do { call.resolve(try action(self.identity)) }
            catch let error as DeviceIdentityError { call.reject(error.code) }
            catch { call.reject("device_storage_failed") }
        }
    }
    @objc func create(_ call: CAPPluginCall) { perform(call) { try $0.create() } }
    @objc func sign(_ call: CAPPluginCall) {
        guard let ref = call.getString("keyRef"), let device = call.getString("deviceId"), let nonce = call.getString("nonce"), let clientNonce = call.getString("clientNonce") else { call.reject("invalid_device_challenge"); return }
        perform(call) { ["signature": try $0.sign(keyRef: ref, deviceId: device, nonce: nonce, clientNonce: clientNonce)] }
    }
    @objc func signAction(_ call: CAPPluginCall) {
        guard let ref = call.getString("keyRef"), let statement = call.options["statement"] as? [String: Any] else { call.reject("invalid_device_action"); return }
        perform(call) { ["signature": try $0.signAction(keyRef: ref, statement: statement)] }
    }
    @objc func forget(_ call: CAPPluginCall) {
        guard let ref = call.getString("keyRef") else { call.reject("invalid_device_id"); return }
        perform(call) { try $0.forget(ref); return [:] }
    }
    @objc func getLock(_ call: CAPPluginCall) { perform(call) { ["enabled": try $0.getLock()] } }
    @objc func setLock(_ call: CAPPluginCall) {
        guard let value = call.options["enabled"] as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { call.reject("invalid_app_lock_state"); return }
        perform(call) { try $0.setLock(value.boolValue); return [:] }
    }
}
