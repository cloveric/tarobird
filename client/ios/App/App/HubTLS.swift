import Foundation
import Network
import Security
import CryptoKit

struct HubNetworkError: LocalizedError {
    let code: String
    init(_ code: String) { self.code = code }
    var errorDescription: String? { code }

    static func classify(_ error: Error, fallback: String = "native_transport_failed", host: String? = nil) -> String {
        if let hub = error as? HubNetworkError { return hub.code }
        var current: NSError? = error as NSError
        var urlCode: URLError.Code?
        var posixCode: Int?
        var osStatus: OSStatus?
        var nwDnsError = false
        var effectiveHost: String? = host.flatMap { $0.isEmpty ? nil : $0 }
        var depth = 0
        while let ns = current, depth < 8 {
            if effectiveHost == nil {
                if let failingUrl = ns.userInfo[NSURLErrorFailingURLErrorKey] as? URL, let target = failingUrl.host, !target.isEmpty {
                    effectiveHost = target
                } else if let failingString = ns.userInfo[NSURLErrorFailingURLStringErrorKey] as? String,
                          let failingUrl = URL(string: failingString), let target = failingUrl.host, !target.isEmpty {
                    effectiveHost = target
                }
            }
            if let pathObj = ns.userInfo["_NSURLErrorNWPathKey"] {
                if #available(iOS 14.2, macOS 11.0, *),
                   let path = pathObj as? OS_nw_path,
                   nw_path_get_unsatisfied_reason(path) == nw_path_unsatisfied_reason_local_network_denied {
                    return "local_network_permission_denied"
                }
                if String(describing: pathObj).localizedCaseInsensitiveContains("local network prohibited") {
                    return "local_network_permission_denied"
                }
            }
            if (ns.domain == NetService.errorDomain || ns.domain == "kCFErrorDomainDNSServiceDiscovery" || ns.domain == "kNWErrorDomainDNS") && ns.code == -65555 {
                return "local_network_permission_denied"
            }
            if ns.domain == "kNWErrorDomainDNS" {
                nwDnsError = true
            }
            if ns.domain == NSPOSIXErrorDomain || ns.domain == (kCFErrorDomainPOSIX as String) || ns.domain == "kNWErrorDomainPOSIX" {
                posixCode = posixCode ?? ns.code
            }
            if ns.domain == NSURLErrorDomain && urlCode == nil {
                urlCode = URLError.Code(rawValue: ns.code)
            }
            if ns.domain == NSOSStatusErrorDomain && osStatus == nil {
                osStatus = OSStatus(truncatingIfNeeded: ns.code)
            }
            current = ns.userInfo[NSUnderlyingErrorKey] as? NSError
            depth += 1
        }
        // Trust evaluation (SecTrustEvaluateAsyncWithError) reports OSStatus
        // causes; URL loading errors keep their URL-level classification below.
        if urlCode == nil, let status = osStatus {
            switch status {
            case errSecHostNameMismatch: return "native_tls_hostname_mismatch"
            case errSecCertificateExpired, errSecCertificateNotValidYet: return "native_tls_cert_expired"
            case errSecInvalidExtendedKeyUsage, errSecInvalidKeyUsageForPolicy, errSecCertificateValidityPeriodTooLong:
                return "native_tls_cert_policy_rejected"
            default: break
            }
        }
        if let code = urlCode {
            switch code {
            case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff: return "native_network_offline"
            case .secureConnectionFailed, .serverCertificateHasBadDate, .serverCertificateUntrusted,
                 .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid: return "native_tls_untrusted"
            case .clientCertificateRejected, .clientCertificateRequired: return "native_tls_handshake_failed"
            case .appTransportSecurityRequiresSecureConnection: return "native_ats_blocked"
            case .cannotFindHost, .dnsLookupFailed: return "native_dns_failed"
            default: break
            }
        }
        if let posix = posixCode {
            switch Int32(posix) {
            case EPERM:
                if let target = effectiveHost, HubTLS.isLocalNetworkHost(target) {
                    return "local_network_permission_denied"
                }
                return "native_host_unreachable"
            case ECONNREFUSED: return "native_connection_refused"
            case ETIMEDOUT: return "native_request_timeout"
            case EHOSTUNREACH, ENETUNREACH, EHOSTDOWN, ENETDOWN: return "native_host_unreachable"
            default: break
            }
        }
        if let code = urlCode {
            switch code {
            case .timedOut: return "native_request_timeout"
            case .networkConnectionLost: return "native_connection_reset"
            case .cannotConnectToHost: return "native_host_unreachable"
            default: break
            }
        }
        if nwDnsError { return "native_dns_failed" }
        return fallback
    }
}

