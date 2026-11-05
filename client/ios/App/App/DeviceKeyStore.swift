import Foundation
import Security
import LocalAuthentication
import CryptoKit

/** App-only Keychain service, never shared with the share extension or iCloud. */
private final class SystemDeviceKeyStore: DeviceIdentityStore {
    private let service = "com.tarobot.native-identity.v1"
    private func query(_ key: String, legacy: Bool) -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrSynchronizable as String: false]
        query[kSecAttrAccount as String] = legacy ? "capacitor-storage_tarocub." + (key == "app-lock" ? key : "device." + key) : key
        if !legacy { query[kSecAttrService as String] = service }
        return query
    }
    func read(_ key: String, legacy: Bool) throws -> String? {
        var q = query(key, legacy: legacy); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        // Do not open an unexpected system prompt while reconnecting.
        let context = LAContext(); context.interactionNotAllowed = true
        q[kSecUseAuthenticationContext as String] = context
        var item: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data, let text = String(data: data, encoding: .utf8) else { throw DeviceIdentityError("device_storage_unavailable") }
        return text
    }
    func write(_ key: String, value: String) throws {
        let q = query(key, legacy: false)
        let attributes: [String: Any] = [kSecValueData as String: Data(value.utf8), kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(q as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(q.merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw DeviceIdentityError("device_key_write_failed") }
    }
    func remove(_ key: String, legacy: Bool) throws {
        let status = SecItemDelete(query(key, legacy: legacy) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw DeviceIdentityError("device_key_delete_failed") }
    }
}

/** This marker belongs to the installation, not Keychain or a restored backup.
 * Missing markers start a new installation; corrupt/unreadable markers fail
 * closed. Never adopt a surviving legacy device key on first launch. */
enum DeviceInstallation {
    private static let lock = NSLock()
    static func identifier(at file: URL) throws -> String {
        lock.lock(); defer { lock.unlock() }
        let fm = FileManager.default
        let value: String
        do {
            let data = try Data(contentsOf: file)
            guard data.count == 44, let text = String(data: data, encoding: .utf8), let key = Data(base64Encoded: text), key.count == 32, key.base64EncodedString() == text else {
                throw DeviceIdentityError("device_storage_invalid")
            }
            value = text
        } catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError {
            try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            value = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0).base64EncodedString() }
            try Data(value.utf8).write(to: file, options: [.atomic])
        }
        var url = file, resources = URLResourceValues()
        resources.isExcludedFromBackup = true
        try url.setResourceValues(resources)
        return value
    }
    static func current() throws -> String {
        let folder = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return try identifier(at: folder.appendingPathComponent("tarobot-client-installation-v1"))
    }
}

/** Testable boundary around the real vault. Public IDs alone must not revive
 * a Keychain key after complete deletion or a backup restore. */
final class InstallationDeviceStore: DeviceIdentityStore {
    private struct BoundValue: Codable { let version: Int; let sealed: String }
    private let backing: DeviceIdentityStore
    private let installation: () throws -> String
    init(backing: DeviceIdentityStore, installation: @escaping () throws -> String) {
        self.backing = backing; self.installation = installation
    }
    private func wrappingKey() throws -> SymmetricKey {
        guard let bytes = Data(base64Encoded: try installation()), bytes.count == 32 else { throw DeviceIdentityError("device_storage_invalid") }
        return SymmetricKey(data: bytes)
    }
    private func context(_ key: String) -> Data { Data(("tarobot/device-installation/v2\0" + key).utf8) }
    func read(_ key: String, legacy: Bool) throws -> String? {
        guard let value = try backing.read(key, legacy: legacy) else { return nil }
        guard key.hasPrefix("device_") else { return value }
        let wrapping = try wrappingKey()
        guard !legacy, let bound = try? JSONDecoder().decode(BoundValue.self, from: Data(value.utf8)), bound.version == 2,
              let encrypted = Data(base64Encoded: bound.sealed), let sealed = try? AES.GCM.SealedBox(combined: encrypted),
              let plain = try? AES.GCM.open(sealed, using: wrapping, authenticating: context(key)),
              let result = String(data: plain, encoding: .utf8) else {
            throw DeviceIdentityError("device_pairing_required")
        }
        return result
    }
    func write(_ key: String, value: String) throws {
        var stored = value
        if key.hasPrefix("device_") {
            let sealed = try AES.GCM.seal(Data(value.utf8), using: wrappingKey(), authenticating: context(key))
            guard let bytes = sealed.combined else { throw DeviceIdentityError("device_key_write_failed") }
            stored = String(decoding: try JSONEncoder().encode(BoundValue(version: 2, sealed: bytes.base64EncodedString())), as: UTF8.self)
        }
        try backing.write(key, value: stored)
    }
    func remove(_ key: String, legacy: Bool) throws { try backing.remove(key, legacy: legacy) }
}

final class DeviceKeyStore: DeviceIdentityStore {
    private let store = InstallationDeviceStore(backing: SystemDeviceKeyStore(), installation: DeviceInstallation.current)
    func read(_ key: String, legacy: Bool) throws -> String? { try store.read(key, legacy: legacy) }
    func write(_ key: String, value: String) throws { try store.write(key, value: value) }
    func remove(_ key: String, legacy: Bool) throws { try store.remove(key, legacy: legacy) }
}
