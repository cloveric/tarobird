import Foundation
import Security

/// One transport per WebView. All state, URLSession delegates and command
/// admission share this queue; no network read blocks the bridge or UI thread.
final class HubTransport: @unchecked Sendable {
    typealias Reply = (Result<[String: Any], Error>) -> Void
    let queue = DispatchQueue(label: "com.tarobot.hub-transport")
    private let anchors: [SecCertificate]?
    private let events: ([String: Any]) -> Void
    private var document: String?
    private var destroyed = false
    private var slots: [String: HubSlot] = [:]
    private var routes: [String: HubTLSSession] = [:]
    private var flights: [String: HubRouteFlight] = [:]
    private var outgoingBytes = 0, bodyBytes = 0
    private(set) var maximumBufferedBytes = 0
#if HUB_TRANSPORT_AUDIT
    func auditState() -> [[String: Any]] {
        queue.sync { slots.values.map { ["kind": $0.kind, "head": $0.head, "read": $0.readReply != nil, "received": $0.task?.countOfBytesReceived ?? -1, "state": $0.task?.state.rawValue ?? -1] } }
    }
#endif

    // Constructor-injected roots are test-only and not exposed by the plugin.
    // Per-route certificateAuthority is a separate explicit anchor; both paths
    // retain verification against the paired Hub identity.
    init(anchors: [SecCertificate]? = nil, events: @escaping ([String: Any]) -> Void) {
        self.anchors = anchors; self.events = events
    }

    func invoke(_ command: String, _ args: [String: Any] = [:], reply: @escaping Reply) {
        queue.async {
            do { try self.perform(command, args, reply) }
            catch { reply(.failure(error)) }
        }
    }

    func reset(destroy: Bool = false) {
        queue.async { self.resetNow(); if destroy { self.destroyed = true; self.routes.values.forEach { $0.cancelAll() }; self.routes.removeAll() } }
    }

    private func resetNow() {
        document = nil
        for slot in Array(slots.values) { finish(slot, HubNetworkError("native_document_retired")) }
        let pending = Array(flights.values); flights.removeAll()
        for flight in pending { flight.session?.cancelAll(); flight.complete(.failure(HubNetworkError("native_document_retired"))) }
    }

