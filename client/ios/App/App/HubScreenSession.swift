import Foundation

/// Native lifecycle admission is closed synchronously, before IO teardown is
/// queued. A foreground transition never revives an older operation token.
final class HubScreenActivity: @unchecked Sendable {
    private let lock = NSLock()
    private var active = false, generation: UInt64 = 0
    func set(_ value: Bool) {
        lock.lock(); defer { lock.unlock() }
        if active != value { generation &+= 1; active = value }
    }
    func capture() -> UInt64? { lock.lock(); defer { lock.unlock() }; return active ? generation : nil }
    func permits(_ token: UInt64?) -> Bool { lock.lock(); defer { lock.unlock() }; return active && token == generation }
}

/// One screen session owns exactly two pinned tasks. All mutable state is on
/// the transport queue. It never invalidates a shared HubTLSSession.
final class HubScreenSession: @unchecked Sendable {
    private let queue: DispatchQueue, activity: HubScreenActivity, token: UInt64
    private let emit: ([String: Any]) -> Void, failure: (String) -> Void
    private let now: () -> TimeInterval
    private let sessionID: String, generation: String, desktopID: String
    private let quality: String, displayID: String
    private let displayRevision: Int, controlAllowed: Bool
    private var visible = true, inputFocused = false, canControl = false
    private var lastFrame = 0

    private var channels: [HubScreenSocket] = []
    private var connection: HubScreenConnection?
    private var retired = false, nextDelivery = 0
    private var deliveries: [Int: Delivery] = [:]
    private var commands: [String] = [], sendingBytes = 0, sendingCount = 0
    private var stream: [String: Any]?
    private var early: [(value: [String: Any], size: Int)] = [], earlyBytes = 0
    private var timer: DispatchSourceTimer?
    private var started: TimeInterval = 0, nextPing: TimeInterval = 0
    /// The target's flight window: the most frames of one stream generation it keeps
    /// unacknowledged (three by default, up to this many for a viewer that names its
    /// capacity; the page asks for this value through `screenWindow`). A restart (start
    /// control, keyframe, resume) retires them and the next generation may send a full
    /// window while the page still reads the old one's, so superseded packets count only
    /// against the total: one current window plus one superseded window. JSON deliveries
    /// and commands being sent are bounded five beyond the window: a frame-ready and a
    /// receipt per frame, plus state and input. Same names and values as Android.
    static let BINARY_WINDOW = 16, BINARY_RETAINED = 2 * BINARY_WINDOW, PENDING = BINARY_WINDOW + 5
    /// A well-formed renew or input after native has seen control end (the Hub withdrew the
    /// lease, or focus was lost): refused and never forwarded. The page may simply not have
    /// processed that state yet, so this ends control, not the session (as on Android).
    /// screen_input_denied stays the controlled computer's own refusal, never a local one.
    static let controlEnded = "screen_control_ended"
    private final class Delivery {
        let bytes: Data?, size: Int, created: TimeInterval, generation: Int
        var offset = 0, notified = false
        init(_ bytes: Data?, _ size: Int, _ created: TimeInterval, _ generation: Int = 0) { self.bytes = bytes; self.size = size; self.created = created; self.generation = generation }
    }

