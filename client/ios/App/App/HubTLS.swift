import Foundation
import Security
import CryptoKit

struct HubNetworkError: LocalizedError {
    let code: String
    init(_ code: String) { self.code = code }
    var errorDescription: String? { code }
}

enum HubTLS {
    static let readBytes = 256 * 1024
    static let bodyLimit = 8 * 1024 * 1024
    static let messageLimit = 1024 * 1024
    static let proofLimit = 4096
    static let spkiPrefix = Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])

    static func origin(_ raw: String) throws -> URL {
        guard raw.utf8.count <= 2048, !raw.contains("\\"),
              !raw.unicodeScalars.contains(where: { $0.value <= 32 }),
              let parts = URLComponents(string: raw), parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.percentEncodedPath.isEmpty || parts.percentEncodedPath == "/",
              parts.port == nil || (1...65535).contains(parts.port!), parts.url != nil else {
            throw HubNetworkError("https_hub_origin_required")
        }
        var normalized = parts
        normalized.scheme = "https"; normalized.host = host.lowercased(); normalized.percentEncodedPath = ""
        if normalized.port == 443 { normalized.port = nil }
        guard let canonical = normalized.url else { throw HubNetworkError("https_hub_origin_required") }
        return canonical
    }

    static func hostname(_ url: URL) -> String {
        (url.host ?? "").lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    }

    static func target(_ base: URL, _ path: String) throws -> URL {
        guard path.utf8.count <= 8192, path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains("\\"),
              let url = URL(string: path, relativeTo: base)?.absoluteURL,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              url.scheme == base.scheme, hostname(url) == hostname(base), url.port == base.port,
              parts.fragment == nil, parts.percentEncodedPath == "/health" || parts.percentEncodedPath.hasPrefix("/api/") else {
            throw HubNetworkError("invalid_hub_path")
        }
        let encoded = parts.percentEncodedPath.lowercased()
        guard !encoded.contains("%2f"), !encoded.contains("%5c"), !encoded.contains(";"),
              let decoded = parts.percentEncodedPath.removingPercentEncoding else { throw HubNetworkError("invalid_hub_path") }
        let segments = decoded.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
        guard !segments.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." || $0.contains(";") || $0.contains("%") || $0.contains("\\") }),
              !(segments.count > 1 && segments.dropFirst().first?.lowercased() == "instance") else { throw HubNetworkError("invalid_hub_path") }
        return url
    }

    static func decode(_ text: String) throws -> Data {
        guard let data = Data(base64Encoded: text), data.base64EncodedString() == text else { throw HubNetworkError("invalid_base64") }
        return data
    }

    static func publicKey(_ value: String) throws -> Curve25519.Signing.PublicKey {
        guard value.utf8.count == 60 else { throw HubNetworkError("trusted_hub_key_required") }
        let data = try decode(value)
        guard data.count == 44, data.prefix(12) == spkiPrefix else { throw HubNetworkError("trusted_hub_key_required") }
        return try Curve25519.Signing.PublicKey(rawRepresentation: data.dropFirst(12))
    }

    static func nonce() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw HubNetworkError("random_unavailable") }
        return Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static func verify(_ bytes: Data, publicKey: String, nonce: String, certificate: Data) throws {
        let verifier = try self.publicKey(publicKey)
        guard bytes.count <= proofLimit, let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              Set(value.keys) == Set(["v", "type", "publicKey", "nonce", "certificateSha256", "signature"]),
              let version = value["v"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              value["type"] as? String == "tls.identity", value["publicKey"] as? String == publicKey,
              value["nonce"] as? String == nonce, let signature = value["signature"] as? String else {
            throw HubNetworkError("tls_identity_mismatch")
        }
        let hash = SHA256.hash(data: certificate).map { String(format: "%02x", $0) }.joined()
        guard value["certificateSha256"] as? String == hash else { throw HubNetworkError("tls_identity_mismatch") }
        let signed = Data("[\"tarocub/tls-identity/v1\",\"\(publicKey)\",\"\(nonce)\",\"\(hash)\"]".utf8)
        let decoded = try decode(signature)
        guard decoded.count == 64, verifier.isValidSignature(decoded, for: signed) else { throw HubNetworkError("tls_identity_mismatch") }
    }
}

