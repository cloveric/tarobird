import Foundation

/// Shared by the containing app and its Share extension. No device keys enter this container.
final class ShareInboxStore {
    static let group = "group.com.tarobot.client"
    static let defaultMaxBytes = 512 * 1024 * 1024
    // Cached public policy, never credentials. The Hub remains authoritative.
    var maxBytes: Int {
        guard let data = try? Data(contentsOf: root.appendingPathComponent(".limits.json")),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let limit = value["maxFileBytes"] as? Int, limit > 0, limit <= 9007199254740991 else { return Self.defaultMaxBytes }
        return limit
    }
    func setMaxFileBytes(_ value: Int) throws {
        guard value > 0, value <= 9007199254740991 else { throw failure("share_limit_invalid") }
        try JSONSerialization.data(withJSONObject: ["maxFileBytes": value]).write(to: root.appendingPathComponent(".limits.json"), options: .atomic)
    }
    private let root: URL
    private let fm = FileManager.default
    init(root: URL? = nil) throws {
        guard let base = root ?? FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.group)?.appendingPathComponent("share-inbox", isDirectory: true) else { throw NSError(domain: "TaroCubShare", code: 1, userInfo: [NSLocalizedDescriptionKey: "share_app_group_unavailable"]) }
        self.root = base
        try fm.createDirectory(at: base, withIntermediateDirectories: true)
        var excluded = URLResourceValues(); excluded.isExcludedFromBackup = true
        var mutable = base; try mutable.setResourceValues(excluded)
    }
    func failure(_ message: String) -> NSError { NSError(domain: "TaroCubShare", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    func directory(_ id: String) throws -> URL {
        guard UUID(uuidString: id) != nil, !id.contains("/"), id.count == 36 else { throw failure("share_id_invalid") }
        return root.appendingPathComponent(id, isDirectory: true)
    }
    func list() throws -> [[String: Any]] {
        var items = [[String: Any]]()
        for url in try fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.creationDateKey], options: .skipsHiddenFiles) {
            let created = try url.resourceValues(forKeys: [.creationDateKey]).creationDate ?? .distantPast
            if created.timeIntervalSinceNow < -86400 { try fm.removeItem(at: url); continue }
            if let item = try? read(url.lastPathComponent) { items.append(item) }
        }
        return items.sorted { ($0["createdAt"] as? Double ?? 0) < ($1["createdAt"] as? Double ?? 0) }
    }
    func create() throws -> String {
        guard try list().count < 16 else { throw failure("share_inbox_full") }
        let id = UUID().uuidString.lowercased(); try fm.createDirectory(at: directory(id), withIntermediateDirectories: false)
        return id
    }
    func read(_ id: String) throws -> [String: Any] {
        let url = try directory(id).appendingPathComponent("item.json")
        guard let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 1024 * 1024 else { throw failure("share_item_invalid") }
        guard let value = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any], value["id"] as? String == id else { throw failure("share_item_invalid") }
        return value
    }
    func write(_ id: String, _ value: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: value)
        guard data.count <= 1024 * 1024 else { throw failure("share_item_invalid") }
        let url = try directory(id).appendingPathComponent("item.json")
        try data.write(to: url, options: .atomic)
        #if os(iOS)
        try fm.setAttributes([.protectionKey: FileProtectionType.completeUnlessOpen], ofItemAtPath: url.path)
        #endif
    }
    func prepare(_ id: String, delivery: [String: Any]) throws -> [String: Any] {
        var item = try read(id)
        guard let text = delivery["text"] as? String, text.utf8.count <= 200 * 1024,
              let hub = delivery["hubKey"] as? String, !hub.isEmpty, hub.count <= 512,
              let device = delivery["deviceId"] as? String, device.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil,
              let conversation = delivery["conversationId"] as? String, conversation.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil else { throw failure("share_delivery_invalid") }
        // Pin only known fields. mentions is optional (direct and legacy pins have none); an existing pin is never rewritten.
        var pinned: [String: Any] = ["hubKey": hub, "deviceId": device, "conversationId": conversation, "text": text]
        if let value = delivery["mentions"] {
            guard let mentions = value as? [String], (1...64).contains(mentions.count),
                  mentions.allSatisfy({ $0.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil }) else { throw failure("share_delivery_invalid") }
            pinned["mentions"] = mentions
        }
        if item["delivery"] == nil { item["delivery"] = pinned; try write(id, item) }
        return item
    }
    func copyFile(_ source: URL, id: String, index: Int, name: String, mime: String, remaining: Int) throws -> [String: Any] {
        guard source.isFileURL, index >= 0, index < 64, remaining > 0,
              let size = try source.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]).fileSize,
              try source.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true,
              size > 0, size <= min(maxBytes, remaining) else { throw failure("share_file_invalid_or_too_large") }
        var used = 0
        if let enumerator = fm.enumerator(at: root, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey]) {
            for case let file as URL in enumerator { let values = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]); if values.isRegularFile == true { used += values.fileSize ?? 0 } }
        }
        guard used + size <= 2 * maxBytes else { throw failure("share_inbox_full") }
        let target = try directory(id).appendingPathComponent(String(index))
        guard let input = InputStream(url: source), let output = OutputStream(url: target, append: false) else { throw failure("share_file_unavailable") }
        input.open(); output.open(); defer { input.close(); output.close() }
        var buffer = [UInt8](repeating: 0, count: 64 * 1024); var written = 0
        while true {
            let count = input.read(&buffer, maxLength: buffer.count)
            if count == 0 { break }; guard count > 0 else { throw failure("share_read_failed") }
            written += count; guard written <= size else { throw failure("share_file_changed") }
            try buffer.withUnsafeBufferPointer { ptr in
                var offset = 0
                while offset < count { let n = output.write(ptr.baseAddress!.advanced(by: offset), maxLength: count - offset); guard n > 0 else { throw failure("share_write_failed") }; offset += n }
            }
        }
        guard written == size else { throw failure("share_file_changed") }
        #if os(iOS)
        try fm.setAttributes([.protectionKey: FileProtectionType.completeUnlessOpen], ofItemAtPath: target.path)
        #endif
        let safeName = String(name.replacingOccurrences(of: "[\\\\/\\p{Cc}]", with: "_", options: .regularExpression).prefix(255))
        return ["name": safeName.isEmpty || safeName == "." || safeName == ".." ? "shared-file" : safeName, "type": String(mime.prefix(200)), "size": size]
    }
    func chunk(_ id: String, index: Int, offset: Int, length: Int) throws -> String {
        let item = try read(id)
        guard let files = item["files"] as? [[String: Any]], index >= 0, index < files.count, let size = files[index]["size"] as? Int,
              offset >= 0, length > 0, length <= 1024 * 1024, offset <= size, length <= size - offset else { throw failure("share_chunk_invalid") }
        let handle = try FileHandle(forReadingFrom: directory(id).appendingPathComponent(String(index))); defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset)); let data = try handle.read(upToCount: length) ?? Data()
        guard data.count == length else { throw failure("share_file_changed") }; return data.base64EncodedString()
    }
    func remove(_ id: String) throws { let url = try directory(id); if fm.fileExists(atPath: url.path) { try fm.removeItem(at: url) } }
    func clear() throws { for url in try fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) { try fm.removeItem(at: url) } }
}
