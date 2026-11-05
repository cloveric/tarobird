package com.tarobot.client;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ConcurrentHashMap;

/** Saves a validated cache copy into user-owned storage, without a share intent
 * or broad storage permission. Pre-Android 10 uses the system save picker. */
@CapacitorPlugin(name = "TaroBotAttachmentSaver")
public final class AttachmentSaverPlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    // Only completed saves or validated private receipts grant an open. Never
    // turn a display path, filename match or arbitrary caller URI into a grant.
    private final ConcurrentHashMap<String, String> savedTypes = new ConcurrentHashMap<>();
    private SharedPreferences savedReceipts() {
        return getContext().getSharedPreferences("tarobot_saved_attachments_v1", Context.MODE_PRIVATE);
    }
    private String receiptKey(PluginCall call) {
        String key = call.getString("key");
        if (key != null && !key.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("attachment_saved_key_invalid");
        return key;
    }
    private JSObject response(Uri uri, String mime, String location) {
        savedTypes.put(uri.toString(), mime);
        JSObject result = new JSObject().put("saved", true).put("uri", uri.toString());
        if (location != null) result.put("location", location);
        return result;
    }
    private JSObject receipt(PluginCall call, Uri uri, String mime, String location, long size, boolean persistent) throws Exception {
        String key = receiptKey(call);
        if (key != null && persistent) {
            JSONObject record = new JSONObject().put("version", 1).put("uri", uri.toString()).put("mime", mime).put("size", size);
            if (location != null) record.put("location", location);
            if (!savedReceipts().edit().putString(key, record.toString()).commit()) throw new IOException("attachment_receipt_failed");
        }
        return response(uri, mime, location);
    }
    /** Read metadata only for this exact paired-host/device/attachment key.
     * A restored record is checked against the actual local file before use. */
    @PluginMethod public void getSaved(PluginCall call) {
        final String key;
        try { key = receiptKey(call); if (key == null) throw new IllegalArgumentException(); }
        catch (Exception error) { call.reject("attachment_saved_key_invalid"); return; }
        io.execute(() -> {
            String raw = savedReceipts().getString(key, null);
            if (raw == null) { call.resolve(new JSObject().put("saved", false)); return; }
            Uri uri;
            String mime, location;
            long size;
            try {
                JSONObject record = new JSONObject(raw);
                uri = Uri.parse(record.getString("uri")); mime = record.getString("mime"); size = record.getLong("size");
                location = record.has("location") ? record.getString("location") : null;
                if (record.getInt("version") != 1 || !"content".equals(uri.getScheme()) || size < 0
                        || !mime.matches("[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+")) throw new IllegalArgumentException();
            } catch (Exception invalid) {
                savedReceipts().edit().remove(key).commit(); call.resolve(new JSObject().put("saved", false)); return;
            }
            try (var descriptor = getContext().getContentResolver().openFileDescriptor(uri, "r")) {
                if (descriptor == null || descriptor.getStatSize() >= 0 && descriptor.getStatSize() != size) throw new FileNotFoundException();
                call.resolve(response(uri, mime, location));
            } catch (FileNotFoundException | SecurityException missing) {
                savedTypes.remove(uri.toString()); savedReceipts().edit().remove(key).commit();
                call.resolve(new JSObject().put("saved", false));
            } catch (Exception error) { call.reject("attachment_saved_check_failed"); }
        });
    }
    private File source(PluginCall call) throws Exception {
        Uri uri = Uri.parse(call.getString("uri", ""));
        if (!"file".equals(uri.getScheme()) || uri.getPath() == null || uri.getAuthority() != null && !uri.getAuthority().isEmpty()) throw new IllegalArgumentException();
        return AttachmentOpenPolicy.exportFile(getContext().getCacheDir(), uri.getPath());
    }
    @PluginMethod public void save(PluginCall call) {
        try {
            receiptKey(call);
            File file = source(call);
            String mime = AttachmentDownloads.mime(file, call.getString("mime", ""));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                io.execute(() -> {
                    try {
                        AttachmentDownloads.Saved saved = AttachmentDownloads.save(getContext().getContentResolver(), file, mime);
                        call.resolve(receipt(call, saved.uri, mime, saved.location, file.length(), true));
                    } catch (Exception error) { call.reject("attachment_save_failed"); }
                });
            } else {
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
                    .setType(mime).putExtra(Intent.EXTRA_TITLE, file.getName());
                startActivityForResult(call, intent, "documentCreated");
            }
        } catch (Exception error) { call.reject("attachment_save_failed"); }
    }
    @ActivityCallback private void documentCreated(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() == Activity.RESULT_CANCELED) { call.resolve(new JSObject().put("saved", false)); return; }
        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || uri == null || !"content".equals(uri.getScheme())) { call.reject("attachment_save_failed"); return; }
        io.execute(() -> {
            try {
                File file = source(call);
                AttachmentDownloads.copy(getContext().getContentResolver(), file, uri);
                boolean persistent = false;
                try {
                    int flags = result.getData().getFlags();
                    if ((flags & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0 && (flags & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) != 0) {
                        getContext().getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        persistent = true;
                    }
                } catch (SecurityException unavailable) { /* Save still succeeded; do not claim a durable grant. */ }
                call.resolve(receipt(call, uri, AttachmentDownloads.mime(file, call.getString("mime", "")), null, file.length(), persistent));
            } catch (Exception error) { call.reject("attachment_save_failed"); }
        });
    }
    @PluginMethod public void openSaved(PluginCall call) {
        String mime = savedTypes.get(call.getString("uri", ""));
        if (mime == null) { call.reject("attachment_saved_uri_invalid"); return; }
        if ("application/vnd.android.package-archive".equals(mime) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
            // Only an explicit tap on Install APK reaches this per-app setting.
            // Android still owns the subsequent package confirmation.
            try { startActivityForResult(call, new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName())), "installPermissionReturned"); }
            catch (Exception error) { call.reject("attachment_install_permission_required"); }
            return;
        }
        launchSaved(call);
    }
    @ActivityCallback private void installPermissionReturned(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            call.reject("attachment_install_permission_required"); return;
        }
        launchSaved(call);
    }
    private void launchSaved(PluginCall call) {
        String raw = call.getString("uri", ""), mime = savedTypes.get(raw);
        if (mime == null) { call.reject("attachment_saved_uri_invalid"); return; }
        Uri uri = Uri.parse(raw);
        try (var descriptor = getContext().getContentResolver().openFileDescriptor(uri, "r")) {
            if (descriptor == null) throw new java.io.IOException();
            Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            view.setClipData(ClipData.newRawUri("attachment", uri));
            if (view.resolveActivity(getContext().getPackageManager()) == null) { call.reject("attachment_reader_missing"); return; }
            getActivity().runOnUiThread(() -> {
                try { getActivity().startActivity(view); call.resolve(); }
                catch (Exception error) { call.reject("attachment_open_failed"); }
            });
        } catch (Exception error) { call.reject("attachment_open_failed"); }
    }
    @Override protected void handleOnDestroy() { io.shutdown(); }
}