    private func perform(_ command: String, _ args: [String: Any], _ reply: @escaping Reply) throws {
        guard !destroyed else { throw HubNetworkError("native_transport_destroyed") }
        switch command {
        case "document":
            resetNow(); document = UUID().uuidString; reply(.success(["value": document!]))
        case "allocate":
            guard document != nil, try Self.text(args, "document") == document else { throw HubNetworkError("native_document_retired") }
            let kind = try Self.text(args, "kind")
            guard kind == "http" || kind == "socket" else { throw HubNetworkError("invalid_native_kind") }
            guard slots.values.filter({ $0.kind == kind }).count < (kind == "http" ? 32 : 8) else { throw HubNetworkError("native_transport_busy") }
            let slot = HubSlot(document: document!, kind: kind); slots[slot.id] = slot
            let deadline = DispatchWorkItem { [weak self, weak slot] in
                if let self = self, let slot = slot, self.owns(slot) { self.finish(slot, HubNetworkError("native_request_timeout")) }
            }
            slot.deadline = deadline; queue.asyncAfter(deadline: .now() + (kind == "http" ? 300 : 1200), execute: deadline)
            reply(.success(["value": slot.id]))
        case "cancel":
            if let slot = slots[try Self.text(args, "id")] { finish(slot, HubNetworkError("native_request_cancelled")) }
            reply(.success([:]))
        case "httpOpen", "socketOpen":
            let slot = try get(args, kind: command == "httpOpen" ? "http" : "socket")
            guard !slot.started else { throw HubNetworkError("native_request_already_started") }
            slot.started = true; slot.openReply = reply
            do {
                if command == "httpOpen" {
                    guard let input = args["input"] as? [String: Any] else { throw HubNetworkError("invalid_native_input") }
                    let origin = try Self.text(input, "origin"), key = try Self.text(input, "hubKey")
                    let (request, bytes) = try Self.request(input)
                    guard bodyBytes + bytes <= 32 * 1024 * 1024 else { throw HubNetworkError("native_upload_backpressure") }
                    slot.bodyBytes = bytes; bodyBytes += bytes
                    prepare(slot, origin, key, authority: input["certificateAuthority"] as? String) { connection in
                        slot.openingTask = try connection.stream(request) { [weak self, weak slot] result in
                            guard let self = self, let slot = slot, self.owns(slot) else {
                                if case .success(let stream) = result { stream.task.cancel() }; return
                            }
                            slot.openingTask = nil
                            do {
                                let stream = try result.get(), response = stream.response
                                slot.stream = stream; slot.task = stream.task
                                guard !(300..<400).contains(response.statusCode) || response.statusCode == 304 else { throw HubNetworkError("hub_redirect_rejected") }
                                slot.head = true
                                let headers = response.allHeaderFields.map { [String(describing: $0.key), String(describing: $0.value)] }
                                let callback = slot.openReply; slot.openReply = nil
                                callback?(.success(["status": response.statusCode, "headers": headers]))
                            } catch { self.forget(slot); self.finish(slot, error) }
                        }
                    }
                } else {
                    prepare(slot, try Self.text(args, "origin"), try Self.text(args, "hubKey"), authority: args["certificateAuthority"] as? String) { connection in
                        let handler = HubSocketHandler(owner: self, slot: slot)
                        let task = try connection.socket(handler: handler)
                        slot.handler = handler; slot.task = task; task.resume()
                        let callback = slot.openReply; slot.openReply = nil; callback?(.success([:]))
                    }
                }
            } catch { finish(slot, error) }
        case "httpRead":
            let slot = try get(args, kind: "http")
            guard slot.head, slot.readReply == nil, let stream = slot.stream else { throw HubNetworkError("native_response_unavailable") }
            slot.readReply = reply
            slot.readingTask = Task { [weak self, weak slot] in
                let result: Result<Data, Error>
                do { result = .success(try await stream.read()) } catch { result = .failure(error) }
                guard let self = self, let slot = slot else { return }
                self.queue.async {
                    guard self.owns(slot) else { return }
                    slot.readingTask = nil
                    switch result {
                    case .success(let bytes):
                        self.maximumBufferedBytes = max(self.maximumBufferedBytes, bytes.count)
                        let callback = slot.readReply; slot.readReply = nil
                        if bytes.isEmpty { self.finish(slot, nil) }
                        callback?(.success(["data": bytes.base64EncodedString()]))
                    case .failure(let error): let failure = slot.connection?.trustFailure ?? error; self.forget(slot); self.finish(slot, failure)
                    }
                }
            }
        case "socketSend":
            let slot = try get(args, kind: "socket"), text = try Self.text(args, "text"), bytes = text.utf8.count
            guard slot.open, !slot.closing, let task = slot.task as? URLSessionWebSocketTask else { throw HubNetworkError("native_socket_not_open") }
            guard bytes <= HubTLS.messageLimit, outgoingBytes + bytes <= 16 * HubTLS.messageLimit,
                  slot.sends.count < 64 else { throw HubNetworkError("native_socket_backpressure") }
            let send = UUID().uuidString; slot.sends[send] = reply; slot.outgoingBytes += bytes; outgoingBytes += bytes
            task.send(.string(text)) { [weak self, weak slot] error in
                guard let self = self, let slot = slot else { return }
                self.queue.async {
                    guard self.owns(slot), let callback = slot.sends.removeValue(forKey: send) else { return }
                    slot.outgoingBytes -= bytes; self.outgoingBytes -= bytes
                    if let error = error { callback(.failure(error)); self.finish(slot, error) }
                    else { callback(.success([:])) }
                }
            }
        case "socketAck":
            let slot = try get(args, kind: "socket"), sequence = try Self.integer(args, "sequence")
            guard sequence >= 0, sequence <= slot.sent else { throw HubNetworkError("invalid_socket_receipt") }
            if sequence > slot.acknowledged {
                slot.acknowledged = sequence
                while let item = slot.receipts.first, item.sequence <= sequence {
                    slot.unacknowledgedBytes -= item.bytes; slot.receipts.removeFirst()
                }
                slot.creditDeadline?.cancel(); slot.creditDeadline = nil
            }
            receive(slot)
            reply(.success([:]))
        case "socketClose":
            let code = try Self.integer(args, "code"), reason = try Self.text(args, "reason")
            guard code == 1000 || (3000..<5000).contains(code), reason.utf8.count <= 123,
                  let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code) else { throw HubNetworkError("invalid_socket_close") }
            guard let slot = slots[try Self.text(args, "id")], slot.kind == "socket", owns(slot) else { reply(.success(["value": false])); return }
            guard slot.open, let task = slot.task as? URLSessionWebSocketTask else { finish(slot, HubNetworkError("native_request_cancelled")); reply(.success(["value": false])); return }
            if !slot.closing {
                slot.closing = true; slot.creditDeadline?.cancel(); slot.creditDeadline = nil
                resume(slot); task.cancel(with: closeCode, reason: Data(reason.utf8))
                let timeout = DispatchWorkItem { [weak self, weak slot] in
                    if let self = self, let slot = slot, self.owns(slot) { self.finish(slot, HubNetworkError("native_close_timeout")) }
                }
                slot.closeDeadline = timeout; queue.asyncAfter(deadline: .now() + 5, execute: timeout)
            }
            // Receipt means only that close was requested. Foundation also
            // emits didCloseWith for local cancel without a peer reply, so
            // locally requested closes cannot claim a confirmed clean receipt.
            reply(.success(["value": true]))
        default: throw HubNetworkError("unknown_native_transport_command")
        }
    }

    private static func text(_ args: [String: Any], _ name: String) throws -> String {
        guard let value = args[name] as? String else { throw HubNetworkError("invalid_native_input") }; return value
    }
    private static func integer(_ args: [String: Any], _ name: String) throws -> Int {
        guard let value = args[name] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue.isFinite, abs(value.doubleValue) <= 9007199254740991,
              value.doubleValue.rounded(.towardZero) == value.doubleValue else { throw HubNetworkError("invalid_native_input") }
        return value.intValue
    }
    private static func request(_ input: [String: Any]) throws -> (URLRequest, Int) {
        let base = try HubTLS.origin(text(input, "origin")), method = try text(input, "method")
        guard ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].contains(method) else { throw HubNetworkError("invalid_http_method") }
        var request = URLRequest(url: try HubTLS.target(base, text(input, "path")))
        request.httpMethod = method; request.timeoutInterval = 300
        guard let headers = input["headers"] as? [[String]], headers.count <= 32 else { throw HubNetworkError("invalid_http_headers") }
        var count = 0, names = Set<String>()
        for pair in headers {
            guard pair.count == 2 else { throw HubNetworkError("invalid_http_headers") }
            let name = pair[0].lowercased(), value = pair[1]; count += pair[0].utf8.count + value.utf8.count
            guard count <= 16384, ["authorization", "content-type", "accept", "range", "if-range", "if-none-match"].contains(name),
                  names.insert(name).inserted, !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw HubNetworkError("invalid_http_headers") }
            request.setValue(value, forHTTPHeaderField: name)
        }
        var bodyBytes = 0
        if let raw = input["body"], !(raw is NSNull) {
            guard let encoded = raw as? String, encoded.utf8.count <= ((HubTLS.bodyLimit + 2) / 3) * 4,
                  method != "GET", method != "HEAD" else { throw HubNetworkError("invalid_http_body") }
            let body = try HubTLS.decode(encoded)
            guard body.count <= HubTLS.bodyLimit else { throw HubNetworkError("native_body_too_large") }
            bodyBytes = body.count
            request.httpBodyStream = InputStream(data: body)
            request.setValue(String(body.count), forHTTPHeaderField: "Content-Length")
        } else if ["POST", "PUT", "PATCH"].contains(method) {
            request.httpBodyStream = InputStream(data: Data()); request.setValue("0", forHTTPHeaderField: "Content-Length")
        }
        return (request, bodyBytes)
    }

    fileprivate func owns(_ slot: HubSlot) -> Bool { slots[slot.id] === slot && slot.document == document && !destroyed }
    private func get(_ args: [String: Any], kind: String) throws -> HubSlot {
        guard let slot = slots[try Self.text(args, "id")], slot.kind == kind, owns(slot) else { throw HubNetworkError("native_request_cancelled") }; return slot
    }
    private func prepare(_ slot: HubSlot, _ origin: String, _ key: String, authority: String? = nil, _ ready: @escaping (HubTLSSession) throws -> Void) {
        do {
            let base = try HubTLS.origin(origin); _ = try HubTLS.publicKey(key)
            var scopedAnchors = anchors
            if let authority = authority {
                guard authority.utf8.count <= 4096, let der = Data(base64Encoded: authority),
                      let certificate = SecCertificateCreateWithData(nil, der as CFData) else { throw HubNetworkError("invalid_host_authority") }
                scopedAnchors = [certificate]
            }
            let route = "\(HubTLS.hostname(base)):\(base.port ?? 443)\0\(key)\0\(authority ?? "")"; slot.route = route
            let callback: (Result<HubTLSSession, Error>) -> Void = { [weak self, weak slot] result in
                guard let self = self, let slot = slot, self.owns(slot) else { return }
                do { let session = try result.get(); slot.connection = session; try ready(session) }
                catch { self.forget(slot); self.finish(slot, error) }
            }
            if let cached = routes[route] {
                if cached.usable, ProcessInfo.processInfo.systemUptime - cached.created < 300 { callback(.success(cached)); return }
                routes.removeValue(forKey: route); cached.retire()
            }
            if let flight = flights[route] { flight.callbacks.append(callback); return }
            let flight = HubRouteFlight(); flights[route] = flight; flight.callbacks.append(callback)
            do { flight.session = try HubTLSSession.prepare(origin: origin, publicKey: key, queue: queue, anchors: scopedAnchors) { [weak self, weak flight] result in
                guard let self = self, let flight = flight else { return }
                guard self.flights[route] === flight else { if case .success(let session) = result { session.cancelAll() }; return }
                self.flights.removeValue(forKey: route)
                if case .success(let session) = result {
                    if self.routes.count >= 64, let oldest = self.routes.min(by: { $0.value.created < $1.value.created }) {
                        self.routes.removeValue(forKey: oldest.key); oldest.value.retire()
                    }
                    self.routes[route] = session
                }
                flight.complete(result)
            } } catch { flights.removeValue(forKey: route); flight.complete(.failure(error)) }
        } catch { finish(slot, error) }
    }
    private func forget(_ slot: HubSlot) {
        if let key = slot.route, let route = routes[key], route === slot.connection {
            routes.removeValue(forKey: key); route.retire()
        }
    }
    private func pause(_ slot: HubSlot) { if !slot.paused { slot.paused = true; slot.task?.suspend() } }
    private func resume(_ slot: HubSlot) { if slot.paused { slot.paused = false; slot.task?.resume() } }
    fileprivate func completed(_ slot: HubSlot, _ error: Error?) {
        guard owns(slot) else { return }
        if let error = error {
            let failure = slot.connection?.trustFailure ?? error
            emit(slot, ["kind": "error", "error": (failure as? HubNetworkError)?.code ?? "native_socket_failed"])
            forget(slot); finish(slot, failure)
        }
        else { finish(slot, HubNetworkError("native_socket_closed_without_peer_receipt")) }
    }
    fileprivate func socketOpened(_ slot: HubSlot) {
        guard owns(slot), !slot.closing else { return }
        slot.open = true; emit(slot, ["kind": "open"]); receive(slot)
    }
    private func receive(_ slot: HubSlot) {
        guard owns(slot), slot.open, !slot.closing, !slot.receiving, let task = slot.task as? URLSessionWebSocketTask else { return }
        if let pending = slot.pendingText {
            guard slot.unacknowledgedBytes + pending.utf8.count <= HubTLS.messageLimit else { waitForCredit(slot); return }
            slot.pendingText = nil; deliver(slot, pending)
        }
        if slot.sent - slot.acknowledged >= 8 || slot.unacknowledgedBytes >= HubTLS.messageLimit { waitForCredit(slot); return }
        resume(slot); slot.receiving = true
        task.receive { [weak self, weak slot] result in
            guard let self = self, let slot = slot else { return }
            self.queue.async {
                guard self.owns(slot) else { return }; slot.receiving = false
                switch result {
                case .success(.string(let text)):
                    guard !slot.closing else { return }
                    guard text.utf8.count <= HubTLS.messageLimit else { self.finish(slot, HubNetworkError("native_message_too_large")); return }
                    if slot.unacknowledgedBytes + text.utf8.count > HubTLS.messageLimit { slot.pendingText = text; self.waitForCredit(slot) }
                    else { self.deliver(slot, text); self.receive(slot) }
                case .success: self.finish(slot, HubNetworkError("native_binary_socket_rejected"))
                case .failure:
                    // Receive may report cancellation before didCloseWith for
                    // a peer-initiated clean close. Let delegate completion or
                    // the close deadline decide, never fabricate a receipt.
                    if !slot.closing { self.queue.asyncAfter(deadline: .now() + 1) { if self.owns(slot) { self.finish(slot, HubNetworkError("native_socket_receive_failed")) } } }
                }
            }
        }
    }
    private func deliver(_ slot: HubSlot, _ text: String) {
        slot.sent += 1; let bytes = text.utf8.count; slot.unacknowledgedBytes += bytes
        slot.receipts.append((slot.sent, bytes)); emit(slot, ["kind": "message", "data": text, "sequence": slot.sent])
    }
    private func waitForCredit(_ slot: HubSlot) {
        pause(slot)
        if slot.creditDeadline == nil {
            let timeout = DispatchWorkItem { [weak self, weak slot] in
                if let self = self, let slot = slot, self.owns(slot) { self.finish(slot, HubNetworkError("native_socket_receipt_timeout")) }
            }
            slot.creditDeadline = timeout; queue.asyncAfter(deadline: .now() + 10, execute: timeout)
        }
    }
    fileprivate func socketClosed(_ slot: HubSlot, code: Int, reason: Data?) {
        guard owns(slot) else { return }
        finish(slot, nil, close: ["kind": "close", "code": code, "reason": reason.flatMap { String(data: $0, encoding: .utf8) } ?? "", "clean": !slot.closing])
    }
    private func emit(_ slot: HubSlot, _ payload: [String: Any]) {
        var event = payload; event["id"] = slot.id; event["document"] = slot.document; events(event)
    }
    private func finish(_ slot: HubSlot, _ error: Error?, close: [String: Any]? = nil) {
        guard slots[slot.id] === slot else { return }
#if HUB_TRANSPORT_AUDIT
        print("finish", slot.kind, error?.localizedDescription ?? "eof", "read", slot.readReply != nil)
#endif
        slots.removeValue(forKey: slot.id)
        outgoingBytes -= slot.outgoingBytes; bodyBytes -= slot.bodyBytes
        slot.outgoingBytes = 0; slot.bodyBytes = 0; slot.pendingText = nil; slot.receipts.removeAll()
        slot.deadline?.cancel(); slot.creditDeadline?.cancel(); slot.closeDeadline?.cancel()
        slot.openingTask?.cancel(); slot.readingTask?.cancel(); slot.task?.cancel(); slot.handler = nil; slot.stream = nil; slot.connection = nil
        let failure = error ?? HubNetworkError("native_request_cancelled")
        let open = slot.openReply, read = slot.readReply, sends = Array(slot.sends.values)
        slot.openReply = nil; slot.readReply = nil; slot.sends.removeAll()
        open?(.failure(failure)); read?(.failure(failure)); sends.forEach { $0(.failure(failure)) }
        if slot.kind == "socket" { emit(slot, close ?? ["kind": "close", "code": 1006, "reason": "", "clean": false]) }
    }
}

