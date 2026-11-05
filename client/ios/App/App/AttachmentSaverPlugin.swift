import Capacitor
import UIKit

@objc(AttachmentSaverPlugin)
public class AttachmentSaverPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "AttachmentSaverPlugin"
    public let jsName = "TaroBotAttachmentSaver"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise)]
    private var pending: CAPPluginCall?

    @objc func save(_ call: CAPPluginCall) {
        guard let raw = call.getString("uri"), let url = URL(string: raw), url.isFileURL,
              url.host == nil || url.host == "" || url.host == "localhost",
              let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            call.reject("attachment_save_failed"); return
        }
        let file = url.resolvingSymlinksInPath().standardizedFileURL
        let folder = file.deletingLastPathComponent()
        let root = cache.appendingPathComponent("tarocub-exports").resolvingSymlinksInPath().standardizedFileURL
        guard folder.deletingLastPathComponent().path == root.path,
              folder.lastPathComponent.range(of: "^[0-9]+-[0-9a-f-]+$", options: .regularExpression) != nil,
              (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else {
            call.reject("attachment_save_failed"); return
        }
        DispatchQueue.main.async {
            guard self.pending == nil, let presenter = self.bridge?.viewController, presenter.presentedViewController == nil else {
                call.reject("attachment_save_busy"); return
            }
            let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
            picker.delegate = self
            self.pending = call
            presenter.present(picker, animated: true)
        }
    }
    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let call = pending; pending = nil
        if urls.isEmpty { call?.reject("attachment_save_unconfirmed") }
        else { call?.resolve(["saved": true]) }
    }
    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        let call = pending; pending = nil; call?.resolve(["saved": false])
    }
}