// All methods and delegate callbacks are confined to HubTLSSession.queue.
// Capacitor is deliberately absent, allowing real Foundation/Security tests.
class HubTaskHandler {
    func response(_ response: HTTPURLResponse, completion: @escaping (URLSession.ResponseDisposition) -> Void) { completion(.cancel) }
    func data(_ data: Data) {}
    func completed(_ error: Error?) {}
    func socketOpened() {}
    func socketClosed(_ code: Int, reason: Data?) {}
}

final class HubTLSSession: NSObject, URLSessionDataDelegate, URLSessionWebSocketDelegate, @unchecked Sendable {
    let base: URL
    let queue: DispatchQueue
    let created = ProcessInfo.processInfo.systemUptime
    private let anchors: [SecCertificate]?
    private var observedLeaf: Data?
    private var pin: Data?
    private var retired = false
    private var cancelled = false
    // Set only when a trust failure deliberately cancels this entire session.
    // Unrelated authentication challenges must not poison later error reports.
    private var terminalTrustFailure: Error?
    var usable: Bool { dispatchPrecondition(condition: .onQueue(queue)); return !retired }
    var trustFailure: Error? { dispatchPrecondition(condition: .onQueue(queue)); return terminalTrustFailure }
    private var handlers: [Int: HubTaskHandler] = [:]
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpShouldUsePipelining = false
        configuration.httpMaximumConnectionsPerHost = 4
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 1200
        configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
        configuration.connectionProxyDictionary = [:]
        let delegates = OperationQueue()
        delegates.maxConcurrentOperationCount = 1
        delegates.underlyingQueue = queue
        return URLSession(configuration: configuration, delegate: self, delegateQueue: delegates)
    }()

    private init(base: URL, queue: DispatchQueue, anchors: [SecCertificate]?) {
        self.base = base; self.queue = queue; self.anchors = anchors
        super.init()
    }

    /// QR-provided roots are scoped to this origin and Hub identity. Hostname,
    /// certificate validity, identity proof and exact-leaf pinning still apply.
    static func prepare(origin: String, publicKey: String, queue: DispatchQueue, anchors: [SecCertificate]? = nil,
                        completion: @escaping (Result<HubTLSSession, Error>) -> Void) throws -> HubTLSSession {
        dispatchPrecondition(condition: .onQueue(queue))
        let base = try HubTLS.origin(origin)
        _ = try HubTLS.publicKey(publicKey)
        let nonce = try HubTLS.nonce()
        let connection = HubTLSSession(base: base, queue: queue, anchors: anchors)
        let probe = HubProofHandler(connection: connection, publicKey: publicKey, nonce: nonce, completion: completion)
        var request = URLRequest(url: try HubTLS.target(base, "/api/tls-identity?nonce=" + nonce))
        request.timeoutInterval = 5
        let task = connection.session.dataTask(with: request)
        connection.handlers[task.taskIdentifier] = probe
        let deadline = DispatchWorkItem { task.cancel() }
        probe.deadline = deadline
        queue.asyncAfter(deadline: .now() + 5, execute: deadline)
        task.resume()
        return connection
    }

    fileprivate func bindProof(_ bytes: Data, key: String, nonce: String) throws {
        guard !retired, pin == nil, let leaf = observedLeaf else { throw HubNetworkError("native_tls_identity_unavailable") }
        try HubTLS.verify(bytes, publicKey: key, nonce: nonce, certificate: leaf)
        // Only the no-credential proof task existed before this point. Reuse
        // its verified TLS connection and enforce this immutable pin on every
        // later challenge, before allowing any credential-bearing task.
        pin = leaf
    }

    func http(_ request: URLRequest, handler: HubTaskHandler) throws -> URLSessionDataTask {
        try validate(request)
        let task = session.dataTask(with: request)
        handlers[task.taskIdentifier] = handler
        return task
    }

    private func validate(_ request: URLRequest) throws {
        dispatchPrecondition(condition: .onQueue(queue))
        guard !retired, pin != nil else { throw HubNetworkError("native_route_not_verified") }
        guard let url = request.url, url.scheme == "https", HubTLS.hostname(url) == HubTLS.hostname(base),
              url.port == base.port, url.user == nil, url.password == nil, url.fragment == nil else { throw HubNetworkError("invalid_hub_origin") }
        guard request.httpBody == nil else { throw HubNetworkError("native_single_use_body_required") }
    }

    func stream(_ request: URLRequest, completion: @escaping (Result<HubHTTPStream, Error>) -> Void) throws -> Task<Void, Never> {
        try validate(request)
        let native = session, callbackQueue = queue
        return Task {
            do {
                try Task.checkCancellation()
                let (bytes, response) = try await native.bytes(for: request)
                if Task.isCancelled { bytes.task.cancel(); throw CancellationError() }
                guard let response = response as? HTTPURLResponse else { bytes.task.cancel(); throw HubNetworkError("native_response_unavailable") }
                let stream = HubHTTPStream(bytes: bytes, response: response)
#if HUB_TRANSPORT_AUDIT
                print("stream headers", response.statusCode, "expected", response.expectedContentLength, "received", bytes.task.countOfBytesReceived)
#endif
                callbackQueue.async { completion(.success(stream)) }
            } catch { callbackQueue.async { completion(.failure(self.terminalTrustFailure ?? error)) } }
        }
    }

    func socket(handler: HubTaskHandler) throws -> URLSessionWebSocketTask {
        dispatchPrecondition(condition: .onQueue(queue))
        guard !retired, pin != nil else { throw HubNetworkError("native_route_not_verified") }
        var parts = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        parts.scheme = "wss"; parts.path = "/ws"
        var request = URLRequest(url: parts.url!)
        request.timeoutInterval = 1200
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = HubTLS.messageLimit
        handlers[task.taskIdentifier] = handler
        return task
    }

    func retire() { dispatchPrecondition(condition: .onQueue(queue)); guard !retired else { return }; retired = true; session.finishTasksAndInvalidate() }
    func cancelAll() { dispatchPrecondition(condition: .onQueue(queue)); retired = true; cancelled = true; session.invalidateAndCancel() }

    private func rejectTrust(_ code: String, _ completion: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        terminalTrustFailure = HubNetworkError(code)
        completion(.cancelAuthenticationChallenge, nil)
        cancelAll()
    }

    private func challenge(_ challenge: URLAuthenticationChallenge,
                           completion: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        dispatchPrecondition(condition: .onQueue(queue))
        let protection = challenge.protectionSpace
        guard !cancelled else { completion(.cancelAuthenticationChallenge, nil); return }
        guard protection.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
            completion(.rejectProtectionSpace, nil); return
        }
        guard protection.host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]")) == HubTLS.hostname(base),
              protection.port == (base.port ?? 443), let trust = protection.serverTrust else {
            rejectTrust("native_tls_challenge_rejected", completion); return
        }
        if let anchors = anchors {
            guard SecTrustSetAnchorCertificates(trust, anchors as CFArray) == errSecSuccess,
                  SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess else {
                rejectTrust("native_tls_untrusted", completion); return
            }
        }
        // Evaluate the supplied system policies, including hostname and ATS;
        // do not replace them with a weaker custom SSL policy.
        // Trust evaluation can fetch intermediates/revocation information.
        // Keep cancellation, deadlines and other hosts responsive while it runs.
        let status = SecTrustEvaluateAsyncWithError(trust, queue) { [weak self] trust, trusted, _ in
            guard let self = self, !self.cancelled else { completion(.cancelAuthenticationChallenge, nil); return }
            guard trusted, let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let certificate = chain.first else {
                self.rejectTrust("native_tls_untrusted", completion); return
            }
            let leaf = SecCertificateCopyData(certificate) as Data
            guard (self.pin == nil || self.pin == leaf), (self.observedLeaf == nil || self.observedLeaf == leaf) else {
                self.rejectTrust("tls_identity_mismatch", completion); return
            }
            self.observedLeaf = leaf
            completion(.useCredential, URLCredential(trust: trust))
        }
        if status != errSecSuccess { rejectTrust("native_tls_untrusted", completion) }
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        self.challenge(challenge, completion: completionHandler)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        self.challenge(challenge, completion: completionHandler)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, task: URLSessionTask, needNewBodyStream completionHandler: @escaping (InputStream?) -> Void) {
        // Streaming request bodies have a single owner; do not recreate them
        // to silently replay a credential-bearing POST after a failed send.
        completionHandler(nil)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse, let handler = handlers[dataTask.taskIdentifier] else { completionHandler(.cancel); return }
        handler.response(response, completion: completionHandler)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) { handlers[dataTask.taskIdentifier]?.data(data) }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let handler = handlers.removeValue(forKey: task.taskIdentifier)
        handler?.completed(error == nil ? nil : (terminalTrustFailure ?? error))
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        handlers[webSocketTask.taskIdentifier]?.socketOpened()
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        handlers[webSocketTask.taskIdentifier]?.socketClosed(closeCode.rawValue, reason: reason)
    }
}