private final class HubRouteFlight {
    var session: HubTLSSession?
    var callbacks: [(Result<HubTLSSession, Error>) -> Void] = []
    func complete(_ result: Result<HubTLSSession, Error>) { let pending = callbacks; callbacks.removeAll(); pending.forEach { $0(result) } }
}
// State is accessed only on the manager queue, including after async reads.
fileprivate final class HubSlot: @unchecked Sendable {
    let id = UUID().uuidString, document: String, kind: String
    var started = false, head = false, open = false, closing = false, paused = false, receiving = false
    var route: String?, task: URLSessionTask?, handler: HubTaskHandler?
    var connection: HubTLSSession?
    var deadline: DispatchWorkItem?, creditDeadline: DispatchWorkItem?, closeDeadline: DispatchWorkItem?
    var openReply: HubTransport.Reply?, readReply: HubTransport.Reply?
    var stream: HubHTTPStream?, openingTask: Task<Void, Never>?, readingTask: Task<Void, Never>?
    var sent = 0, acknowledged = 0, outgoingBytes = 0, bodyBytes = 0, unacknowledgedBytes = 0
    var receipts: [(sequence: Int, bytes: Int)] = []
    var pendingText: String?
    var sends: [String: HubTransport.Reply] = [:]
    init(document: String, kind: String) { self.document = document; self.kind = kind }
}
private final class HubSocketHandler: HubTaskHandler {
    weak var owner: HubTransport?, slot: HubSlot?
    init(owner: HubTransport, slot: HubSlot) { self.owner = owner; self.slot = slot }
    override func socketOpened() { if let slot = slot { owner?.socketOpened(slot) } }
    override func socketClosed(_ code: Int, reason: Data?) { if let slot = slot { owner?.socketClosed(slot, code: code, reason: reason) } }
    override func completed(_ error: Error?) { if let slot = slot { owner?.completed(slot, error) } }
}
