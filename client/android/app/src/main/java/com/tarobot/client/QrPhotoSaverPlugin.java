package com.tarobot.client;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Saves only a validated connection QR into Pictures/TaroBot. Android 10+
 * uses MediaStore without a permission; Android 7-9 ask for the legacy storage
 * write permission, declared only up to API 28. Resolves only after the image is
 * written; a denial or failure rejects. */
@CapacitorPlugin(name = "TaroBotQrPhotos", permissions = { @Permission(alias = "legacyStorage", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }) })
public final class QrPhotoSaverPlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    @PluginMethod public void save(PluginCall call) {
        final QrPhotoImage image;
        try { image = QrPhotoImage.parse(call.getString("data"), call.getString("name")); }
        catch (IllegalArgumentException invalid) { call.reject(invalid.getMessage()); return; }
        if (Build.VERSION.SDK_INT < 29 && getPermissionState("legacyStorage") != PermissionState.GRANTED) {
            requestPermissionForAlias("legacyStorage", call, "legacyStorageResult");
            return;
        }
        write(call, image);
    }

    @PermissionCallback private void legacyStorageResult(PluginCall call) {
        if (getPermissionState("legacyStorage") != PermissionState.GRANTED) { call.reject("photos_permission_denied"); return; }
        try { write(call, QrPhotoImage.parse(call.getString("data"), call.getString("name"))); }
        catch (IllegalArgumentException invalid) { call.reject(invalid.getMessage()); }
    }

    private void write(PluginCall call, QrPhotoImage image) {
        io.execute(() -> {
            try {
                if (Build.VERSION.SDK_INT >= 29) writeMediaStore(image); else writeLegacy(image);
                call.resolve(new JSObject().put("saved", true));
            } catch (Exception failed) { call.reject("photos_save_failed"); }
        });
    }

    private void writeMediaStore(QrPhotoImage image) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, image.name);
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
        values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/TaroBot");
        values.put(MediaStore.Images.Media.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values);
        if (uri == null) throw new IOException("photos_save_failed");
        try {
            try (OutputStream out = resolver.openOutputStream(uri)) {
                if (out == null) throw new IOException("photos_save_failed");
                out.write(image.bytes);
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.Images.Media.IS_PENDING, 0);
            if (resolver.update(uri, done, null, null) != 1) throw new IOException("photos_save_failed");
        } catch (IOException | RuntimeException failed) {
            // Never leave a pending partial image behind a failed receipt.
            resolver.delete(uri, null, null);
            throw failed;
        }
    }

    @SuppressWarnings("deprecation")
    private void writeLegacy(QrPhotoImage image) throws IOException {
        File directory = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "TaroBot");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("photos_save_failed");
        File file = new File(directory, image.name);
        for (int copy = 2; !file.createNewFile(); copy++) {
            if (copy > 99) throw new IOException("photos_save_failed");
            file = new File(directory, image.name.replace(".png", "-" + copy + ".png"));
        }
        try (FileOutputStream out = new FileOutputStream(file)) { out.write(image.bytes); out.getFD().sync(); }
        catch (IOException failed) { file.delete(); throw failed; }
        MediaScannerConnection.scanFile(getContext(), new String[] { file.getAbsolutePath() }, new String[] { "image/png" }, null);
    }
}
