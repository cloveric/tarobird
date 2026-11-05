import Foundation
import CryptoKit
import CoreFoundation

struct DeviceIdentityError: LocalizedError {
    let code: String
    init(_ code: String) { self.code = code }
    var errorDescription: String? { code }
}
protocol DeviceIdentityStore {
    func read(_ key: String, legacy: Bool) throws -> String?
    func write(_ key: String, value: String) throws
    func remove(_ key: String, legacy: Bool) throws
}
/** Native-only operations; neither seeds nor arbitrary signing inputs cross IPC. */
final class DeviceIdentity {
    private let store: DeviceIdentityStore
    init(store: DeviceIdentityStore) { self.store = store }
    private static func require(_ condition: Bool, _ code: String) throws {
        if !condition { throw DeviceIdentityError(code) }
    }
    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: "\\A(?:" + pattern + ")\\z", options: .regularExpression) != nil
    }
    static func key(_ value: String) throws {
        try require(matches(value, "device_[A-Za-z0-9_]{1,121}"), "invalid_device_id")
    }
    private func save(_ key: String, _ value: String) throws {
        try store.write(key, value: value)
        try Self.require(try store.read(key, legacy: false) == value, "device_key_write_failed")
    }
    private func erase(_ key: String, legacy: Bool) throws {
        try store.remove(key, legacy: legacy)
        try Self.require(try store.read(key, legacy: legacy) == nil, "device_key_delete_failed")
    }
    private static func seed(_ encoded: String?) throws -> Curve25519.Signing.PrivateKey {
        guard let encoded = encoded else { throw DeviceIdentityError("device_key_unavailable") }
        guard let data = Data(base64Encoded: encoded), data.count == 32, data.base64EncodedString() == encoded else { throw DeviceIdentityError("device_key_invalid") }
        return try Curve25519.Signing.PrivateKey(rawRepresentation: data)
    }
    private static func legacyValue(_ raw: String) throws -> Any {
        do { return try JSONSerialization.jsonObject(with: Data(raw.utf8), options: [.fragmentsAllowed]) }
        catch { throw DeviceIdentityError("device_storage_invalid") }
    }
    private func load(_ id: String) throws -> Curve25519.Signing.PrivateKey {
        try Self.key(id)
        var current = try store.read(id, legacy: false)
        if let previous = try store.read(id, legacy: true) {
            guard let decoded = try Self.legacyValue(previous) as? String else { throw DeviceIdentityError("device_key_invalid") }
            try Self.require(previous == "\"" + decoded + "\"", "device_storage_invalid")
            _ = try Self.seed(decoded)
            try Self.require(current == nil || current == decoded, "device_key_migration_conflict")
            try save(id, decoded); current = decoded
            try erase(id, legacy: true)
        }
        return try Self.seed(current)
    }
    func create() throws -> [String: String] {
        let id = "device_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let key = Curve25519.Signing.PrivateKey()
        try Self.require(try store.read(id, legacy: false) == nil && store.read(id, legacy: true) == nil, "device_key_exists")
        try save(id, key.rawRepresentation.base64EncodedString())
        var spki = Data([0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00])
        spki.append(key.publicKey.rawRepresentation)
        return ["deviceId": id, "keyRef": id, "publicKey": spki.base64EncodedString()]
    }
    func sign(keyRef: String, deviceId: String, nonce: String, clientNonce: String) throws -> String {
        try Self.key(keyRef)
        try Self.require(keyRef == deviceId, "device_key_unavailable")
        try Self.require(Self.matches(nonce, "[A-Za-z0-9_-]{32,128}") && Self.matches(clientNonce, "[A-Za-z0-9_-]{32,128}"), "invalid_device_challenge")
        return try load(keyRef).signature(for: Data("tarocub/device/v1\0\(deviceId)\0\(nonce)\0\(clientNonce)".utf8)).base64EncodedString()
    }
    func signAction(keyRef: String, statement: [String: Any]) throws -> String {
        let proof = try Self.actionProof(statement)
        try Self.key(keyRef)
        try Self.require(keyRef == statement["deviceId"] as? String, "device_key_unavailable")
        return try load(keyRef).signature(for: Data(proof.utf8)).base64EncodedString()
    }
    func forget(_ keyRef: String) throws { try Self.key(keyRef); try erase(keyRef, legacy: true); try erase(keyRef, legacy: false) }
    func getLock() throws -> Bool {
        var value = try store.read("app-lock", legacy: false)
        let old = try store.read("app-lock", legacy: true)
        if value == nil, let old = old {
            guard let bool = try Self.legacyValue(old) as? NSNumber, CFGetTypeID(bool) == CFBooleanGetTypeID() else { throw DeviceIdentityError("invalid_app_lock_state") }
            value = bool.boolValue ? "true" : "false"; try save("app-lock", value!)
        }
        try Self.require(value == nil || value == "true" || value == "false", "invalid_app_lock_state")
        if old != nil { try save("app-lock", value!); try erase("app-lock", legacy: true) }
        return value == "true"
    }
    func setLock(_ enabled: Bool) throws { try save("app-lock", enabled ? "true" : "false"); try erase("app-lock", legacy: true) }
    static func actionProof(_ s: [String: Any]) throws -> String {
        try require(Set(s.keys) == Set(["hubPublicKey", "deviceId", "sessionHash", "action", "targetDigest", "nonce", "expiresAt"]), "invalid_device_action")
        func field(_ object: [String: Any], _ name: String, _ pattern: String) throws -> String {
            guard let value = object[name] as? String, matches(value, pattern) else { throw DeviceIdentityError("invalid_device_action") }; return value
        }
        let publicKey = try field(s, "hubPublicKey", "[A-Za-z0-9+/]{59}=")
        guard let spki = Data(base64Encoded: publicKey), spki.count == 44,
              spki.prefix(12) == Data([0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0]) else { throw DeviceIdentityError("invalid_device_action") }
        let device = try field(s, "deviceId", "[A-Za-z0-9_-]{1,128}"), hash = try field(s, "sessionHash", "[a-f0-9]{64}")
        guard let action = s["action"] as? [String: Any], Set(action.keys) == Set(["operation", "target"]) else { throw DeviceIdentityError("invalid_device_action") }
        let operation = try field(action, "operation", "approve|revoke|network|bot-message-grant")
        let target = try field(action, "target", operation == "approve" ? "[0-9]{8}" : (operation == "network" || operation == "bot-message-grant") ? "[a-f0-9]{64}" : "[A-Za-z0-9_-]{1,128}")
        let digest = try field(s, "targetDigest", "[a-f0-9]{64}"), nonce = try field(s, "nonce", "[A-Za-z0-9_-]{43}")
        guard let expiry = s["expiresAt"] as? NSNumber, CFGetTypeID(expiry) != CFBooleanGetTypeID() else { throw DeviceIdentityError("invalid_device_action") }
        let n = expiry.doubleValue
        try require(n.isFinite && n.rounded(.towardZero) == n && n > 0 && n <= 9007199254740991, "invalid_device_action")
        // Validated ASCII fields cannot contain JSON quotes or control characters.
        return "[\"tarocub/device-action/v1\",\"\(publicKey)\",\"\(device)\",\"\(hash)\",\"\(operation)\",\"\(target)\",\"\(digest)\",\"\(nonce)\",\(expiry.int64Value)]"
    }
}
