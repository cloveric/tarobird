// Signed with the legacy App's requirement, creates only a disposable credential
// using the same Keychain API as keyring. Never reads production credentials.
import Foundation
import Security
import CryptoKit

func require(_ status: OSStatus, _ operation: String) throws {
    if status != errSecSuccess { throw NSError(domain: operation, code: Int(status)) }
}
func random(_ size: Int) throws -> Data {
    var value = Data(count: size)
    try value.withUnsafeMutableBytes { try require(SecRandomCopyBytes(kSecRandomDefault, size, $0.baseAddress!), "random") }
    return value
}

do {
    let args = CommandLine.arguments
    guard args.count == 5, ["create", "delete", "delete-legacy"].contains(args[1]) else { throw NSError(domain: "arguments", code: 1) }
    let service = args[2], account = args[3], path = args[4]
    let legacyService = service.hasPrefix("com.tarobot.migration.credential-test.") && UUID(uuidString: String(service.dropFirst("com.tarobot.migration.credential-test.".count))) != nil
    let devService = service.hasPrefix("com.tarobot.client.device.dev-") && service.count == "com.tarobot.client.device.dev-".count + 20 && service.suffix(20).allSatisfy({ $0.isHexDigit })
    guard legacyService || devService,
          account.hasPrefix("device_"), account.count == 39,
          account.dropFirst(7).allSatisfy({ $0.isHexDigit }) else { throw NSError(domain: "test_namespace", code: 1) }
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service, kSecAttrAccount as String: account]
    if args[1] == "delete-legacy" {
        var item: SecKeychainItem?
        let found = SecKeychainFindGenericPassword(nil, UInt32(service.utf8.count), service, UInt32(account.utf8.count), account, nil, nil, &item)
        if found != errSecItemNotFound {
            try require(found, "find_test_item")
            try require(SecKeychainItemDelete(item!), "delete_legacy")
        }
        print("{\"deleted\":true}")
    } else if args[1] == "delete" {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw NSError(domain: "delete", code: Int(status)) }
        print("{\"deleted\":true}")
    } else {
        let input = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: String]
        let state = URL(fileURLWithPath: input["state"]!, isDirectory: true)
        guard state.resolvingSymlinksInPath().pathComponents.contains(where: { $0.hasSuffix(".noindex") }) else { throw NSError(domain: "isolated_state", code: 1) }
        let markerPath = state.appendingPathComponent("tarobot-client-installation-v1")
        let existing = FileManager.default.fileExists(atPath: markerPath.path)
        let marker = try existing ? Data(contentsOf: markerPath) : random(32)
        guard marker.count == 32 else { throw NSError(domain: "isolated_marker", code: 1) }
        let key = Curve25519.Signing.PrivateKey()
        let sealed = try AES.GCM.seal(key.rawRepresentation, using: SymmetricKey(data: marker), authenticating: Data("tarobot/device-installation/v2".utf8))
        var saved = Data([84, 66, 75, 69, 89, 50, 0, 0]); saved.append(sealed.combined!)
        guard saved.count == 68 else { throw NSError(domain: "bound_format", code: 1) }
        try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if !existing {
            try marker.write(to: markerPath, options: .withoutOverwriting)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: markerPath.path)
        }
        // Do not invent a custom ACL: keyring uses this exact legacy API,
        // which records the creator's designated requirement and partition.
        var keychain: SecKeychain?
        try require(SecKeychainCopyDomainDefault(.user, &keychain), "user_keychain")
        try saved.withUnsafeBytes { bytes in
            try require(SecKeychainAddGenericPassword(keychain, UInt32(service.utf8.count), service,
                UInt32(account.utf8.count), account, UInt32(saved.count), bytes.baseAddress!, nil), "create_disposable_credential")
        }
        let prefix = Data([0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00])
        let result: [String: Any] = ["deviceId": account, "publicKey": (prefix + key.publicKey.rawRepresentation).base64EncodedString(), "storedBytes": saved.count]
        print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
    }
} catch {
    // No credential bytes or input documents appear in diagnostics.
    let e = error as NSError
    fputs("credential_fixture_failed: \(e.domain):\(e.code)\n", stderr)
    exit(1)
}
