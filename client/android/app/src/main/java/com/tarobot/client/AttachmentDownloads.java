package com.tarobot.client;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.MimeTypeMap;
import androidx.annotation.RequiresApi;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.util.Locale;

final class AttachmentDownloads {
    static final class Saved {
        final Uri uri;
        final String location;
        Saved(Uri uri, String location) { this.uri = uri; this.location = location; }
    }
    static String mime(File file, String suggested) {
        String name = file.getName();
        String found = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT));
        String mime = found == null ? suggested : found;
        return mime != null && mime.matches("[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+") ? mime : "application/octet-stream";
    }
    static void copy(ContentResolver resolver, File file, Uri target) throws IOException {
        long expected = file.length(), written = 0;
        try (var input = new FileInputStream(file); var output = resolver.openOutputStream(target, "wt")) {
            if (output == null) throw new IOException("attachment_destination_unavailable");
            byte[] buffer = new byte[64 * 1024]; int count;
            while ((count = input.read(buffer)) != -1) { output.write(buffer, 0, count); written += count; }
            output.flush();
            if (written != expected || file.length() != expected) throw new IOException("attachment_incomplete");
        }
    }
    @RequiresApi(29) static Saved save(ContentResolver resolver, File file, String mime) throws IOException {
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, file.getName());
        values.put(MediaStore.Downloads.MIME_TYPE, mime);
        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/TaroBot");
        values.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IOException("attachment_destination_unavailable");
        boolean completed = false;
        try {
            copy(resolver, file, uri);
            // Pending MediaStore metadata can still report SIZE=0 until its
            // scanner runs. Check the closed file descriptor, not that cache.
            try (var descriptor = resolver.openFileDescriptor(uri, "r")) {
                if (descriptor == null || descriptor.getStatSize() != file.length()) throw new IOException("attachment_incomplete");
            }
            values.clear(); values.put(MediaStore.Downloads.IS_PENDING, 0);
            if (resolver.update(uri, values, null, null) != 1) throw new IOException("attachment_publish_failed");
            String name;
            // Publishing can rename a duplicate, so read the final name only
            // after IS_PENDING is cleared, never from the pending metadata.
            try (var cursor = resolver.query(uri, new String[] { MediaStore.Downloads.DISPLAY_NAME }, null, null, null)) {
                if (cursor == null || !cursor.moveToFirst()) throw new IOException("attachment_name_unavailable");
                name = cursor.getString(0);
            }
            completed = true;
            return new Saved(uri, Environment.DIRECTORY_DOWNLOADS + "/TaroBot/" + name);
        } finally {
            if (!completed) try { resolver.delete(uri, null, null); } catch (Exception ignored) { /* Preserve the original error. */ }
        }
    }
}
