package com.tarobot.client;

import static org.junit.Assert.*;
import android.content.Intent;
import android.view.accessibility.AccessibilityNodeInfo;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Opt-in .updatetest only. Supply a same-signed higher-version target.apk in
 * the target's files directory. Network is intercepted in this test process;
 * production retains its fixed HTTPS GitHub destinations and real TLS checks. */
@RunWith(AndroidJUnit4.class)
public class AndroidUpdaterTest {
    private MainActivity activity;
    private String js(String code) throws Exception {
        var instrument = InstrumentationRegistry.getInstrumentation(); var result = new AtomicReference<String>(); var done = new CountDownLatch(1);
        instrument.runOnMainSync(() -> activity.getBridge().getWebView().evaluateJavascript(code, value -> { result.set(value); done.countDown(); }));
        assertTrue(done.await(10, TimeUnit.SECONDS)); return result.get();
    }
    private void launch() throws Exception {
        var instrument = InstrumentationRegistry.getInstrumentation(); var context = instrument.getTargetContext();
        activity = (MainActivity) instrument.startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        long until = System.currentTimeMillis() + 30000;
        while (!"true".equals(js("!!window.Capacitor?.nativePromise")) && System.currentTimeMillis() < until) Thread.sleep(100);
        assertEquals("true", js("!!window.Capacitor?.nativePromise"));
    }
    private JSONObject invoke(String method, JSONObject args) throws Exception {
        js("window.updateResult=null;Capacitor.nativePromise('TaroBotAndroidUpdater'," + JSONObject.quote(method) + "," + args + ").then(r=>window.updateResult={ok:true,...r},e=>window.updateResult={error:e.message})");
        long until = System.currentTimeMillis() + 15000;
        while ("null".equals(js("window.updateResult")) && System.currentTimeMillis() < until) Thread.sleep(100);
        return new JSONObject(js("window.updateResult"));
    }
    private boolean click(AccessibilityNodeInfo node, String label) {
        if (node == null) return false;
        if (node.getText() != null && label.equalsIgnoreCase(node.getText().toString())) {
            for (var target = node; target != null; target = target.getParent()) if (target.isClickable() && target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
        }
        for (int i = 0; i < node.getChildCount(); i++) if (click(node.getChild(i), label)) return true;
        return false;
    }
    @Test public void verifiedDownloadRecoveryAndSystemInstaller() throws Exception {
        var instrument = InstrumentationRegistry.getInstrumentation(); var context = instrument.getTargetContext();
        assertTrue("Disposable package only", context.getPackageName().endsWith(".updatetest"));
        byte[] apk = Files.readAllBytes(new File(context.getFilesDir(), "target.apk").toPath());
        StringBuilder hash = new StringBuilder(); for (byte b : MessageDigest.getInstance("SHA-256").digest(apk)) hash.append(String.format("%02x", b));
        JSONObject release = new JSONObject().put("tag_name", "android-tarobot-v1.0.89").put("draft", false).put("body", "Test")
            .put("assets", new JSONArray().put(new JSONObject().put("name", "TaroBot-1.0.89-android.apk").put("id", 123).put("size", apk.length).put("state", "uploaded")
                .put("digest", "sha256:" + hash).put("url", "https://api.github.com/repos/owner/repo/releases/assets/123")));
        new DeviceKeyStore(context).write("android-updates-github", new JSONObject().put("token", "test_native_only_secret").put("login", "demo").toString());
        List<String> events = new ArrayList<>(), urls = new ArrayList<>();
        AndroidUpdateService service = new AndroidUpdateService(context, "owner/repo", "Ov23.testing", state -> events.add(state.toString()));
        OkHttpClient mock = new OkHttpClient.Builder().followRedirects(false).addInterceptor(chain -> {
            var request = chain.request(); String url = request.url().toString(); urls.add(url);
            var response = new Response.Builder().request(request).protocol(Protocol.HTTP_1_1).message("fixture").code(200);
            if (url.contains("/releases?")) { assertEquals("Bearer test_native_only_secret", request.header("Authorization")); return response.body(ResponseBody.create(new JSONArray().put(release).toString().getBytes(), null)).build(); }
            if (url.contains("/releases/assets/123")) return response.code(302).header("Location", "https://release-assets.githubusercontent.com/test.apk").body(ResponseBody.create(new byte[0], null)).build();
            if (url.equals("https://release-assets.githubusercontent.com/test.apk")) { assertNull("Credential must not reach CDN", request.header("Authorization")); return response.body(ResponseBody.create(apk, null)).build(); }
            throw new AssertionError("Unexpected network: " + url);
        }).build();
        Field field = AndroidUpdateService.class.getDeclaredField("http"); field.setAccessible(true); field.set(service, mock);
        service.load(); service.check(); assertEquals("available", service.snapshot().getString("phase")); service.download();
        assertEquals("ready", service.snapshot().getString("phase")); assertTrue(service.snapshot().getBoolean("downloaded")); assertEquals(3, urls.size());
        for (String event : events) assertFalse(event.contains("test_native_only_secret"));
        // Fresh service/plugin restores and verifies bytes without another request.
        AndroidUpdateService restored = new AndroidUpdateService(context, "owner/repo", "Ov23.testing", state -> {});
        restored.load(); assertEquals("ready", restored.snapshot().getString("phase"));
        context.getSharedPreferences("updater-acceptance", 0).edit().putString("retained", "paired-history-marker").commit();
        launch(); JSONObject status = invoke("status", new JSONObject()); assertTrue(status.toString(), status.getBoolean("downloaded"));
        js("window.updateResult=null;Capacitor.nativePromise('TaroBotAndroidUpdater','invoke',{command:'install'}).then(r=>window.updateResult={ok:true,...r},e=>window.updateResult={error:e.message})");
        boolean install = "install".equals(InstrumentationRegistry.getArguments().getString("updaterAction"));
        String action = install ? "Update" : "Cancel";
        boolean clicked = false; long until = System.currentTimeMillis() + 20000;
        while (!clicked && System.currentTimeMillis() < until) { clicked = click(instrument.getUiAutomation().getRootInActiveWindow(), action); if (install && !clicked) clicked = click(instrument.getUiAutomation().getRootInActiveWindow(), "Install"); if (!clicked) Thread.sleep(200); }
        assertTrue("System installer action must be present: " + action, clicked);
        if (install) { Thread.sleep(15000); return; } // Successful self-update kills this instrumentation process; verify version/data externally.
        until = System.currentTimeMillis() + 15000;
        while ("null".equals(js("window.updateResult")) && System.currentTimeMillis() < until) Thread.sleep(100);
        JSONObject returned = new JSONObject(js("window.updateResult")); assertEquals(returned.toString(), "ready", returned.getString("phase"));
        assertTrue(restored.apk().isFile());
        // Tampering is rejected before any future URI grant.
        Files.write(restored.apk().toPath(), new byte[]{1, 2, 3});
        JSONObject rejected = invoke("invoke", new JSONObject().put("command", "install")); assertEquals("github_update_signature", rejected.getString("error"));
        assertFalse(invoke("status", new JSONObject()).getBoolean("downloaded"));
    }
}
