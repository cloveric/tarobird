package com.tarobot.client;

import static org.junit.Assert.*;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.webkit.PermissionRequest;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Exercises the installed APK and actual Capacitor permission callback without
 * opening any microphone. Only run against a disposable .voicetest package. */
@RunWith(AndroidJUnit4.class)
public class RecordingPermissionTest {
    @Test public void allowedMicrophoneGrantsWebViewAudioCapture() throws Exception {
        var instrumentation = InstrumentationRegistry.getInstrumentation();
        var context = instrumentation.getTargetContext();
        assertTrue("Must use isolated test ID", context.getPackageName().endsWith(".voicetest"));
        instrumentation.getUiAutomation().grantRuntimePermission(context.getPackageName(), Manifest.permission.RECORD_AUDIO);
        assertEquals("User has already allowed the microphone", PackageManager.PERMISSION_GRANTED,
            context.checkSelfPermission(Manifest.permission.RECORD_AUDIO));

        var intent = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        var activity = (MainActivity) instrumentation.startActivitySync(intent);
        try {
            instrumentation.waitForIdleSync();
            var done = new CountDownLatch(1);
            var outcome = new AtomicReference<String>();
            var request = new PermissionRequest() {
                @Override public Uri getOrigin() { return Uri.parse("https://localhost"); }
                @Override public String[] getResources() { return new String[]{RESOURCE_AUDIO_CAPTURE}; }
                @Override public void grant(String[] resources) {
                    outcome.set(java.util.Arrays.equals(resources, getResources()) ? "granted" : "wrong resources");
                    done.countDown();
                }
                @Override public void deny() { outcome.set("denied"); done.countDown(); }
            };
            // Use the production WebChromeClient. Its all-permissions result used
            // to deny this request despite RECORD_AUDIO being granted.
            instrumentation.runOnMainSync(() -> activity.getBridge().getWebView()
                .getWebChromeClient().onPermissionRequest(request));
            assertTrue("Native permission callback timed out", done.await(15, TimeUnit.SECONDS));
            assertEquals("An allowed microphone must reach the WebView", "granted", outcome.get());
        } finally {
            instrumentation.runOnMainSync(activity::finish);
        }
    }
}
