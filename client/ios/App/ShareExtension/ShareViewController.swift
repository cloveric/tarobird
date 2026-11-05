import UIKit
import UniformTypeIdentifiers

/// The extension only saves an inbox draft. It never authenticates to a Hub or starts an engine.
final class ShareViewController: UIViewController {
    private let textView = UITextView()
    private let status = UILabel()
    private let save = UIButton(type: .system)
    private let cancel = UIButton(type: .system)
    private var task: Task<Void, Never>?
    private var chinese: Bool { Locale.preferredLanguages.first?.hasPrefix("zh") == true }
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        let title = UILabel(); title.text = "TaroBird"; title.font = .preferredFont(forTextStyle: .title2)
        status.text = chinese ? "保存后打开 TaroBird，选择会话并确认发送。" : "Save, then open TaroBird to choose a conversation and send."
        status.numberOfLines = 0; status.font = .preferredFont(forTextStyle: .body)
        textView.font = .preferredFont(forTextStyle: .body); textView.backgroundColor = .secondarySystemBackground
        textView.accessibilityLabel = chinese ? "附加说明" : "Add a note"
        save.setTitle(chinese ? "保存分享" : "Save share", for: .normal); save.addTarget(self, action: #selector(storeShare), for: .touchUpInside)
        cancel.setTitle(chinese ? "取消" : "Cancel", for: .normal); cancel.addTarget(self, action: #selector(cancelShare), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [title, status, textView, save, cancel]); stack.axis = .vertical; stack.spacing = 18; stack.translatesAutoresizingMaskIntoConstraints = false
        // Sharing remains reachable in a short split window and while editing
        // the note. The current scene's guides follow folds and keyboard moves.
        let scroll = UIScrollView(); scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.keyboardDismissMode = .interactive
        scroll.contentInsetAdjustmentBehavior = .never // The frame already owns the safe area.
        view.addSubview(scroll); scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48),
            textView.heightAnchor.constraint(equalToConstant: 120),
        ])
    }
    @objc private func cancelShare() { task?.cancel(); extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError)) }
    @objc private func storeShare() {
        guard task == nil else { return }; save.isEnabled = false; cancel.isEnabled = false; textView.isEditable = false
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []; let note = textView.text ?? ""
        task = Task { [weak self] in
            guard let self else { return }
            var store: ShareInboxStore?; var id: String?
            do {
                let inbox = try ShareInboxStore(); store = inbox; let draftID = try inbox.create(); id = draftID
                var texts = note.isEmpty ? [] : [note]; var files = [[String: Any]](); var total = 0
                let providers = items.flatMap { $0.attachments ?? [] }
                guard providers.count <= 64 else { throw inbox.failure("share_too_many_files") }
                for item in items { if let value = item.attributedContentText?.string, !value.isEmpty, !texts.contains(value) { texts.append(value) } }
                for provider in providers {
                    try Task.checkCancellation()
                    if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                        let file = try await copyURL(provider, store: inbox, id: draftID, index: files.count, remaining: inbox.maxBytes - total)
                        total += file["size"] as? Int ?? 0; files.append(file); continue
                    }
                    if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                        let value = try await loadItem(provider, type: UTType.url.identifier)
                        if let url = value as? URL, !url.isFileURL { if !texts.contains(url.absoluteString) { texts.append(url.absoluteString) }; continue }
                    }
                    if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) && !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                        let value = try await loadItem(provider, type: UTType.plainText.identifier)
                        if let string = value as? String { if !texts.contains(string) { texts.append(string) }; continue }
                    }
                    guard let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .data) == true && $0 != UTType.fileURL.identifier }) else { throw inbox.failure("share_type_unsupported") }
                    let file = try await copyFile(provider, type: type, store: inbox, id: draftID, index: files.count, remaining: inbox.maxBytes - total)
                    total += file["size"] as? Int ?? 0; files.append(file)
                }
                let text = texts.joined(separator: "\n\n")
                guard text.utf8.count <= 200 * 1024, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty else { throw inbox.failure("share_empty_or_too_large") }
                try inbox.write(draftID, ["id": draftID, "createdAt": Date().timeIntervalSince1970 * 1000, "text": text, "files": files])
                status.text = chinese ? "已保存。打开 TaroBird 完成发送。" : "Saved. Open TaroBird to finish sending."
                save.setTitle(chinese ? "完成" : "Done", for: .normal); save.removeTarget(self, action: #selector(storeShare), for: .touchUpInside); save.addTarget(self, action: #selector(finish), for: .touchUpInside); save.isEnabled = true
            } catch {
                if let store, let id { try? store.remove(id) }
                status.text = error.localizedDescription; save.isEnabled = true; cancel.isEnabled = true; textView.isEditable = true; task = nil
            }
        }
    }
    @objc private func finish() { extensionContext?.completeRequest(returningItems: nil) }
    private func loadItem(_ provider: NSItemProvider, type: String) async throws -> NSSecureCoding {
        try await withCheckedThrowingContinuation { continuation in provider.loadItem(forTypeIdentifier: type, options: nil) { value, error in
            if let value { continuation.resume(returning: value) } else { continuation.resume(throwing: error ?? NSError(domain: "TaroCubShare", code: 1)) }
        } }
    }
    private func copyFile(_ provider: NSItemProvider, type: String, store: ShareInboxStore, id: String, index: Int, remaining: Int) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { continuation in provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
            // The temporary URL is valid only for this callback: copy before resuming.
            guard let url else { continuation.resume(throwing: error ?? store.failure("share_file_unavailable")); return }
            do { continuation.resume(returning: try store.copyFile(url, id: id, index: index, name: provider.suggestedName ?? url.lastPathComponent, mime: UTType(type)?.preferredMIMEType ?? "application/octet-stream", remaining: remaining)) }
            catch { continuation.resume(throwing: error) }
        } }
    }
    private func copyURL(_ provider: NSItemProvider, store: ShareInboxStore, id: String, index: Int, remaining: Int) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { continuation in provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { value, error in
            guard let url = value as? URL, url.isFileURL else { continuation.resume(throwing: error ?? store.failure("share_file_unavailable")); return }
            let scoped = url.startAccessingSecurityScopedResource(); defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do { continuation.resume(returning: try store.copyFile(url, id: id, index: index, name: url.lastPathComponent, mime: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream", remaining: remaining)) }
            catch { continuation.resume(throwing: error) }
        } }
    }
}
