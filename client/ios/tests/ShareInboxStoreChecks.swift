import Foundation

@main struct ShareInboxStoreChecks {
    static func main() throws {
        let fm = FileManager.default
        let temporary = fm.temporaryDirectory.appendingPathComponent("tarocub-share-test-\(UUID())")
        try fm.createDirectory(at: temporary, withIntermediateDirectories: true); defer { try? fm.removeItem(at: temporary) }
        let store = try ShareInboxStore(root: temporary.appendingPathComponent("inbox"))
        let id = try store.create(); let source = temporary.appendingPathComponent("fixture.txt")
        let bytes = Data(repeating: 65, count: 2 * 1024 * 1024 + 13); try bytes.write(to: source)
        let file = try store.copyFile(source, id: id, index: 0, name: "../a.txt", mime: "text/plain", remaining: store.maxBytes)
        precondition(file["name"] as? String == ".._a.txt")
        try store.write(id, ["id": id, "createdAt": Date().timeIntervalSince1970 * 1000, "text": "hello", "files": [file]])
        let delivery: [String: Any] = ["hubKey": "hub", "deviceId": "device_one", "conversationId": "conv_one", "text": "hello"]
        _ = try store.prepare(id, delivery: delivery)
        var changed = delivery; changed["conversationId"] = "conv_other"
        let pinned = try store.prepare(id, delivery: changed)
        precondition((pinned["delivery"] as? [String: Any])?["conversationId"] as? String == "conv_one")
        let restored = try ShareInboxStore(root: temporary.appendingPathComponent("inbox"))
        let savedItems = try restored.list(); precondition(savedItems.count == 1)
        let chunk = try restored.chunk(id, index: 0, offset: 1048576, length: 1048576)
        precondition(Data(base64Encoded: chunk) == bytes.subdata(in: 1048576..<2097152))
        func reject(_ block: () throws -> Void) { do { try block(); fatalError("Expected rejection") } catch {} }
        reject { _ = try store.directory("../../secrets") }
        reject { _ = try store.chunk(id, index: 1, offset: 0, length: 1) }
        reject { _ = try store.chunk(id, index: 0, offset: -1, length: 1) }
        reject { _ = try store.chunk(id, index: 0, offset: 0, length: 1048577) }
        reject { _ = try store.chunk(id, index: 0, offset: bytes.count, length: 1) }
        reject { _ = try store.copyFile(source, id: id, index: 1, name: "x", mime: "text/plain", remaining: 1) }
        reject { _ = try store.copyFile(temporary, id: id, index: 1, name: "x", mime: "text/plain", remaining: store.maxBytes) }
        // Group shares pin reply Bots by value; neither a pinned nor a legacy (mention-less) share gains or swaps them.
        let group = try store.create(); try store.write(group, ["id": group, "createdAt": Date().timeIntervalSince1970 * 1000, "text": "hello", "files": [[String: Any]]()])
        var mentioned = delivery; mentioned["mentions"] = ["bot_alpha", "bot_beta"]; mentioned["extra"] = "dropped"
        let groupPin = try store.prepare(group, delivery: mentioned)["delivery"] as? [String: Any]
        precondition(groupPin?["mentions"] as? [String] == ["bot_alpha", "bot_beta"] && groupPin?["extra"] == nil)
        var swapped = mentioned; swapped["mentions"] = ["bot_beta"]
        let keptPin = try restored.prepare(group, delivery: swapped)["delivery"] as? [String: Any]
        precondition(keptPin?["mentions"] as? [String] == ["bot_alpha", "bot_beta"])
        let legacyPin = try store.prepare(id, delivery: mentioned)["delivery"] as? [String: Any]
        precondition(legacyPin?["conversationId"] as? String == "conv_one" && legacyPin?["mentions"] == nil)
        for invalid in [[String](), ["../bot"], Array(repeating: "bot", count: 65)] { var bad = delivery; bad["mentions"] = invalid; reject { _ = try store.prepare(group, delivery: bad) } }
        var scalar = delivery; scalar["mentions"] = "bot_alpha"; reject { _ = try store.prepare(group, delivery: scalar) }
        try store.remove(group)
        try store.remove(id); try store.remove(id)
        let emptyItems = try restored.list(); precondition(emptyItems.isEmpty)
        try store.setMaxFileBytes(1024)
        precondition(restored.maxBytes == 1024)
        reject { _ = try restored.copyFile(source, id: try restored.create(), index: 0, name: "x", mime: "text/plain", remaining: bytes.count) }
        reject { try store.setMaxFileBytes(0) }; reject { try store.setMaxFileBytes(9007199254740992) }
        try store.setMaxFileBytes(1024 * 1024 * 1024); precondition(restored.maxBytes == 1024 * 1024 * 1024)
        let next = try restored.create()
        _ = try restored.copyFile(source, id: next, index: 0, name: "x", mime: "text/plain", remaining: restored.maxBytes)
        try restored.clear(); precondition(store.maxBytes == ShareInboxStore.defaultMaxBytes)
        print("Share inbox native storage checks passed (copy, persistence, pinned destination and mentions, chunk bounds, limits, deletion)")
    }
}