    init(queue: DispatchQueue, activity: HubScreenActivity, token: UInt64, join: [String: Any],
         now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         emit: @escaping ([String: Any]) -> Void, failure: @escaping (String) -> Void) throws {
        guard let session = join["session"] as? [String: Any],
              let id = session["id"] as? String, Self.identifier(id),
              let generation = session["generation"] as? String, Self.identifier(generation),
              let desktop = session["desktopId"] as? String, Self.identifier(desktop),
              let display = session["display"] as? [String: Any], let displayID = display["id"] as? String, Self.identifier(displayID),
              let displayRevision = Self.integer(display["revision"]), displayRevision > 0, displayRevision <= 0xffffffff,
              let allowed = Self.boolean(session["controlAllowed"]),
              let control = join["controlTicket"] as? String, Self.ticket(control),
              let media = join["mediaTicket"] as? String, Self.ticket(media),
              let expires = Self.integer(join["expiresAt"]), let serverTime = Self.integer(join["serverTime"]),
              expires > serverTime, expires - serverTime <= 30000, control != media,
              ["smooth", "balanced", "qhd", "sharp"].contains(join["quality"] as? String ?? "balanced"),
              join["quality"] == nil || join["quality"] is String,
              JSONSerialization.isValidJSONObject(join), (try JSONSerialization.data(withJSONObject: join)).count <= 16384 else {
            throw HubNetworkError("screen_join_invalid")
        }
        self.queue = queue; self.activity = activity; self.token = token
        self.now = now
        self.sessionID = id; self.generation = generation; self.desktopID = desktop
        self.displayID = displayID; self.displayRevision = displayRevision; self.controlAllowed = allowed
        self.quality = join["quality"] as? String ?? "balanced"; self.emit = emit; self.failure = failure
        try Self.keys(join, "session controlTicket mediaTicket expiresAt serverTime", "quality")
        channels = [HubScreenSocket(role: .control, ticket: control), HubScreenSocket(role: .media, ticket: media)]
        channels.forEach { $0.owner = self }
    }

