import Foundation
import CryptoKit

private final class Memory: DeviceIdentityStore {
    var current: [String: String] = [:], old: [String: String] = [:]
    var writeFails = false, corruptWrite = false, deleteFails = false, failAfterWrite = false
    var writes = 0
    func read(_ key: String, legacy: Bool) throws -> String? { legacy ? old[key] : current[key] }
    func write(_ key: String, value: String) throws { if writeFails { throw DeviceIdentityError("fixture_write_failure") }; current[key] = corruptWrite ? "invalid" : value; writes += 1; if failAfterWrite { throw DeviceIdentityError("fixture_commit_failure_after_write") } }
    func remove(_ key: String, legacy: Bool) throws {
        if deleteFails { throw DeviceIdentityError("fixture_delete_failure") }
        if legacy { old.removeValue(forKey: key) } else { current.removeValue(forKey: key) }
    }
}
@main struct DeviceIdentityChecks {
    static var checks = 0
    static func check(_ value: Bool, _ message: String) { checks += 1; precondition(value, message) }
    static func rejects(_ operation: () throws -> Void) { var rejected = false; do { try operation() } catch { rejected = true }; check(rejected, "accepted invalid operation") }
    static func verify(_ publicKey: String, _ signature: String, _ message: String) throws {
        let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: Data(base64Encoded: publicKey)!.suffix(32))
        check(publicKey.isValidSignature(Data(base64Encoded: signature)!, for: Data(message.utf8)), "signature failed verification")
    }
    static func main() throws {
        let vector = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
        let statement = vector["statement"] as! [String: Any]
        let id = statement["deviceId"] as! String, publicKey = vector["publicKey"] as! String
        let seed = Data(repeating: 7, count: 32).base64EncodedString(), quoted = "\"" + Data(repeating: 7, count: 32).base64EncodedString() + "\""
        let memory = Memory(), n = String(repeating: "n", count: 43), c = String(repeating: "c", count: 43)
        let identity = DeviceIdentity(store: memory); memory.old[id] = quoted
        check(try DeviceIdentity.actionProof(statement) == vector["proofText"] as! String, "proof mismatch")
        // CryptoKit may randomize Ed25519 signatures; verify the exact proof/key
        // instead of requiring byte identity with the deterministic Node vector.
        let actual = try identity.signAction(keyRef: id, statement: statement); try verify(publicKey, actual, DeviceIdentity.actionProof(statement))
        check(memory.old[id] == nil && memory.current[id] == seed, "migration did not preserve seed")
        try verify(publicKey, DeviceIdentity(store: memory).signAction(keyRef: id, statement: statement), DeviceIdentity.actionProof(statement))
        let networkURL = URL(fileURLWithPath: CommandLine.arguments[1]).deletingLastPathComponent().appendingPathComponent("device-network-action-vector.json")
        let network = try JSONSerialization.jsonObject(with: Data(contentsOf: networkURL)) as! [String: Any]
        let networkStatement = network["statement"] as! [String: Any]
        let networkProof = try DeviceIdentity.actionProof(networkStatement)
        check(networkProof == network["proofText"] as! String, "network action proof mismatch")
        let networkSignature = try identity.signAction(keyRef: id, statement: networkStatement)
        try verify(publicKey, networkSignature, networkProof)
        for target in ["", String(repeating: "a", count: 63), String(repeating: "a", count: 65), String(repeating: "A", count: 64), String(repeating: "g", count: 64), "device_target", String(repeating: "a", count: 64) + "\n"] {
            var invalid = networkStatement; invalid["action"] = ["operation": "network", "target": target]
            rejects { _ = try identity.signAction(keyRef: id, statement: invalid) }
        }
        let grantURL = URL(fileURLWithPath: CommandLine.arguments[1]).deletingLastPathComponent().appendingPathComponent("device-message-grant-vector.json")
        let grant = try JSONSerialization.jsonObject(with: Data(contentsOf: grantURL)) as! [String: Any]
        let grantStatement = grant["statement"] as! [String: Any]
        let grantProof = try DeviceIdentity.actionProof(grantStatement)
        check(grantProof == grant["proofText"] as! String, "message grant proof mismatch")
        try verify(publicKey, identity.signAction(keyRef: id, statement: grantStatement), grantProof)
        var badGrant = grantStatement; badGrant["action"] = ["operation": "bot-message-grant", "target": "../bot"]
        rejects { _ = try identity.signAction(keyRef: id, statement: badGrant) }
        let authProof = "tarocub/device/v1\0\(id)\0\(n)\0\(c)", authSignature = try identity.sign(keyRef: id, deviceId: id, nonce: n, clientNonce: c)
        try verify(publicKey, authSignature, authProof)
        if CommandLine.arguments.count > 2 {
            let nonces = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))) as! [String]
            for client in nonces {
                try verify(publicKey, identity.sign(keyRef: id, deviceId: id, nonce: n, clientNonce: client), "tarocub/device/v1\0\(id)\0\(n)\0\(client)")
            }
        }
        rejects { _ = try identity.sign(keyRef: id, deviceId: "device_other", nonce: n, clientNonce: c) }
        rejects { _ = try identity.sign(keyRef: id, deviceId: id, nonce: "x\0" + n, clientNonce: c) }
        rejects { _ = try identity.signAction(keyRef: "device_other", statement: statement) }
        rejects { try identity.forget("../arbitrary") }
        for field in ["deviceId", "hubPublicKey", "sessionHash", "targetDigest", "nonce"] {
            var bad = statement; bad[field] = "bad\0value"; rejects { _ = try identity.signAction(keyRef: id, statement: bad) }
        }
        for value: Any in [true, -1, 0, 1.5, 9007199254740992.0, "123"] {
            var bad = statement; bad["expiresAt"] = value; rejects { _ = try identity.signAction(keyRef: id, statement: bad) }
        }
        var bad = statement; bad["extra"] = true; rejects { _ = try identity.signAction(keyRef: id, statement: bad) }
        bad = statement; var action = bad["action"] as! [String: Any]; action["target"] = "../device"; bad["action"] = action
        rejects { _ = try identity.signAction(keyRef: id, statement: bad) }
        try identity.forget(id); rejects { _ = try identity.signAction(keyRef: id, statement: statement) }
        check(memory.current.isEmpty && memory.old.isEmpty, "forget left identity data")
        for fault in ["write", "write-after", "readback", "delete"] {
            let m = Memory(); m.old[id] = quoted; let d = DeviceIdentity(store: m)
            m.failAfterWrite = fault == "write-after"; m.writeFails = fault == "write"; m.corruptWrite = fault == "readback"; m.deleteFails = fault == "delete"
            rejects { _ = try d.signAction(keyRef: id, statement: statement) }; check(m.old[id] != nil, "failure removed old identity")
            if fault == "delete" || fault == "write-after" { m.deleteFails = false; m.failAfterWrite = false; try verify(publicKey, DeviceIdentity(store: m).signAction(keyRef: id, statement: statement), DeviceIdentity.actionProof(statement)); check(m.writes == 2, "retry skipped durable write") }
        }
        memory.old[id] = quoted; memory.current[id] = Data(repeating: 0, count: 32).base64EncodedString()
        rejects { _ = try identity.signAction(keyRef: id, statement: statement) }; check(memory.old[id] != nil, "conflict deleted old identity"); try identity.forget(id)
        for invalid in ["null", "123", "\"AA==\"", quoted + "garbage"] {
            memory.old[id] = invalid; rejects { _ = try identity.signAction(keyRef: id, statement: statement) }; try identity.forget(id)
        }
        check(try !identity.getLock(), "new lock must be off"); memory.old["app-lock"] = "true"
        check(try identity.getLock() && memory.old["app-lock"] == nil, "lock migration lost setting")
        try identity.setLock(false); check(try !DeviceIdentity(store: memory).getLock(), "lock reset did not persist")
        memory.current.removeAll(); memory.old["app-lock"] = "1"; rejects { _ = try identity.getLock() }; memory.old.removeAll()
        let created = try identity.create(), createdId = created["deviceId"]!
        check(created.count == 3 && createdId == created["keyRef"], "created identity leaks extra fields")
        try verify(created["publicKey"]!, identity.sign(keyRef: createdId, deviceId: createdId, nonce: n, clientNonce: c), "tarocub/device/v1\0\(createdId)\0\(n)\0\(c)")
        try identity.forget(createdId)
        // A restored Keychain is not a restored installation. Exercise the real
        // envelope boundary with a synthetic vault, never the operator's keys.
        let vault = Memory(); var installation = Data(repeating: 1, count: 32).base64EncodedString()
        let bound = DeviceIdentity(store: InstallationDeviceStore(backing: vault, installation: { installation }))
        let enrollment = try bound.create(), enrollmentId = enrollment["deviceId"]!
        let signed = try bound.sign(keyRef: enrollmentId, deviceId: enrollmentId, nonce: n, clientNonce: c)
        try verify(enrollment["publicKey"]!, signed, "tarocub/device/v1\0\(enrollmentId)\0\(n)\0\(c)")
        let restarted = DeviceIdentity(store: InstallationDeviceStore(backing: vault, installation: { installation }))
        try verify(enrollment["publicKey"]!, restarted.sign(keyRef: enrollmentId, deviceId: enrollmentId, nonce: n, clientNonce: c), "tarocub/device/v1\0\(enrollmentId)\0\(n)\0\(c)")
        let originalEnvelope = vault.current[enrollmentId]!
        vault.current[enrollmentId] = originalEnvelope.replacingOccurrences(of: "\"version\":2", with: "\"version\":3")
        rejects { _ = try restarted.sign(keyRef: enrollmentId, deviceId: enrollmentId, nonce: n, clientNonce: c) }
        vault.current[enrollmentId] = originalEnvelope
        vault.current["device_substituted"] = originalEnvelope
        rejects { _ = try restarted.sign(keyRef: "device_substituted", deviceId: "device_substituted", nonce: n, clientNonce: c) }
        vault.current.removeValue(forKey: "device_substituted")
        installation = Data(repeating: 2, count: 32).base64EncodedString()
        rejects { _ = try restarted.sign(keyRef: enrollmentId, deviceId: enrollmentId, nonce: n, clientNonce: c) }
        var reinstallAction = statement; reinstallAction["deviceId"] = enrollmentId
        rejects { _ = try restarted.signAction(keyRef: enrollmentId, statement: reinstallAction) }
        vault.current[id] = seed; rejects { _ = try bound.sign(keyRef: id, deviceId: id, nonce: n, clientNonce: c) }
        vault.current.removeValue(forKey: id); vault.old[id] = quoted
        rejects { _ = try bound.sign(keyRef: id, deviceId: id, nonce: n, clientNonce: c) }
        try bound.forget(id); try bound.forget(enrollmentId)
        check(vault.current.isEmpty && vault.old.isEmpty, "cannot forget retired installation keys")
        let replacement = try bound.create(), replacementId = replacement["deviceId"]!
        check(replacementId != enrollmentId, "reinstall reused identity")
        try verify(replacement["publicKey"]!, bound.sign(keyRef: replacementId, deviceId: replacementId, nonce: n, clientNonce: c), "tarocub/device/v1\0\(replacementId)\0\(n)\0\(c)")
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("tarobot-installation-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let marker = folder.appendingPathComponent("marker")
        let first = try DeviceInstallation.identifier(at: marker)
        check(try DeviceInstallation.identifier(at: marker) == first, "marker not stable")
        check(try marker.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true, "marker included in backup")
        try FileManager.default.removeItem(at: folder)
        check(try DeviceInstallation.identifier(at: marker) != first, "fresh installation kept marker")
        try Data("corrupt".utf8).write(to: marker)
        rejects { _ = try DeviceInstallation.identifier(at: marker) }
        let receipt: [String: Any] = ["platform": "iOS CryptoKit core on macOS", "checks": checks, "status": "passed", "proofs": [["publicKey": publicKey, "signature": actual, "message": try DeviceIdentity.actionProof(statement)], ["publicKey": publicKey, "signature": authSignature, "message": authProof], ["publicKey": publicKey, "signature": networkSignature, "message": networkProof]]]
        print(String(data: try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]), encoding: .utf8)!)
    }
}
