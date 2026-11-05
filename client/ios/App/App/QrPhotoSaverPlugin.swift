import Capacitor
import Photos
import UIKit

/// Saves only a validated TaroBot connection QR PNG to Photos, with add-only
/// access. Resolves after Photos accepts the asset; denial and failure reject.
@objc(QrPhotoSaverPlugin)
public final class QrPhotoSaverPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "QrPhotoSaverPlugin"
    public let jsName = "TaroBotQrPhotos"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise)]
    static let maxBytes = 512 * 1024

    /// Same contract as Android's QrPhotoImage: fixed name, bounded PNG.
    static func validated(data: String?, name: String?) -> (Data, String)? {
        guard let name, name.range(of: #"^TaroBot-QR-[0-9]{8}-[0-9]{6}\.png$"#, options: .regularExpression) != nil,
              let data, !data.isEmpty, data.count <= (maxBytes + 2) / 3 * 4,
              let bytes = Data(base64Encoded: data), bytes.count >= 33, bytes.count <= maxBytes,
              bytes.prefix(8) == Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
              bytes.subdata(in: 12..<16) == Data("IHDR".utf8) else { return nil }
        return (bytes, name)
    }

    @objc func save(_ call: CAPPluginCall) {
        guard let (bytes, name) = Self.validated(data: call.getString("data"), name: call.getString("name")) else {
            call.reject("photos_image_invalid"); return
        }
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else { call.reject("photos_permission_denied"); return }
            PHPhotoLibrary.shared().performChanges({
                let options = PHAssetResourceCreationOptions()
                options.originalFilename = name
                PHAssetCreationRequest.forAsset().addResource(with: .photo, data: bytes, options: options)
            }) { saved, _ in
                if saved { call.resolve(["saved": true]) } else { call.reject("photos_save_failed") }
            }
        }
    }
}