    private var live: Bool { !retired && activity.permits(token) }
    func open(_ connection: HubTLSSession) throws {
        guard live else { throw HubNetworkError("screen_background") }
        do {
            let native = try connection.screenConnection(control: channels[0], media: channels[1]); self.connection = native
            channels[0].task = native.control; channels[1].task = native.media
            guard live else { throw HubNetworkError("screen_background") }
            // Route proof has its own timeout. Screen attach/ping budgets start
            // only when the two verified WebSocket tasks are resumed.
            started = now(); nextPing = started + 15
            channels.forEach { $0.task?.resume() }
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + 0.25, repeating: 0.25)
            timer.setEventHandler { [weak self] in self?.tick() }; self.timer = timer; timer.resume()
        } catch { retire(); throw error }
    }
    func retire() {
        guard !retired else { return }; retired = true
        timer?.setEventHandler {}; timer?.cancel(); timer = nil
        deliveries.removeAll(); commands.removeAll(); stream = nil; sendingBytes = 0; sendingCount = 0; early.removeAll(); earlyBytes = 0
        for channel in channels { channel.ticket = nil; channel.task?.cancel(); channel.task = nil; channel.owner = nil }
        channels.removeAll(); connection?.cancel(); connection = nil
    }
    private func fail(_ reason: String) { guard !retired else { return }; retire(); failure(reason) }
    fileprivate func opened(_ channel: HubScreenSocket) {
        guard live, let task = channel.task, let ticket = channel.ticket else { fail("screen_background"); return }
        channel.ticket = nil
        task.send(.string("{\"type\":\"hello\",\"ticket\":\"\(ticket)\"}")) { [weak self] error in
            guard let self = self else { return }; self.queue.async { if error != nil { self.closed(channel) } }
        }
        receive(channel)
    }
    fileprivate func closed(_ channel: HubScreenSocket, code: Int? = nil, reason: Data? = nil) {
        // Foundation may complete receive/send before didClose is delivered.
        // The task close properties preserve the peer frame in that ordering.
        let peerReason = Self.hostCloseReason(code ?? channel.task?.closeCode.rawValue ?? 0, reason ?? channel.task?.closeReason)
            ?? channels.lazy.compactMap { Self.hostCloseReason($0.task?.closeCode.rawValue ?? 0, $0.task?.closeReason) }.first
        fail(peerReason ?? "screen_socket_closed")
    }
    /// The Host also ends a screen session when the device's sign-in expires or
    /// is revoked; these exact codes are allowed besides the bounded screen_ form.
    private static let hostAuthReasons: Set<Data> = Set(["session_expired", "device_revoked", "device_revoked_or_expired"].map { Data($0.utf8) })
    private static func hostCloseReason(_ code: Int, _ bytes: Data?) -> String? {
        if code == 4000, let bytes = bytes, hostAuthReasons.contains(bytes) { return String(data: bytes, encoding: .utf8) }
        guard code == 4000, let bytes = bytes, (8...64).contains(bytes.count),
              bytes.starts(with: Data("screen_".utf8)), bytes.dropFirst(7).allSatisfy({ (97...122).contains($0) || $0 == 95 }) else { return nil }
        return String(data: bytes, encoding: .utf8)
    }
    private func receive(_ channel: HubScreenSocket) {
        guard live, let task = channel.task else { fail("screen_background"); return }
        task.receive { [weak self, weak channel] result in
            guard let self = self, let channel = channel else { return }
            self.queue.async {
                guard self.live else { self.fail("screen_background"); return }
                do {
                    switch try result.get() {
                    case .string(let text): try self.text(channel, text)
                    case .data(let bytes): try self.binary(channel, bytes)
                    @unknown default: throw HubNetworkError("screen_protocol_invalid")
                    }
                    if !self.retired { self.receive(channel) }
                } catch {
                    if let error = error as? HubNetworkError { self.fail(error.code) }
                    else { self.closed(channel) }
                }
            }
        }
    }
    private func text(_ channel: HubScreenSocket, _ text: String) throws {
        let bytes = Data(text.utf8)
        guard bytes.count <= 16384, let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let type = value["type"] as? String else { throw HubNetworkError("screen_protocol_invalid") }
        if !channel.attached {
            // Released Hubs (1.5.1 and earlier) notify `state` from attachViewer
            // before the control socket replies `attached`. Only the control socket
            // may hold such states: each fully valid for this session/generation/
            // desktop, at most 4 messages and 16 KiB in total. They do nothing until
            // `attached`, then follow it in arrival order through the same state path,
            // so control grant, delivery budgets and the attach deadline are unchanged.
            if channel.role == .control, type == "state" {
                guard early.count < Self.earlyStateLimit, earlyBytes + bytes.count <= Self.earlyStateBytes else { throw HubNetworkError("screen_attach_invalid") }
                _ = try controlGrant(value)
                early.append((value, bytes.count)); earlyBytes += bytes.count; return
            }
            guard type == "attached", value["sessionId"] as? String == sessionID, value.count == 2 else { throw HubNetworkError("screen_attach_invalid") }
            channel.attached = true
            if channel.role == .control {
                try deliver(value: value, size: bytes.count)
                let held = early; early.removeAll(); earlyBytes = 0
                for state in held { try applyState(state.value); try deliver(value: state.value, size: state.size) }
                flush()
            }
            return
        }
        if channel.role == .media {
            guard type == "stream" else { throw HubNetworkError("screen_protocol_invalid") }
            try validateStream(value)
            // Each stream config names a newer generation than the last (as Android).
            if let last = stream.flatMap({ Self.integer($0["streamGeneration"]) }), let next = Self.integer(value["streamGeneration"]), next <= last { throw HubNetworkError("screen_stream_invalid") }
            stream = value; lastFrame = 0
        } else {
            switch type {
            case "state": try applyState(value)
            case "rtc-frame":
                try Self.keys(value, "type sessionId generation nonce streamGeneration frameSequence captureMs rtpTimestamp")
                guard value["sessionId"] as? String == sessionID, value["generation"] as? String == generation,
                      let nonce = value["nonce"] as? String, Self.ticket(nonce),
                      Self.revision(value["streamGeneration"]), let sequence = Self.integer(value["frameSequence"]), sequence >= 0x80000000,
                      sequence <= 0xffffffff, Self.integer(value["captureMs"]) != nil,
                      let rtpTimestamp = Self.integer(value["rtpTimestamp"]), rtpTimestamp <= 0xffffffff else { throw HubNetworkError("screen_scope_invalid") }
            case "frame-ready":
                guard value["sessionId"] as? String == sessionID, value["generation"] as? String == generation,
                      Self.revision(value["frameSequence"]), Self.revision(value["streamGeneration"]), Self.integer(value["expiresAt"]) != nil else { throw HubNetworkError("screen_scope_invalid") }
                try Self.keys(value, "type sessionId generation streamGeneration frameSequence expiresAt")
            default: throw HubNetworkError("screen_protocol_invalid")
            }
        }
        try deliver(value: value, size: bytes.count)
    }
    private static let earlyStateLimit = 4, earlyStateBytes = 16384
    /// Validates a control `state` for this session and returns the control it grants.
    private func controlGrant(_ value: [String: Any]) throws -> Bool {
        guard let session = value["session"] as? [String: Any], session["id"] as? String == sessionID,
              session["generation"] as? String == generation, session["desktopId"] as? String == desktopID,
              let state = session["state"] as? String, ["connecting", "viewing", "paused", "controlling", "closed"].contains(state),
              Self.integer(value["serverTime"]) != nil else { throw HubNetworkError("screen_scope_invalid") }
        try Self.keys(value, "type session serverTime", "controlPending streamGeneration lease")
        if let pending = value["controlPending"], Self.boolean(pending) == nil { throw HubNetworkError("screen_protocol_invalid") }
        if let revision = value["streamGeneration"], !Self.revision(revision) { throw HubNetworkError("screen_protocol_invalid") }
        if let lease = value["lease"] {
            guard let lease = lease as? [String: Any], let id = lease["id"] as? String, Self.ticket(id),
                  let challenge = lease["challenge"] as? String, Self.ticket(challenge), Self.integer(lease["expiresAt"]) != nil,
                  Self.integer(lease["challengeExpiresAt"]) != nil else { throw HubNetworkError("screen_protocol_invalid") }
            try Self.keys(lease, "id expiresAt challenge challengeExpiresAt")
        }
        return state == "controlling" && value["lease"] != nil && controlAllowed
    }
    private func applyState(_ value: [String: Any]) throws {
        canControl = try controlGrant(value)
        if !canControl { inputFocused = false }
    }
    private func validateSize(_ width: Int, _ height: Int, _ codec: String) throws {
        let edge: Int, area: Int, h264Only: Bool
        switch quality {
        case "sharp": (edge, area, h264Only) = (3072, 3072 * 1920, true)
        case "qhd": (edge, area, h264Only) = (2560, 2560 * 1440, true)
        case "smooth": (edge, area, h264Only) = (1280, 1280 * 800, false)
        default: (edge, area, h264Only) = (1920, 1920 * 1080, false)
        }
        guard width > 0, height > 0, max(width, height) <= edge, width * height <= area,
              !h264Only || codec == "h264",
              ((width + 15) / 16) * ((height + 15) / 16) <= (h264Only ? 36864 : 8192) else { throw HubNetworkError("screen_quality_invalid") }
    }
    private func validateStream(_ value: [String: Any]) throws {
        guard Self.revision(value["streamGeneration"]), Self.revision(value["geometryRevision"]),
              let width = Self.integer(value["width"]), let height = Self.integer(value["height"]), width <= 3072, height <= 3072,
              let codec = value["codec"] as? String, ["h264", "vp8"].contains(codec),
              let codecString = value["codecString"] as? String,
              codec == "h264" ? Self.matches(codecString, "^avc1\\.[0-9a-fA-F]{6}$") : codecString == "vp8",
              let rect = value["contentRect"] as? [String: Any], Self.integer(rect["x"]) == 0, Self.integer(rect["y"]) == 0,
              Self.integer(rect["width"]) == width, Self.integer(rect["height"]) == height else { throw HubNetworkError("screen_stream_invalid") }
        try Self.keys(value, "type streamGeneration geometryRevision codec codecString width height contentRect")
        try Self.keys(rect, "x y width height")
        try validateSize(width, height, codec)
    }
    private func binary(_ channel: HubScreenSocket, _ bytes: Data) throws {
        guard channel.role == .media, channel.attached, bytes.count > 32, bytes.count <= 1048576,
              let stream = stream, bytes[0] == 1, bytes[1] <= 1 else { throw HubNetworkError("screen_packet_invalid") }
        func u16(_ at: Int) -> Int { Int(bytes[at]) | Int(bytes[at + 1]) << 8 }
        func u32(_ at: Int) -> Int { (0..<4).reduce(0) { $0 | Int(bytes[at + $1]) << ($1 * 8) } }
        let stampBits = (0..<8).reduce(UInt64(0)) { $0 | UInt64(bytes[16 + $1]) << ($1 * 8) }, stamp = Double(bitPattern: stampBits)
        let codec = u16(2) == 1 ? "h264" : u16(2) == 2 ? "vp8" : "invalid"
        guard u32(4) > lastFrame, lastFrame != 0 || bytes[1] == 1, u32(8) == Self.integer(stream["geometryRevision"]), u32(12) == Self.integer(stream["streamGeneration"]),
              codec == stream["codec"] as? String, u16(24) == Self.integer(stream["width"]), u16(26) == Self.integer(stream["height"]),
              u32(28) == bytes.count - 32, stamp.isFinite, stamp >= 0, stamp <= 9007199254740991, stamp.rounded(.towardZero) == stamp else { throw HubNetworkError("screen_packet_invalid") }
        // The packet's generation equals the current stream's (checked above).
        let held = deliveries.values.filter { $0.bytes != nil }, generation = u32(12)
        guard held.filter({ $0.generation == generation }).count < Self.BINARY_WINDOW, held.count < Self.BINARY_RETAINED else { throw HubNetworkError("screen_viewer_congested") }
        lastFrame = u32(4)
        nextDelivery += 1; deliveries[nextDelivery] = Delivery(bytes, bytes.count, now(), generation)
        emit(["kind": "binary", "deliverySequence": nextDelivery, "byteLength": bytes.count])
    }
    private func deliver(value: [String: Any], size: Int) throws {
        let json = deliveries.values.filter { $0.bytes == nil }
        guard json.count < Self.PENDING, json.reduce(0, { $0 + $1.size }) + size <= 65536 else { throw HubNetworkError("screen_viewer_congested") }
        nextDelivery += 1; deliveries[nextDelivery] = Delivery(nil, size, now())
        emit(["kind": "screen", "deliverySequence": nextDelivery, "value": value])
    }
    // Called by the plugin immediately before notifying JS, after its main-queue
    // hop. Retired or duplicate queued events never enter the new page/group.
    func markNotified(_ sequence: Int) -> Bool {
        guard live, let delivery = deliveries[sequence], !delivery.notified else { return false }
        delivery.notified = true; return true
    }
    func read(sequence: Int, offset: Int, maxBytes: Int) throws -> Data {
        guard live, let delivery = deliveries[sequence], delivery.notified, let bytes = delivery.bytes,
              offset == delivery.offset, offset < bytes.count, (1...262144).contains(maxBytes) else { throw HubNetworkError("screen_read_invalid") }
        let end = min(bytes.count, offset + maxBytes); delivery.offset = end; return bytes.subdata(in: offset..<end)
    }
    func acknowledge(_ sequence: Int) throws {
        guard live, let delivery = deliveries[sequence], delivery.notified,
              delivery.bytes == nil || delivery.offset == delivery.size else { throw HubNetworkError("screen_receipt_invalid") }
        deliveries.removeValue(forKey: sequence)
    }
    func send(_ command: [String: Any]) throws {
        guard live else { throw HubNetworkError("screen_background") }
        guard let type = command["type"] as? String, command["sessionId"] as? String == sessionID,
              command["generation"] as? String == generation, JSONSerialization.isValidJSONObject(command) else { throw HubNetworkError("screen_scope_invalid") }
        switch type {
        case "input-focus":
            try Self.keys(command, "type sessionId generation enabled")
            guard let enabled = Self.boolean(command["enabled"]) else { throw HubNetworkError("screen_command_invalid") }
            inputFocused = enabled && visible && canControl; return
        case "visibility":
            try Self.keys(command, "type sessionId generation visible")
            guard let value = Self.boolean(command["visible"]) else { throw HubNetworkError("screen_command_invalid") }
            visible = value
            if !visible { fail("screen_inactive"); return }
        case "control":
            try Self.keys(command, "type sessionId generation frameSequence")
            guard controlAllowed, visible, Self.revision(command["frameSequence"]) else { throw HubNetworkError("screen_command_invalid") }
        case "renew":
            // Shape first: a malformed command stays a protocol error.
            try Self.keys(command, "type sessionId generation leaseId frameSequence challenge")
            guard Self.revision(command["frameSequence"]), let lease = command["leaseId"] as? String, Self.ticket(lease),
                  let challenge = command["challenge"] as? String, Self.ticket(challenge) else { throw HubNetworkError("screen_command_invalid") }
            guard canControl, inputFocused, visible else { throw HubNetworkError(Self.controlEnded) }
        case "input":
            try validateInput(command)
            guard canControl, inputFocused, visible else { throw HubNetworkError(Self.controlEnded) }
        case "ack":
            // `heldMs`: how long the page held the frame, from a viewer that named its capacity.
            try Self.keys(command, "type sessionId generation frameSequence", "heldMs")
            guard Self.revision(command["frameSequence"]) else { throw HubNetworkError("screen_command_invalid") }
            if command["heldMs"] != nil { guard let held = Self.integer(command["heldMs"]), held <= 2000 else { throw HubNetworkError("screen_command_invalid") } }
        case "release", "disconnect", "keyframe":
            try Self.keys(command, "type sessionId generation")
            if type != "keyframe" { inputFocused = false; canControl = false }
        default: throw HubNetworkError("screen_command_invalid")
        }
        let bytes = try JSONSerialization.data(withJSONObject: command)
        guard bytes.count <= 16384, sendingBytes + bytes.count <= 16384, sendingCount < Self.PENDING,
              let text = String(data: bytes, encoding: .utf8) else { fail("screen_viewer_congested"); throw HubNetworkError("screen_viewer_congested") }
        commands.append(text); sendingBytes += bytes.count; sendingCount += 1; flush()
    }
    private func validateInput(_ command: [String: Any]) throws {
        try Self.keys(command, "type sessionId desktopId generation displayId displayRevision leaseId sequence frameSequence expiresAt event")
        guard command["desktopId"] as? String == desktopID, command["displayId"] as? String == displayID,
              Self.integer(command["displayRevision"]) == displayRevision, Self.revision(command["sequence"]), Self.revision(command["frameSequence"]),
              Self.integer(command["expiresAt"]) != nil, let lease = command["leaseId"] as? String, Self.ticket(lease),
              let event = command["event"] as? [String: Any], let kind = event["kind"] as? String else { throw HubNetworkError("screen_command_invalid") }
        switch kind {
        case "move", "button", "wheel":
            try Self.keys(event, kind == "move" ? "kind x y" : kind == "button" ? "kind x y button down clicks" : "kind x y dx dy")
            guard Self.number(event["x"], 0, 1), Self.number(event["y"], 0, 1) else { throw HubNetworkError("screen_command_invalid") }
            if kind == "button" {
                guard let button = Self.integer(event["button"]), (0...2).contains(button), let clicks = Self.integer(event["clicks"]),
                      (1...3).contains(clicks), Self.boolean(event["down"]) != nil else { throw HubNetworkError("screen_command_invalid") }
            }
            if kind == "wheel", !Self.number(event["dx"], -2000, 2000) || !Self.number(event["dy"], -2000, 2000) { throw HubNetworkError("screen_command_invalid") }
        case "key":
            try Self.keys(event, "kind code down")
            guard let code = event["code"] as? String, Self.matches(code, "^[A-Za-z0-9]{1,32}$"), Self.boolean(event["down"]) != nil else { throw HubNetworkError("screen_command_invalid") }
        case "text":
            try Self.keys(event, "kind text")
            guard let text = event["text"] as? String, !text.isEmpty, text.utf16.count <= 2048,
                  !text.unicodeScalars.contains(where: { $0.value < 32 && ![9, 10, 13].contains($0.value) || $0.value == 127 }) else { throw HubNetworkError("screen_command_invalid") }
        default: throw HubNetworkError("screen_command_invalid")
        }
    }
    private func flush() {
        guard live, let channel = channels.first, channel.attached, let task = channel.task else { return }
        let pending = commands; commands.removeAll()
        for text in pending {
            guard live else { fail("screen_background"); return }
            task.send(.string(text)) { [weak self] error in
                guard let self = self else { return }; self.queue.async {
                    guard !self.retired else { return }
                    self.sendingCount -= 1; self.sendingBytes -= text.utf8.count
                    if error != nil { self.closed(channel) }
                }
            }
        }
    }
    private func tick() {
        guard live else { fail("screen_background"); return }
        let now = self.now()
        if channels.contains(where: { !$0.attached }), now - started >= 5 { fail("screen_attach_timeout"); return }
        if deliveries.values.contains(where: { now - $0.created >= 2 }) { fail("screen_viewer_congested"); return }
        if channels.contains(where: { $0.pingAt.map { now - $0 >= 10 } ?? false }) { fail("screen_socket_timeout"); return }
        if now >= nextPing {
            nextPing = now + 15
            for channel in channels where channel.attached {
                channel.pingAt = now
                channel.task?.sendPing { [weak self, weak channel] error in
                    guard let self = self, let channel = channel else { return }; self.queue.async {
                        guard !self.retired else { return }; channel.pingAt = nil
                        if error != nil { self.closed(channel) }
                    }
                }
            }
        }
    }
    private static func keys(_ value: [String: Any], _ required: String, _ optional: String = "") throws {
        let required = Set(required.split(separator: " ").map(String.init)), allowed = required.union(optional.split(separator: " ").map(String.init))
        guard required.isSubset(of: Set(value.keys)), Set(value.keys).isSubset(of: allowed) else { throw HubNetworkError("screen_protocol_invalid") }
    }
    private static func boolean(_ value: Any?) -> Bool? {
        guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }; return n.boolValue
    }
    private static func number(_ value: Any?, _ min: Double, _ max: Double) -> Bool {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return false }; return n.doubleValue.isFinite && n.doubleValue >= min && n.doubleValue <= max
    }
    private static func matches(_ text: String, _ pattern: String) -> Bool { text.range(of: pattern, options: .regularExpression) != nil }
    private static func identifier(_ text: String) -> Bool { text.utf8.count <= 128 && matches(text, "^[A-Za-z0-9_-]+$") }
    private static func ticket(_ text: String) -> Bool { matches(text, "^[A-Za-z0-9_-]{43}$") }
    private static func revision(_ value: Any?) -> Bool { guard let n = integer(value) else { return false }; return n > 0 && n <= 0xffffffff }
    private static func integer(_ value: Any?) -> Int? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
              n.doubleValue >= 0, n.doubleValue <= 9007199254740991, n.doubleValue.rounded(.towardZero) == n.doubleValue else { return nil }; return n.intValue
    }
}

private final class HubScreenSocket: HubTaskHandler {
    let role: HubScreenRole
    weak var owner: HubScreenSession?
    var task: URLSessionWebSocketTask?, ticket: String?, attached = false, pingAt: TimeInterval?
    init(role: HubScreenRole, ticket: String) { self.role = role; self.ticket = ticket }
    override func socketOpened() { owner?.opened(self) }
    override func socketClosed(_ code: Int, reason: Data?) { owner?.closed(self, code: code, reason: reason) }
    override func completed(_ error: Error?) { owner?.closed(self) }
}
