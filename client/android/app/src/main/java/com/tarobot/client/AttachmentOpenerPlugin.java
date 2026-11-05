package com.tarobot.client;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.webkit.MimeTypeMap;
import androidx.core.content.FileProvider;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.util.Locale;

/** Grants a receiver read-only access to one prepared attachment, never a Hub
 * URL, arbitrary disk path, whole directory or writable original. */
@CapacitorPlugin(name = "TaroBotAttachmentOpener")
public final class AttachmentOpenerPlugin extends Plugin {
    @PluginMethod public void open(PluginCall call) {
        try {
            Uri source = Uri.parse(call.getString("uri", ""));
            if (!"file".equals(source.getScheme()) || source.getPath() == null || source.getAuthority() != null && !source.getAuthority().isEmpty()) throw new IllegalArgumentException();
            File file = AttachmentOpenPolicy.exportFile(getContext().getCacheDir(), source.getPath());
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".attachmentprovider", file);
            String name = file.getName(), extension = name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
            String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
            if (mime == null) mime = call.getString("mime", "application/octet-stream");
            if (mime == null || !mime.matches("[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+")) mime = "application/octet-stream";
            Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime);
            view.setClipData(ClipData.newRawUri(name, uri));
            view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (view.resolveActivity(getContext().getPackageManager()) == null) { call.reject("attachment_reader_missing"); return; }
            Intent chooser = Intent.createChooser(view, call.getString("title", "Open with"));
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            chooser.setClipData(view.getClipData());
            getActivity().runOnUiThread(() -> {
                try { getActivity().startActivity(chooser); call.resolve(); }
                catch (Exception error) { call.reject("attachment_open_failed"); }
            });
        } catch (Exception error) { call.reject("attachment_open_failed"); }
    }
}
