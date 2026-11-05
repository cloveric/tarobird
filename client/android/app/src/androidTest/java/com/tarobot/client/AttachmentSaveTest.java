package com.tarobot.client;

import static org.junit.Assert.*;
import android.content.Intent;
import android.provider.MediaStore;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class AttachmentSaveTest {
    private MainActivity activity;
    private String js(String code) throws Exception {
        var instrument = InstrumentationRegistry.getInstrumentation(); var result = new AtomicReference<String>(); var done = new CountDownLatch(1);
        instrument.runOnMainSync(() -> activity.getBridge().getWebView().evaluateJavascript(code, value -> { result.set(value); done.countDown(); }));
        assertTrue(done.await(10, TimeUnit.SECONDS)); return result.get();
    }
    private JSONObject save(File file) throws Exception {
        js("window.saveResult=null;Capacitor.nativePromise('TaroBotAttachmentSaver','save',{uri:" + JSONObject.quote(file.toURI().toString()) + ",mime:'text/plain'}).then(r=>window.saveResult=r,e=>window.saveResult={error:e.message})");
        long until = System.currentTimeMillis() + 15000;
        while ("null".equals(js("window.saveResult")) && System.currentTimeMillis() < until) Thread.sleep(100);
        return new JSONObject(js("window.saveResult"));
    }
    @Test public void nativeSavePublishesExactBytesAndPreservesDuplicates() throws Exception {
        var instrument = InstrumentationRegistry.getInstrumentation(); var context = instrument.getTargetContext();
        assertTrue("Disposable app only", context.getPackageName().endsWith(".downloadtest"));
        activity = (MainActivity) instrument.startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        var resolver = context.getContentResolver();
        String name = "tarobot-save-probe-" + System.currentTimeMillis() + ".txt";
        File folder = new File(context.getCacheDir(), "tarocub-exports/123-abc-def"); folder.mkdirs(); File file = new File(folder, name);
        byte[] bytes = new byte[1024 * 1024 + 53]; for (int i = 0; i < bytes.length; i++) bytes[i] = (byte)(i % 239);
        try (var output = new java.io.FileOutputStream(file)) { output.write(bytes); }
        var targets = new ArrayList<android.net.Uri>();
        try {
            long until = System.currentTimeMillis() + 30000;
            while (!"true".equals(js("!!window.Capacitor?.nativePromise")) && System.currentTimeMillis() < until) Thread.sleep(100);
            var first = save(file);
            assertTrue(first.toString(), first.optBoolean("saved"));
            byte[] newer = bytes.clone(); newer[0] = 99;
            try (var output = new java.io.FileOutputStream(file)) { output.write(newer); }
            var second = save(file); assertTrue(second.toString(), second.getBoolean("saved"));
            assertNotEquals(first.getString("location"), second.getString("location"));
            for (var result : new JSONObject[] {first, second}) {
                String location = result.getString("location"); assertTrue(location.startsWith("Download/TaroBot/"));
                try (var cursor = resolver.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                        new String[] {"_id", MediaStore.Downloads.SIZE, MediaStore.Downloads.IS_PENDING, MediaStore.Downloads.RELATIVE_PATH},
                        MediaStore.Downloads.DISPLAY_NAME + "=?", new String[] {location.substring(location.lastIndexOf('/') + 1)}, null)) {
                    assertNotNull(cursor); assertTrue(cursor.moveToFirst());
                    var uri = android.content.ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cursor.getLong(0)); targets.add(uri);
                    assertEquals(bytes.length, cursor.getLong(1)); assertEquals(0, cursor.getInt(2)); assertEquals("Download/TaroBot/", cursor.getString(3));
                    try (var input = resolver.openInputStream(uri)) { assertNotNull(input); assertArrayEquals(result == first ? bytes : newer, input.readAllBytes()); }
                    assertFalse(cursor.moveToNext());
                }
            }
            assertTrue(file.isFile()); assertArrayEquals(newer, java.nio.file.Files.readAllBytes(file.toPath()));
            assertTrue(save(new File(context.getFilesDir(), name)).has("error"));
            // A failure after MediaStore insertion must leave no published or
            // pending partial download behind.
            String failedName = "missing-" + name;
            try { AttachmentDownloads.save(resolver, new File(folder, failedName), "text/plain"); fail("Missing source must fail"); } catch (java.io.IOException expected) { }
            try (var cursor = resolver.query(MediaStore.setIncludePending(MediaStore.Downloads.EXTERNAL_CONTENT_URI), new String[] {"_id"}, MediaStore.Downloads.DISPLAY_NAME + "=?", new String[] {failedName}, null)) {
                assertNotNull(cursor); assertFalse(cursor.moveToFirst());
            }
        } finally {
            for (var uri : targets) resolver.delete(uri, null, null);
            file.delete(); folder.delete(); instrument.runOnMainSync(() -> activity.finish());
        }
    }
}
