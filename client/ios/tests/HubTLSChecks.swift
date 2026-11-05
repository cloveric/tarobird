import Foundation
import Security
import CryptoKit

final class Fixture {
    let process = Process(), input = Pipe(), output = Pipe()
    let peers: [String: String]
    init(repo: String, scratch: String) throws {
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", "--import", "tsx", "tests/helpers/native-tls-fixture.ts", scratch]
        process.currentDirectoryURL = URL(fileURLWithPath: repo)
        process.standardInput = input; process.standardOutput = output
        try process.run()
        peers = try JSONSerialization.jsonObject(with: Self.line(output.fileHandleForReading)) as! [String: String]
    }
    static func line(_ file: FileHandle) throws -> Data {
        var line = Data()
        while let byte = try file.read(upToCount: 1), !byte.isEmpty {
            if byte == Data([10]) { return line }; line.append(byte)
        }
        throw HubNetworkError("fixture_eof")
    }
    func command(_ value: String) throws -> String {
        try input.fileHandleForWriting.write(contentsOf: Data((value + "\n").utf8))
        return String(data: try Self.line(output.fileHandleForReading), encoding: .utf8)!
    }
    func stop() { if process.isRunning { process.terminate(); process.waitUntilExit() } }
}

private final class Collect: HubTaskHandler {
    var bytes = Data(), failure: Error?
    var status = 0
    let finish: (Result<Data, Error>) -> Void
    init(_ finish: @escaping (Result<Data, Error>) -> Void) { self.finish = finish }
    override func response(_ response: HTTPURLResponse, completion: @escaping (URLSession.ResponseDisposition) -> Void) {
        status = response.statusCode
        guard (200..<300).contains(status), response.expectedContentLength <= 16 * 1024 * 1024 else {
            failure = HubNetworkError("http_rejected_\(status)"); completion(.cancel); return
        }
        completion(.allow)
    }
    override func data(_ data: Data) { bytes.append(data) }
    override func completed(_ error: Error?) { if let error = failure ?? error { finish(.failure(error)) } else { finish(.success(bytes)) } }
}

private final class SocketProbe: HubTaskHandler, @unchecked Sendable {
    var opened: ((Result<Void, Error>) -> Void)?
    var closed: ((Result<Int, Error>) -> Void)?
    var events: [String] = []
    override func socketOpened() { events.append("open"); let callback = opened; opened = nil; callback?(.success(())) }
    override func socketClosed(_ code: Int, reason: Data?) { events.append("peer-close:\(code)"); let callback = closed; closed = nil; callback?(.success(code)) }
    override func completed(_ error: Error?) {
        events.append("complete:\(error == nil ? "ok" : "error")")
        if let error = error { let callback = opened; opened = nil; callback?(.failure(error)) }
    }
}

