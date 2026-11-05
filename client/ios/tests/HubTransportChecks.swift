import Foundation
import Security
import CryptoKit

private final class EventLog: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [[String: Any]] = []
    func add(_ value: [String: Any]) { lock.lock(); defer { lock.unlock() }; events.append(value) }
    func get(_ id: String, kind: String) -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }; return events.filter { $0["id"] as? String == id && $0["kind"] as? String == kind }
    }
    func wait(_ id: String, kind: String, count: Int = 1) async throws -> [[String: Any]] {
        let until = ProcessInfo.processInfo.systemUptime + 8
        while ProcessInfo.processInfo.systemUptime < until {
            let found = get(id, kind: kind); if found.count >= count { return found }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        throw HubNetworkError("event_timeout_\(kind)_\(count)")
    }
}

extension HubTLSChecks {
    static func call(_ manager: HubTransport, _ method: String, _ args: [String: Any] = [:]) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { continuation in manager.invoke(method, args) { continuation.resume(with: $0) } }
    }
    static func allocate(_ manager: HubTransport, _ document: String, _ kind: String = "http") async throws -> String {
        try await call(manager, "allocate", ["kind": kind, "document": document])["value"] as! String
    }
    static func managerChecks(_ peer: Fixture, _ ca: SecCertificate, token: String) async throws {
        let events = EventLog(), manager = HubTransport(anchors: [ca], events: { events.add($0) })
        defer { manager.reset(destroy: true); manager.queue.sync {} }
        let origin = peer.peers["rotating"]!, key = peer.peers["key"]!
        var document = try await call(manager, "document")["value"] as! String
        func input(_ path: String, _ body: String? = nil, base: String? = nil, headers: [[String]] = []) -> [String: Any] {
            ["origin": base ?? origin, "hubKey": key, "path": path, "method": body == nil ? "GET" : "POST", "body": body as Any? ?? NSNull(), "headers": headers]
        }
        func open(_ path: String, _ body: String? = nil, base: String? = nil, headers: [[String]] = []) async throws -> String {
            let id = try await allocate(manager, document)
            _ = try await call(manager, "httpOpen", ["id": id, "input": input(path, body, base: base, headers: headers)]); return id
        }
        func read(_ id: String) async throws -> Data {
            try HubTLS.decode(await call(manager, "httpRead", ["id": id])["data"] as! String)
        }
        func socket() async throws -> String {
            let id = try await allocate(manager, document, "socket")
            _ = try await call(manager, "socketOpen", ["id": id, "origin": origin, "hubKey": key])
            _ = try await events.wait(id, kind: "open"); return id
        }
        let authenticated = try await open("/api/conversations", base: peer.peers["hub"]!, headers: [["Authorization", "Bearer " + token]])
        try check(try await read(authenticated) == Data("[]".utf8), "managerAuthenticatedHttp")
        try check(try await read(authenticated).isEmpty, "managerEofReleasesSlot")
        try await rejects("managerOldHttpIdRejected") { _ = try await read(authenticated) }

        let file = try await open("/api/large")
        try await Task.sleep(nanoseconds: 500_000_000)
        let unreadBytes = manager.auditState().first?["received"] as? Int64 ?? -1
        results["unreadFoundationReceivedBytes"] = unreadBytes
        try check(unreadBytes >= 0 && unreadBytes < 16 * 1024 * 1024, "nativeUnreadResponseBackpressure")
        var digest = SHA256(), bytes = 0, reads = 0, largest = 0
        let began = ProcessInfo.processInfo.systemUptime
        while true {
            let chunk: Data
            do { chunk = try await read(file) }
            catch {
                results["managerTransferFailure"] = ["bytes": bytes, "reads": reads, "maximumNativeBuffer": manager.queue.sync { manager.maximumBufferedBytes }]
                throw error
            }
            if chunk.isEmpty { break }
            digest.update(data: chunk); bytes += chunk.count; reads += 1; largest = max(largest, chunk.count)
        }
        var expected = SHA256(); let piece = Data(repeating: 0x61, count: HubTLS.readBytes)
        for _ in 0..<2048 { expected.update(data: piece) }
        try check(bytes == 512 * 1024 * 1024 && digest.finalize() == expected.finalize(), "manager512MiBHash")
        try check(largest <= HubTLS.readBytes && reads == 2048, "managerBoundedIpcChunks")
        let buffered = manager.queue.sync { manager.maximumBufferedBytes }
        try check(buffered <= HubTLS.readBytes, "managerBoundedNativeBuffer")
        results["managerTransfer"] = ["bytes": bytes, "reads": reads, "maximumChunk": largest, "maximumNativeBuffer": buffered, "seconds": ProcessInfo.processInfo.systemUptime - began]

        let upload = Data(repeating: 0x61, count: HubTLS.bodyLimit), echo = try await open("/api/echo", upload.base64EncodedString())
        var echoed = SHA256(), echoedBytes = 0
        while true { let chunk = try await read(echo); if chunk.isEmpty { break }; echoed.update(data: chunk); echoedBytes += chunk.count }
        try check(echoedBytes == upload.count && echoed.finalize() == SHA256.hash(data: upload), "manager8MiBUpload")
        try await rejects("managerRedirectRejected") { _ = try await open("/api/redirect") }
        for path in ["/api/instance", "/api/INSTANCE/test", "/api/%69nstance", "/api//instance", "/api/instance;x", "/api/%2569nstance", "/api/instance%2fx", "//other/api/x"] {
            try await rejects("pathRejected:\(path)") { _ = try await open(path) }
        }
        try await rejects("managerHeaderInjectionRejected") { _ = try await open("/health", headers: [["Authorization", "x\r\nOther: bad"]]) }
        try await rejects("managerForeignHeaderRejected") { _ = try await open("/health", headers: [["Host", "other"]]) }

        let hang = try await open("/api/hang-prefix")
        let waiting = Task { try await read(hang) }
        try await Task.sleep(nanoseconds: 100_000_000)
        let cancelledAt = ProcessInfo.processInfo.systemUptime
        _ = try await call(manager, "cancel", ["id": hang])
        try await rejects("managerCancelBlockedRead") { _ = try await waiting.value }
        try check(ProcessInfo.processInfo.systemUptime - cancelledAt < 1, "managerControlNotBlockedByRead")

        let stalled = try await allocate(manager, document)
        let pending = Task { try await call(manager, "httpOpen", ["id": stalled, "input": input("/api/stalled-upload", upload.base64EncodedString())]) }
        try await Task.sleep(nanoseconds: 200_000_000)
        _ = try await call(manager, "cancel", ["id": stalled])
        try await rejects("managerCancelBlockedUpload") { _ = try await pending.value }
        try await rejects("managerDroppedPostReportsFailure") { _ = try await open("/api/drop-after-upload", Data("once".utf8).base64EncodedString()) }
        let dropped = try JSONSerialization.jsonObject(with: Data(peer.command("stats").utf8)) as! [String: Any]
        try check(dropped["acceptedDroppedUploads"] as? Int == 1, "managerNoObservedPostReplay")
        let payload = upload.base64EncodedString()
        var admitted: [(String, Task<[String: Any], Error>)] = []
        for _ in 0..<4 {
            let id = try await allocate(manager, document)
            admitted.append((id, Task { try await call(manager, "httpOpen", ["id": id, "input": input("/api/stalled-upload", payload)]) }))
        }
        try await Task.sleep(nanoseconds: 200_000_000)
        var budgetCode = ""
        do { _ = try await open("/api/stalled-upload", payload) } catch { budgetCode = (error as? HubNetworkError)?.code ?? "unknown" }
        try check(budgetCode == "native_upload_backpressure", "managerAggregateUploadBudget")
        for (id, pending) in admitted {
            _ = try await call(manager, "cancel", ["id": id]); _ = await pending.result
        }
        let afterBudget = try await open("/api/echo", Data("released".utf8).base64EncodedString())
        try check(try await read(afterBudget) == Data("released".utf8), "managerCancellationReturnsUploadBudget")
        _ = try await read(afterBudget)

        let ws = try await socket()
        _ = try await call(manager, "socketSend", ["id": ws, "text": "$audit:burst"])
        let eight = try await events.wait(ws, kind: "message", count: 8)
        try await Task.sleep(nanoseconds: 150_000_000)
        try check(events.get(ws, kind: "message").count == 8 && eight.last?["sequence"] as? Int == 8, "managerEightMessageCredits")
        _ = try await call(manager, "socketAck", ["id": ws, "sequence": 8])
        let nine = try await events.wait(ws, kind: "message", count: 9)
        try check(nine.last?["sequence"] as? Int == 9, "managerAcknowledgmentResumesStream")
        try await rejects("managerInvalidReceiptRejected") { _ = try await call(manager, "socketAck", ["id": ws, "sequence": 10]) }
        _ = try await call(manager, "socketClose", ["id": ws, "code": 1000, "reason": "done"])
        let close = try await events.wait(ws, kind: "close")
        try check(close.count == 1 && close[0]["code"] as? Int == 1000 && close[0]["clean"] as? Bool == false, "managerLocalCloseNotClaimedPeerConfirmed")
        let peerClosed = try await socket()
        _ = try await call(manager, "socketSend", ["id": peerClosed, "text": "$audit:peer-close"])
        let peerReceipt = try await events.wait(peerClosed, kind: "close")
        try check(peerReceipt[0]["code"] as? Int == 3333 && peerReceipt[0]["clean"] as? Bool == true, "managerPeerInitiatedCloseConfirmed")

        let abrupt = try await socket()
        _ = try await call(manager, "socketSend", ["id": abrupt, "text": "$audit:terminate"])
        let ended = try await events.wait(abrupt, kind: "close")
        try check(ended[0]["clean"] as? Bool == false && ended[0]["code"] as? Int == 1006, "managerAbruptCloseNotClean")
        let big = try await socket()
        _ = try await call(manager, "socketSend", ["id": big, "text": "$audit:oversize"])
        _ = try await events.wait(big, kind: "close")
        try check(events.get(big, kind: "message").isEmpty, "managerOversizeNeverBridged")

        let full = try await socket()
        _ = try await call(manager, "socketSend", ["id": full, "text": "$audit:burst-close"])
        _ = try await events.wait(full, kind: "message", count: 8)
        _ = try await call(manager, "socketClose", ["id": full, "code": 1000, "reason": "done"])
        let backlogClosed = try await events.wait(full, kind: "close")
        results["backlogCloseReceipt"] = backlogClosed[0].filter { $0.key != "id" && $0.key != "document" }
        try check(backlogClosed.count == 1 && backlogClosed[0]["clean"] as? Bool == false, "managerCloseDuringUnacknowledgedBacklog")

        let ignored = try await socket()
        _ = try await call(manager, "socketSend", ["id": ignored, "text": "$audit:ignore-close"])
        _ = try await events.wait(ignored, kind: "message")
        _ = try await call(manager, "socketClose", ["id": ignored, "code": 1000, "reason": "test peer silence"])
        let missing = try await events.wait(ignored, kind: "close")
        results["missingPeerCloseReceipt"] = missing[0].filter { $0.key != "id" && $0.key != "document" }
        try check(missing[0]["clean"] as? Bool == false, "managerMissingPeerCloseNeverClean")

        let byteLimited = try await socket()
        _ = try await call(manager, "socketSend", ["id": byteLimited, "text": "$audit:byte-burst"])
        _ = try await events.wait(byteLimited, kind: "message")
        try await Task.sleep(nanoseconds: 100_000_000)
        try check(events.get(byteLimited, kind: "message").count == 1, "managerUnacknowledgedByteBudget")
        _ = try await call(manager, "socketAck", ["id": byteLimited, "sequence": 1])
        _ = try await events.wait(byteLimited, kind: "message", count: 2)
        try await Task.sleep(nanoseconds: 100_000_000)
        try check(events.get(byteLimited, kind: "message").count == 2, "managerByteAcknowledgmentResumesOneMessage")
        _ = try await call(manager, "cancel", ["id": byteLimited])

        try await rejects("managerProxyCannotReceiveCredentials") {
            _ = try await open("/api/stolen", base: peer.peers["proxy"]!, headers: [["Authorization", "Bearer isolated-audit"]])
        }
        // The async HTTP iterator must enforce the same native pin as the
        // delegate HTTP and WS paths, even though it owns different callbacks.
        try check(try peer.command("rotate-back") == "ok", "managerCertificateRotated")
        var trustCode = ""
        do { _ = try await open("/health") } catch { trustCode = (error as? HubNetworkError)?.code ?? "unknown" }
        try check(trustCode == "tls_identity_mismatch", "managerAsyncHttpStalePinRejectedWithIdentityCode")
        let recovered = try await open("/health")
        _ = try await read(recovered); _ = try await read(recovered)
        try check(true, "managerAsyncHttpFreshProofRecovers")

        let old = document, stale = try await allocate(manager, document), staleSocket = try await socket()
        document = try await call(manager, "document")["value"] as! String
        try await rejects("managerStaleDocumentRejected") { _ = try await allocate(manager, old) }
        try await rejects("managerLateOpenRejected") { _ = try await call(manager, "httpOpen", ["id": stale, "input": input("/health")]) }
        try await rejects("managerOldSocketCannotSend") { _ = try await call(manager, "socketSend", ["id": staleSocket, "text": "late"]) }
        let before = try JSONSerialization.jsonObject(with: Data(peer.command("stats").utf8)) as! [String: Any]
        results["managerFixtureStats"] = before
        for _ in 0..<32 { _ = try await allocate(manager, document) }
        try await rejects("managerHttpQuota") { _ = try await allocate(manager, document) }
        for _ in 0..<8 { _ = try await allocate(manager, document, "socket") }
        try await rejects("managerSocketQuota") { _ = try await allocate(manager, document, "socket") }
        document = try await call(manager, "document")["value"] as! String
        _ = try await allocate(manager, document)
        try check(true, "managerResetReleasesQuotas")
    }
}