/// One reader at a time, admitted by HubTransport. The native AsyncBytes
/// iterator is consumed only for the next requested IPC chunk; no delegate
/// callback queue is copied into an ever-growing application buffer.
final class HubHTTPStream: @unchecked Sendable {
    let response: HTTPURLResponse
    let task: URLSessionDataTask
    private var iterator: URLSession.AsyncBytes.Iterator
    private var buffer = [UInt8](repeating: 0, count: HubTLS.readBytes)
    init(bytes: URLSession.AsyncBytes, response: HTTPURLResponse) {
        self.response = response; task = bytes.task; iterator = bytes.makeAsyncIterator()
    }
    func read() async throws -> Data {
        var used = 0
        while used < buffer.count {
            guard let byte = try await iterator.next() else { break }; buffer[used] = byte; used += 1
        }
        return Data(buffer.prefix(used))
    }
}

private final class HubProofHandler: HubTaskHandler {
    let connection: HubTLSSession
    let key: String
    let nonce: String
    let completion: (Result<HubTLSSession, Error>) -> Void
    var deadline: DispatchWorkItem?
    private var bytes = Data()
    private var failure: Error?
    init(connection: HubTLSSession, publicKey: String, nonce: String, completion: @escaping (Result<HubTLSSession, Error>) -> Void) {
        self.connection = connection; key = publicKey; self.nonce = nonce; self.completion = completion
    }
    override func response(_ response: HTTPURLResponse, completion: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard response.statusCode == 200, response.expectedContentLength <= HubTLS.proofLimit else {
            failure = HubNetworkError("hub_tls_identity_required"); completion(.cancel); return
        }
        completion(.allow)
    }
    override func data(_ data: Data) {
        guard data.count <= HubTLS.proofLimit - bytes.count else {
            failure = HubNetworkError("tls_identity_too_large"); connection.cancelAll(); return
        }
        bytes.append(data)
    }
    override func completed(_ error: Error?) {
        deadline?.cancel(); deadline = nil
        do {
            if let error = failure ?? error { throw error }
            try connection.bindProof(bytes, key: key, nonce: nonce)
            completion(.success(connection))
        } catch { connection.cancelAll(); completion(.failure(error)) }
    }
}