@main struct HubTLSChecks {
    static let queue = DispatchQueue(label: "tarocub.ios-tls-audit")
    static var results: [String: Any] = ["surface": "macOS Foundation/Security running iOS core source; not an iOS device"]
    static func check(_ value: Bool, _ name: String) throws {
        guard value else { throw HubNetworkError(name) }; results[name] = true; print(name)
    }
    static func rejects(_ name: String, _ work: () async throws -> Void) async throws {
        var rejected = false; do { try await work() } catch { rejected = true }
        try check(rejected, name)
    }
    static func prepare(_ origin: String, _ key: String, _ ca: SecCertificate?) async throws -> HubTLSSession {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do { _ = try HubTLSSession.prepare(origin: origin, publicKey: key, queue: queue, anchors: ca.map { [$0] }) { continuation.resume(with: $0) } }
                catch { continuation.resume(throwing: error) }
            }
        }
    }
    static func http(_ session: HubTLSSession, _ path: String, body: Data? = nil, authorization: String? = nil) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    var request = URLRequest(url: try HubTLS.target(session.base, path))
                    if let body = body {
                        request.httpMethod = "POST"; request.httpBodyStream = InputStream(data: body)
                        request.setValue(String(body.count), forHTTPHeaderField: "Content-Length")
                        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    }
                    if let authorization = authorization { request.setValue("Bearer " + authorization, forHTTPHeaderField: "Authorization") }
                    let task = try session.http(request, handler: Collect { continuation.resume(with: $0) })
                    task.resume()
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
    private static func socket(_ session: HubTLSSession, probe: SocketProbe) async throws -> URLSessionWebSocketTask {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    let task = try session.socket(handler: probe)
                    probe.opened = { result in continuation.resume(with: result.map { task }) }
                    queue.asyncAfter(deadline: .now() + 8) { if let callback = probe.opened { probe.opened = nil; task.cancel(); callback(.failure(HubNetworkError("socket_timeout"))) } }
                    task.resume()
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
    static func send(_ socket: URLSessionWebSocketTask, _ object: [String: Any]) async throws {
        let bytes = try JSONSerialization.data(withJSONObject: object)
        try await socket.send(.string(String(data: bytes, encoding: .utf8)!))
    }
    static func message(_ socket: URLSessionWebSocketTask) async throws -> [String: Any] {
        guard case .string(let text) = try await socket.receive(), let bytes = text.data(using: .utf8),
              let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw HubNetworkError("invalid_socket_message") }
        return value
    }
    static func main() async {
        setbuf(stdout, nil)
        let repo = CommandLine.arguments[1], scratch = CommandLine.arguments[2], receipt = CommandLine.arguments[3]
        var fixture: Fixture?, sessions: [HubTLSSession] = []
        do {
            let peer = try Fixture(repo: repo, scratch: scratch); fixture = peer
            let hub = peer.peers["hub"]!, proxy = peer.peers["proxy"]!, rotating = peer.peers["rotating"]!, key = peer.peers["key"]!
            let ca = SecCertificateCreateWithData(nil, try Data(contentsOf: URL(fileURLWithPath: scratch + "/ca.der")) as CFData)!
            try await rejects("systemTrustRejectsPrivateCa") { _ = try await prepare(hub, key, nil) }
            try await rejects("hostnameMismatchRejected") { _ = try await prepare(hub.replacingOccurrences(of: "127.0.0.1", with: "localhost"), key, ca) }
            try await rejects("activeProxyRejectedBeforeCredentials") { _ = try await prepare(proxy, key, ca) }
            try await rejects("cleartextLoopbackRejected") { _ = try HubTLS.origin("http://127.0.0.1:1") }
            let real = try await prepare(hub, key, ca); sessions.append(real)
            let health = try JSONSerialization.jsonObject(with: await http(real, "/health")) as! [String: Any]
            try check(health["publicKey"] as? String == key, "realHubProofAndHttp")
            let privateKey = Curve25519.Signing.PrivateKey()
            let deviceKey = (HubTLS.spkiPrefix + privateKey.publicKey.rawRepresentation).base64EncodedString()
            let pairBody: [String: Any] = ["deviceId": "ios-core-test", "name": "Isolated Foundation", "platform": "ios", "publicKey": deviceKey]
            let paired = try JSONSerialization.jsonObject(with: await http(real, "/api/pair", body: JSONSerialization.data(withJSONObject: pairBody))) as! [String: Any]
            try check(try peer.command("approve:" + (paired["code"] as! String)) == "ok", "realOwnerPairing")
            let probe = SocketProbe(), ws = try await socket(real, probe: probe), nonce = String(repeating: "a", count: 43)
            try await send(ws, ["v": 1, "type": "hello", "deviceId": "ios-core-test", "nonce": nonce, "protocolVersions": [1], "capabilities": [], "cursors": [:]])
            let challenge = try await message(ws)
            let signed = Data("tarocub/device/v1\0ios-core-test\0\(challenge["nonce"] as! String)\0\(nonce)".utf8)
            try await send(ws, ["v": 1, "type": "auth", "signature": privateKey.signature(for: signed).base64EncodedString()])
            let ready = try await message(ws)
            try check(ready["type"] as? String == "ready", "nativeSocketAuthentication")
            let chats = try await http(real, "/api/conversations", authorization: ready["sessionToken"] as? String)
            try check(String(data: chats, encoding: .utf8) == "[]", "authenticatedHttp")
            let closed: Int = try await withCheckedThrowingContinuation { continuation in
                queue.async {
                    probe.closed = { continuation.resume(with: $0) }
                    queue.asyncAfter(deadline: .now() + 8) { if let callback = probe.closed { probe.closed = nil; callback(.failure(HubNetworkError("close_timeout"))) } }
                    ws.cancel(with: .normalClosure, reason: nil)
                }
            }
            try check(closed == 1000, "nativeLocalCloseCallback")
            results["socketEvents"] = queue.sync { probe.events }
            let rotatingSession = try await prepare(rotating, key, ca); sessions.append(rotatingSession)
            let upload = Data(repeating: 0x61, count: 8 * 1024 * 1024)
            let echoed = try await http(rotatingSession, "/api/echo", body: upload)
            try check(echoed.count == upload.count && SHA256.hash(data: echoed) == SHA256.hash(data: upload), "upload8MiB")
            try await rejects("redirectRejected") { _ = try await http(rotatingSession, "/api/redirect") }
            let bigProbe = SocketProbe(), big = try await socket(rotatingSession, probe: bigProbe)
            try await big.send(.string("$audit:oversize"))
            try await rejects("nativeMessageBufferLimit") { _ = try await big.receive() }
            big.cancel()
            try check(try peer.command("rotate") == "ok", "certificateRotated")
            try await rejects("staleHttpPinRejected") { _ = try await http(rotatingSession, "/health") }
            try await rejects("staleSocketPinRejected") { _ = try await socket(rotatingSession, probe: SocketProbe()) }
            let fresh = try await prepare(rotating, key, ca); sessions.append(fresh)
            _ = try await http(fresh, "/health"); try check(true, "freshSignedCertificateRecovers")
            try await managerChecks(peer, ca, token: ready["sessionToken"] as! String)
            let stats = try JSONSerialization.jsonObject(with: Data(peer.command("stats").utf8)) as! [String: Any]
            try check(stats["sensitive"] as? Int == 0, "zeroProxySensitiveRequests")
            results["proxy"] = stats; results["ok"] = true
        } catch { results["ok"] = false; results["error"] = String(describing: error); print("FAILED", error) }
        queue.sync { sessions.forEach { $0.cancelAll() } }
        fixture?.stop()
        try? JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: receipt))
        exit(results["ok"] as? Bool == true ? 0 : 1)
    }
}
