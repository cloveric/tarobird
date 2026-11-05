package com.tarobot.client;

import static org.junit.Assert.*;
import android.content.Intent;
import android.net.Uri;
import android.view.accessibility.AccessibilityNodeInfo;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Disposable .downloadtest only. Supply installer-fixture.apk and allow this
 * test package to request installs. The real installer is opened then cancelled.
 * For process-death coverage, run this test with -e savedReceiptPhase seed,
 * force-stop the package, then run with -e savedReceiptPhase verify. Without
 * that argument it exercises Activity/plugin recreation in a single test. */
@RunWith(AndroidJUnit4.class)
public class AttachmentSavedRestoreTest {
    private static final String KEY = "1".repeat(64), OTHER_KEY = "2".repeat(64);
    private MainActivity activity;
    private String js(String code) throws Exception {
        var instrument = InstrumentationRegistry.getInstrumentation();
        var result = new AtomicReference<String>(); var done = new CountDownLatch(1);
        instrument.runOnMainSync(() -> activity.getBridge().getWebView().evaluateJavascript(code, value -> { result.set(value); done.countDown(); }));
        assertTrue(done.await(10, TimeUnit.SECONDS)); return result.get();
    }
    private void launch() throws Exception {
        var instrument = InstrumentationRegistry.getInstrumentation(); var context = instrument.getTargetContext();
        assertTrue("Disposable app only", context.getPackageName().endsWith(".downloadtest"));
        activity = (MainActivity) instrument.startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        long until = System.currentTimeMillis() + 30000;
        while (!"true".equals(js("!!window.Capacitor?.nativePromise")) && System.currentTimeMillis() < until) Thread.sleep(100);
        assertEquals("true", js("!!window.Capacitor?.nativePromise"));
    }
    private JSONObject invoke(String method, JSONObject args) throws Exception {
        js("window.restoreResult=null;Capacitor.nativePromise('TaroBotAttachmentSaver'," + JSONObject.quote(method) + "," + args + ").then(r=>window.restoreResult={ok:true,...r},e=>window.restoreResult={error:e.message})");
        long until = System.currentTimeMillis() + 15000;
        while ("null".equals(js("window.restoreResult")) && System.currentTimeMillis() < until) Thread.sleep(100);
        return new JSONObject(js("window.restoreResult"));
    }
    private boolean cancelInstaller(AccessibilityNodeInfo node) {
        if (node == null) return false;
        if (node.getText() != null && "Cancel".equalsIgnoreCase(node.getText().toString())) {
            for (var target = node; target != null; target = target.getParent())
                if (target.isClickable() && target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
        }
        for (int i = 0; i < node.getChildCount(); i++) if (cancelInstaller(node.getChild(i))) return true;
        return false;
    }
    private String digest(byte[] bytes) throws Exception {
        return java.util.Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
    @Test public void savedApkSurvivesRestartWithoutCacheOrDownload() throws Exception {
        launch();
        var instrument = InstrumentationRegistry.getInstrumentation(); var context = instrument.getTargetContext();
        String phase = InstrumentationRegistry.getArguments().getString("savedReceiptPhase", "recreate");
        File seed = new File(context.getFilesDir(), "saved-attachment-test.json");
        File folder = new File(context.getCacheDir(), "tarocub-exports/123-abc-def"); folder.mkdirs();
        File file = new File(folder, "restart-update.apk");
        Uri saved = null; boolean retainForRestart = false;
        try {
            if (!"verify".equals(phase)) {
                File fixture = new File(context.getExternalFilesDir(null), "installer-fixture.apk");
                assertTrue("Supply a signed APK fixture", fixture.isFile());
                Files.copy(fixture.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING);
                var receipt = invoke("save", new JSONObject().put("uri", file.toURI().toString()).put("key", KEY));
                assertTrue(receipt.toString(), receipt.getBoolean("saved")); saved = Uri.parse(receipt.getString("uri"));
                var record = new JSONObject().put("uri", saved.toString()).put("sha256", digest(Files.readAllBytes(file.toPath()))).put("pid", android.os.Process.myPid());
                Files.write(seed.toPath(), record.toString().getBytes(StandardCharsets.UTF_8));
                assertTrue("Export cache is unnecessary after save", file.delete());
                if ("seed".equals(phase)) { retainForRestart = true; return; }
                instrument.runOnMainSync(activity::finish); instrument.waitForIdleSync(); launch();
            }
            var record = new JSONObject(new String(Files.readAllBytes(seed.toPath()), StandardCharsets.UTF_8));
            saved = Uri.parse(record.getString("uri"));
            if ("verify".equals(phase)) assertNotEquals("A genuinely new app process must read the receipt", record.getInt("pid"), android.os.Process.myPid());
            assertFalse("No source cache is available", file.exists());
            assertEquals("attachment_saved_uri_invalid", invoke("openSaved", new JSONObject().put("uri", saved.toString())).getString("error"));
            assertEquals("attachment_saved_key_invalid", invoke("getSaved", new JSONObject().put("key", "arbitrary-file-name")).getString("error"));
            assertFalse(invoke("getSaved", new JSONObject().put("key", OTHER_KEY)).getBoolean("saved"));
            var restored = invoke("getSaved", new JSONObject().put("key", KEY));
            assertTrue(restored.toString(), restored.getBoolean("saved")); assertEquals(saved.toString(), restored.getString("uri"));
            try (var input = context.getContentResolver().openInputStream(saved)) {
                assertNotNull(input); assertEquals("Exact original saved APK bytes", record.getString("sha256"), digest(input.readAllBytes()));
            }
            assertTrue("Enable installs only for this disposable package", context.getPackageManager().canRequestPackageInstalls());
            assertTrue(invoke("openSaved", new JSONObject().put("uri", saved.toString())).getBoolean("ok"));
            long until = System.currentTimeMillis() + 15000; boolean cancelled = false;
            while (!cancelled && System.currentTimeMillis() < until) {
                var root = instrument.getUiAutomation().getRootInActiveWindow();
                if (root != null && root.getPackageName() != null && root.getPackageName().toString().contains("packageinstaller")) cancelled = cancelInstaller(root);
                if (!cancelled) Thread.sleep(100);
            }
            assertTrue("Restored receipt reaches the real Android installer; installation is cancelled", cancelled);
            assertEquals(1, context.getContentResolver().delete(saved, null, null));
            assertFalse("Deleted public copy invalidates the receipt", invoke("getSaved", new JSONObject().put("key", KEY)).getBoolean("saved"));
            assertEquals("attachment_saved_uri_invalid", invoke("openSaved", new JSONObject().put("uri", saved.toString())).getString("error"));
        } finally {
            if (!retainForRestart) {
                if (saved != null) context.getContentResolver().delete(saved, null, null);
                seed.delete(); file.delete();
            }
            instrument.runOnMainSync(activity::finish);
        }
    }
}