enum HubScreenRole: String { case control, media }

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

    static func isLocalNetworkHost(_ raw: String) -> Bool {
        var host = raw.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host.hasSuffix(".") { host.removeLast() }
        if host.isEmpty { return false }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        if parts.count == 4 {
            let octets = parts.compactMap { Int($0) }
            if octets.count == 4 && octets.allSatisfy({ (0...255).contains($0) }) {
                return octets[0] == 10
                    || (octets[0] == 192 && octets[1] == 168)
                    || (octets[0] == 172 && (16...31).contains(octets[1]))
                    || (octets[0] == 169 && octets[1] == 254)
            }
        }
        if host.contains(":") {
            if host.hasPrefix("fd7a:115c:a1e0:") { return false }
            if host.hasPrefix("fe80:") { return true }
            if host.hasPrefix("fc") || host.hasPrefix("fd") {
                let first = host.split(separator: ":").first ?? ""
                if first.count == 4, UInt16(first, radix: 16) != nil { return true }
            }
        }
        return host.hasSuffix(".local") || host.hasSuffix(".lan")
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

    static func verifyEdge(_ bytes: Data, publicKey: String, nonce: String, origin: String) throws {
        let verifier = try self.publicKey(publicKey)
        guard bytes.count <= proofLimit, let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              Set(value.keys) == Set(["v", "type", "publicKey", "nonce", "origin", "signature"]),
              let version = value["v"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              value["type"] as? String == "edge.identity", value["publicKey"] as? String == publicKey,
              value["nonce"] as? String == nonce, value["origin"] as? String == origin,
              let signature = value["signature"] as? String else {
            throw HubNetworkError("tls_identity_mismatch")
        }
        let signed = Data("[\"tarocub/edge-identity/v1\",\"\(publicKey)\",\"\(nonce)\",\"\(origin)\"]".utf8)
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
    private let edgeTls: Bool
    private var observedLeaf: Data?
    private var pin: Data?
    private var edgeVerified = false
    private var retired = false
    private var cancelled = false
    // Set only when a trust failure deliberately cancels this entire session.
    // Unrelated authentication challenges must not poison later error reports.
    private var terminalTrustFailure: Error?
    var usable: Bool { dispatchPrecondition(condition: .onQueue(queue)); return !retired }
    var trustFailure: Error? { dispatchPrecondition(condition: .onQueue(queue)); return terminalTrustFailure }
    private var handlers: [Int: HubTaskHandler] = [:]
    private var screenConnections: [ObjectIdentifier: HubScreenConnection] = [:]
    private lazy var session: URLSession = makeSession(delegate: self, screen: false)
    fileprivate func makeSession(delegate: URLSessionDelegate, screen: Bool) -> URLSession {
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
        // WebSocket tasks otherwise inherit the ordinary request resource
        // lifetime. Screen attachment, heartbeat and consumption watchdogs
        // provide their bounds; zero is Foundation's no-resource-expiry value.
        configuration.timeoutIntervalForResource = screen ? 0 : 1200
        configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
        configuration.connectionProxyDictionary = [:]
        let delegates = OperationQueue()
        delegates.maxConcurrentOperationCount = 1
        delegates.underlyingQueue = queue
        return URLSession(configuration: configuration, delegate: delegate, delegateQueue: delegates)
    }

    private init(base: URL, queue: DispatchQueue, anchors: [SecCertificate]?, edgeTls: Bool = false) {
        self.base = base; self.queue = queue; self.anchors = anchors; self.edgeTls = edgeTls
        super.init()
    }

    /// QR-provided roots are scoped to this origin and Hub identity. Hostname,
    /// certificate validity, identity proof and exact-leaf pinning still apply.
    static func prepare(origin: String, publicKey: String, queue: DispatchQueue, anchors: [SecCertificate]? = nil,
                        // Identity probe budget; slow cross-border VPN links need more than 5 s.
                        timeout: TimeInterval = 12,
                        edgeTls: Bool = false,
                        completion: @escaping (Result<HubTLSSession, Error>) -> Void) throws -> HubTLSSession {
        dispatchPrecondition(condition: .onQueue(queue))
        if edgeTls && anchors != nil { throw HubNetworkError("invalid_host_authority") }
        let base = try HubTLS.origin(origin)
        _ = try HubTLS.publicKey(publicKey)
        let nonce = try HubTLS.nonce()
        let connection = HubTLSSession(base: base, queue: queue, anchors: anchors, edgeTls: edgeTls)
        let probe = HubProofHandler(connection: connection, publicKey: publicKey, nonce: nonce, completion: completion)
        let canonical = base.absoluteString.hasSuffix("/") ? String(base.absoluteString.dropLast()) : base.absoluteString
        let path: String
        if edgeTls {
            var comps = URLComponents()
            comps.path = "/api/edge-identity"
            comps.queryItems = [URLQueryItem(name: "nonce", value: nonce), URLQueryItem(name: "origin", value: canonical)]
            path = comps.string ?? ("/api/edge-identity?nonce=" + nonce)
        } else {
            path = "/api/tls-identity?nonce=" + nonce
        }
        var request = URLRequest(url: try HubTLS.target(base, path))
        request.timeoutInterval = timeout
        let task = connection.session.dataTask(with: request)
        connection.handlers[task.taskIdentifier] = probe
        let deadline = DispatchWorkItem { [weak probe] in
            probe?.markTimeout()
            task.cancel()
        }
        probe.deadline = deadline
        queue.asyncAfter(deadline: .now() + timeout, execute: deadline)
        task.resume()
        return connection
    }

    fileprivate func bindProof(_ bytes: Data, key: String, nonce: String) throws {
        guard !retired else { throw HubNetworkError("native_tls_identity_unavailable") }
        if edgeTls {
            guard !edgeVerified else { throw HubNetworkError("native_tls_identity_unavailable") }
            let canonical = base.absoluteString.hasSuffix("/") ? String(base.absoluteString.dropLast()) : base.absoluteString
            try HubTLS.verifyEdge(bytes, publicKey: key, nonce: nonce, origin: canonical)
            edgeVerified = true
            return
        }
        guard pin == nil, let leaf = observedLeaf else { throw HubNetworkError("native_tls_identity_unavailable") }
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
        guard !retired, (pin != nil || edgeVerified) else { throw HubNetworkError("native_route_not_verified") }
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

    /// Every viewer group owns a separate native session. It inherits this
    /// route's verified identity/pin, but never the chat resource deadline.
    func screenConnection(control: HubTaskHandler, media: HubTaskHandler) throws -> HubScreenConnection {
        dispatchPrecondition(condition: .onQueue(queue))
        guard !retired, (pin != nil || edgeVerified) else { throw HubNetworkError("native_route_not_verified") }
        let connection = HubScreenConnection(owner: self, control: control, media: media)
        screenConnections[ObjectIdentifier(connection)] = connection
        return connection
    }
    fileprivate func removeScreen(_ connection: HubScreenConnection) { screenConnections.removeValue(forKey: ObjectIdentifier(connection)) }

    func socket(handler: HubTaskHandler) throws -> URLSessionWebSocketTask {
        dispatchPrecondition(condition: .onQueue(queue))
        guard !retired, (pin != nil || edgeVerified) else { throw HubNetworkError("native_route_not_verified") }
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
    func cancelAll() {
        dispatchPrecondition(condition: .onQueue(queue)); retired = true; cancelled = true; session.invalidateAndCancel()
        for connection in Array(screenConnections.values) { connection.cancel() }
    }

    private func rejectTrust(_ code: String, _ completion: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        terminalTrustFailure = HubNetworkError(code)
        completion(.cancelAuthenticationChallenge, nil)
        cancelAll()
    }

    fileprivate func challenge(_ challenge: URLAuthenticationChallenge,
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
            // Route-scoped private CAs have no public AIA/OCSP responders;
            // disable network fetch so restricted/VPN networks never stall trust evaluation.
            _ = SecTrustSetNetworkFetchAllowed(trust, false)
        }
        // Evaluate the supplied system policies, including hostname and ATS;
        // do not replace them with a weaker custom SSL policy.
        // Trust evaluation can fetch intermediates/revocation information.
        // Keep cancellation, deadlines and other hosts responsive while it runs.
        let status = SecTrustEvaluateAsyncWithError(trust, queue) { [weak self] trust, trusted, trustError in
            guard let self = self, !self.cancelled else { completion(.cancelAuthenticationChallenge, nil); return }
            guard trusted, let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let certificate = chain.first else {
                let code = trustError.map { HubNetworkError.classify($0, fallback: "native_tls_untrusted") } ?? "native_tls_untrusted"
                self.rejectTrust(code, completion); return
            }
            let leaf = SecCertificateCopyData(certificate) as Data
            if !self.edgeTls {
                guard (self.pin == nil || self.pin == leaf), (self.observedLeaf == nil || self.observedLeaf == leaf) else {
                    self.rejectTrust("tls_identity_mismatch", completion); return
                }
                self.observedLeaf = leaf
            }
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

/// The delegate is isolated per screen group: URLSession task identifiers are
/// only unique within one session. It forwards TLS trust to the verified route
/// and never broadens paths, credentials, redirects or certificate policy.
final class HubScreenConnection: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    private weak var owner: HubTLSSession?
    private var session: URLSession?
    private var handlers: [Int: HubTaskHandler] = [:]
    private(set) var control: URLSessionWebSocketTask!, media: URLSessionWebSocketTask!
    fileprivate init(owner: HubTLSSession, control: HubTaskHandler, media: HubTaskHandler) {
        self.owner = owner; super.init()
        let native = owner.makeSession(delegate: self, screen: true); session = native
        func task(_ role: HubScreenRole, _ handler: HubTaskHandler) -> URLSessionWebSocketTask {
            var parts = URLComponents(url: owner.base, resolvingAgainstBaseURL: false)!
            parts.scheme = "wss"; parts.path = "/screen/v1/" + role.rawValue
            var request = URLRequest(url: parts.url!); request.timeoutInterval = 5
            let task = native.webSocketTask(with: request)
            task.maximumMessageSize = role == .media ? 1048576 : 16384
            handlers[task.taskIdentifier] = handler; return task
        }
        self.control = task(.control, control); self.media = task(.media, media)
    }
    func cancel() {
        guard let native = session else { return }; session = nil
        control?.cancel(); media?.cancel(); control = nil; media = nil
        handlers.removeAll(); native.invalidateAndCancel()
        owner?.removeScreen(self); owner = nil
    }
    private func challenge(_ value: URLAuthenticationChallenge, _ completion: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard session != nil, let owner = owner else { completion(.cancelAuthenticationChallenge, nil); return }
        owner.challenge(value, completion: completion)
    }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) { self.challenge(challenge, completionHandler) }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) { self.challenge(challenge, completionHandler) }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) { handlers.removeValue(forKey: task.taskIdentifier)?.completed(error) }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) { handlers[webSocketTask.taskIdentifier]?.socketOpened() }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
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
    func markTimeout() {
        // A trust failure already recorded on the connection is the real cause;
        // a later deadline must not mask it.
        guard connection.trustFailure == nil else { return }
        if failure == nil { failure = HubNetworkError("native_request_timeout") }
    }
    override func completed(_ error: Error?) {
        deadline?.cancel(); deadline = nil
        do {
            // Precedence: a recorded trust failure, then the deadline (or a
            // response failure recorded before it), then the task's own error.
            if let error = connection.trustFailure ?? failure ?? error { throw error }
            try connection.bindProof(bytes, key: key, nonce: nonce)
            completion(.success(connection))
        } catch { connection.cancelAll(); completion(.failure(error)) }
    }
}
