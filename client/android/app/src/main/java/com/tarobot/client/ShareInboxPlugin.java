package com.tarobot.client;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/** An app-private, bounded inbox. Never opens paths or URLs supplied by JavaScript. */
@CapacitorPlugin(name = "TaroCubShareInbox")
public class ShareInboxPlugin extends Plugin {
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();
    private static final long DEFAULT_MAX = 512L * 1024 * 1024, SAFE_INTEGER = 9007199254740991L, TTL = 24L * 3600 * 1000;
    private android.content.SharedPreferences limits() { return getContext().getSharedPreferences("tarocub-share-limits", 0); }
    private long maxBytes() { long value = limits().getLong("maxFileBytes", DEFAULT_MAX); return value > 0 && value <= SAFE_INTEGER ? value : DEFAULT_MAX; }
    private long integer(PluginCall call, String key) throws IOException {
        Object value = call.getData().opt(key);
        if (!(value instanceof Number)) throw new IOException("share_number_invalid");
        double number = ((Number)value).doubleValue();
        if (!Double.isFinite(number) || number < 0 || number > SAFE_INTEGER || Math.rint(number) != number) throw new IOException("share_number_invalid");
        return ((Number)value).longValue();
    }
    private File root() throws IOException { File dir = new File(getContext().getNoBackupFilesDir(), "share-inbox"); if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("share_storage_failed"); return dir; }
    private File directory(String id) throws IOException { if (id == null || !id.matches("[a-f0-9-]{36}")) throw new IOException("share_id_invalid"); return new File(root(), id); }
    private void delete(File file) throws IOException { File[] children = file.listFiles(); if (children != null) for (File child : children) delete(child); if (file.exists() && !file.delete()) throw new IOException("share_cleanup_failed"); }
    private File[] entries() throws IOException {
        File[] all = root().listFiles(); if (all == null) return new File[0];
        long now = System.currentTimeMillis();
        for (File dir : all) if (ShareInboxExpiry.isExpired(dir, now, TTL)) delete(dir);
        File[] live = root().listFiles(); if (live == null) return new File[0];
        Arrays.sort(live, Comparator.comparing(File::getName)); return live;
    }
    private JSONObject read(String id) throws Exception {
        return ShareInboxExpiry.readItem(directory(id));
    }
    private void write(File dir, JSONObject item) throws Exception {
        File temp = new File(dir, "item.tmp"), target = new File(dir, "item.json");
        try (FileOutputStream out = new FileOutputStream(temp)) { out.write(item.toString().getBytes(StandardCharsets.UTF_8)); out.getFD().sync(); }
        if (!temp.renameTo(target)) throw new IOException("share_storage_failed");
    }
    @Override public void load() { receive(getActivity().getIntent()); }
    @Override protected void handleOnNewIntent(Intent intent) { receive(intent); }
    private void receive(Intent source) {
        if (source == null || !(Intent.ACTION_SEND.equals(source.getAction()) || Intent.ACTION_SEND_MULTIPLE.equals(source.getAction()))) return;
        Intent intent = new Intent(source); source.setAction(null); // Rotation must not import the same launch intent again.
        IO.execute(() -> {
            File dir = null;
            try {
                File[] live = entries(); long used = 0, maximum = maxBytes();
                for (File previous : live) { File[] files = previous.listFiles(); if (files != null) for (File file : files) used += file.length(); }
                if (live.length >= 16 || used >= 2 * maximum) throw new IOException("share_inbox_full");
                String id = UUID.randomUUID().toString(); dir = directory(id); if (!dir.mkdir()) throw new IOException("share_storage_failed");
                CharSequence extra = intent.getCharSequenceExtra(Intent.EXTRA_TEXT); String text = extra == null ? "" : extra.toString();
                if (text.getBytes(StandardCharsets.UTF_8).length > 200 * 1024) throw new IOException("share_text_too_large");
                ArrayList<Uri> uris = new ArrayList<>();
                if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) { ArrayList<Uri> values = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM); if (values != null) uris.addAll(values); }
                else { Uri value = intent.getParcelableExtra(Intent.EXTRA_STREAM); if (value != null) uris.add(value); }
                if (uris.isEmpty() && intent.getClipData() != null) for (int i = 0; i < intent.getClipData().getItemCount(); i++) { Uri value = intent.getClipData().getItemAt(i).getUri(); if (value != null) uris.add(value); }
                if (uris.size() > 64) throw new IOException("share_too_many_files");
                JSONArray files = new JSONArray(); long total = 0;
                for (Uri uri : uris) {
                    // Foreign apps may grant content-provider reads, never private file:// paths.
                    if (!"content".equals(uri.getScheme()) || (getContext().getPackageName() + ".fileprovider").equals(uri.getAuthority())) throw new IOException("share_uri_invalid");
                    String name = "shared-file", type = getContext().getContentResolver().getType(uri);
                    try (Cursor cursor = getContext().getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                        if (cursor != null && cursor.moveToFirst()) { String supplied = cursor.getString(0); if (supplied != null && !supplied.isEmpty()) name = supplied; if (!cursor.isNull(1) && cursor.getLong(1) > maximum) throw new IOException("share_file_too_large"); }
                    }
                    name = name.replaceAll("[\\\\/\\p{Cntrl}]", "_"); if (name.length() > 255) name = name.substring(0, 255); if (name.equals(".") || name.equals("..")) name = "shared-file";
                    File target = new File(dir, String.valueOf(files.length())); long size = 0;
                    try (InputStream in = getContext().getContentResolver().openInputStream(uri); FileOutputStream out = new FileOutputStream(target)) {
                        if (in == null) throw new IOException("share_file_missing"); byte[] buffer = new byte[64 * 1024]; int count;
                        while ((count = in.read(buffer)) != -1) { size += count; total += count; if (size > maximum || total > maximum || used + total > 2 * maximum) throw new IOException("share_file_too_large"); out.write(buffer, 0, count); }
                        out.getFD().sync();
                    }
                    if (size == 0) throw new IOException("share_file_empty");
                    files.put(new JSONObject().put("name", name).put("type", type != null && type.length() <= 200 ? type : "application/octet-stream").put("size", size));
                }
                if (text.trim().isEmpty() && files.length() == 0) throw new IOException("share_empty");
                write(dir, new JSONObject().put("id", id).put("createdAt", System.currentTimeMillis()).put("text", text).put("files", files));
            } catch (Exception error) {
                if (dir != null) try { delete(dir); } catch (IOException ignored) { /* The age-based cleanup retries later. */ }
                final String reason = error instanceof IOException ? error.getMessage() : "share_import_failed";
                getActivity().runOnUiThread(() -> android.widget.Toast.makeText(getContext(), getContext().getString(R.string.app_name) + ": " + reason, android.widget.Toast.LENGTH_LONG).show());
            }
        });
    }
    private interface Operation { JSObject run() throws Exception; }
    private void perform(PluginCall call, Operation action) { IO.execute(() -> { try { call.resolve(action.run()); } catch (Exception error) { call.reject("share_operation_failed", error); } }); }
    @PluginMethod public void list(PluginCall call) { perform(call, () -> { JSArray result = new JSArray(); for (File dir : entries()) if (new File(dir, "item.json").isFile()) result.put(read(dir.getName())); JSObject value = new JSObject(); value.put("items", result); return value; }); }
    @PluginMethod public void setMaxFileBytes(PluginCall call) { perform(call, () -> {
        long value = integer(call, "maxFileBytes"); if (value < 1) throw new IOException("share_limit_invalid");
        if (!limits().edit().putLong("maxFileBytes", value).commit()) throw new IOException("share_storage_failed");
        return new JSObject();
    }); }
    @PluginMethod public void prepare(PluginCall call) { perform(call, () -> {
        JSONObject item = read(call.getString("id")); JSObject delivery = call.getObject("delivery"); if (delivery == null) throw new IOException("share_delivery_invalid");
        for (String key : new String[]{"hubKey", "deviceId", "conversationId", "text"}) if (!(delivery.opt(key) instanceof String)) throw new IOException("share_delivery_invalid");
        if (delivery.getString("text").getBytes(StandardCharsets.UTF_8).length > 200 * 1024 || (delivery.getString("hubKey").isEmpty() || delivery.getString("hubKey").length() > 512) || !delivery.getString("deviceId").matches("[A-Za-z0-9_-]{1,128}") || !delivery.getString("conversationId").matches("[A-Za-z0-9_-]{1,128}")) throw new IOException("share_delivery_invalid");
        // Pin only known fields. mentions is optional (direct and legacy pins have none); an existing pin is never rewritten.
        JSONObject pinned = new JSONObject();
        for (String key : new String[]{"hubKey", "deviceId", "conversationId", "text"}) pinned.put(key, delivery.getString(key));
        if (delivery.has("mentions")) {
            Object value = delivery.opt("mentions"); if (!(value instanceof JSONArray) || ((JSONArray)value).length() < 1 || ((JSONArray)value).length() > 64) throw new IOException("share_delivery_invalid");
            JSONArray mentions = new JSONArray();
            for (int i = 0; i < ((JSONArray)value).length(); i++) { Object id = ((JSONArray)value).opt(i); if (!(id instanceof String) || !((String)id).matches("[A-Za-z0-9_-]{1,128}")) throw new IOException("share_delivery_invalid"); mentions.put(id); }
            pinned.put("mentions", mentions);
        }
        if (!item.has("delivery")) { item.put("delivery", pinned); write(directory(item.getString("id")), item); }
        return JSObject.fromJSONObject(item);
    }); }
    @PluginMethod public void readChunk(PluginCall call) { perform(call, () -> {
        String id = call.getString("id"); Integer index = call.getInt("index"), length = call.getInt("length"); long offset = integer(call, "offset");
        JSONObject item = read(id); if (index == null || index < 0 || index >= item.getJSONArray("files").length() || length == null || length < 1 || length > 1024 * 1024) throw new IOException("share_chunk_invalid");
        byte[] bytes = new byte[length]; try (RandomAccessFile file = new RandomAccessFile(new File(directory(id), String.valueOf(index)), "r")) { if (offset > file.length() || length > file.length() - offset) throw new IOException("share_chunk_invalid"); file.seek(offset); file.readFully(bytes); }
        JSObject result = new JSObject(); result.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)); return result;
    }); }
    @PluginMethod public void remove(PluginCall call) { perform(call, () -> { delete(directory(call.getString("id"))); return new JSObject(); }); }
    @PluginMethod public void clear(PluginCall call) { perform(call, () -> { for (File dir : entries()) delete(dir); if (!limits().edit().clear().commit()) throw new IOException("share_storage_failed"); return new JSObject(); }); }
}
