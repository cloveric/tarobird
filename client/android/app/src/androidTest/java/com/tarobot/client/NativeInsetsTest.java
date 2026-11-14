package com.tarobot.client;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.view.inputmethod.InputMethodManager;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.JSONObject;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.io.File;
import java.io.FileWriter;
import java.util.ArrayList;

/** Uses an isolated APK, the real WebView and OS system/keyboard insets. */
@RunWith(AndroidJUnit4.class)
public class NativeInsetsTest {
    private MainActivity activity;

    private String js(String expression) throws Exception {
        var done = new CountDownLatch(1);
        var result = new AtomicReference<String>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
            activity.getBridge().getWebView().evaluateJavascript(expression, value -> { result.set(value); done.countDown(); }));
        assertTrue("WebView callback", done.await(10, TimeUnit.SECONDS));
        return result.get();
    }

    private void await(String expression) throws Exception {
        long deadline = System.currentTimeMillis() + 15000;
        while (System.currentTimeMillis() < deadline) {
            if ("true".equals(js(expression))) return;
            Thread.sleep(50);
        }
        fail("Condition timed out: " + expression + "\n" + js("document.body.innerText"));
    }

    private void assertSafeViewport(String stage) {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            var decor = activity.getWindow().getDecorView();
            var web = activity.getBridge().getWebView();
            var rootInsets = ViewCompat.getRootWindowInsets(decor);
            assertNotNull(stage + " root insets", rootInsets);
            var safe = rootInsets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            int[] root = new int[2], origin = new int[2];
            decor.getLocationOnScreen(root); web.getLocationOnScreen(origin);
            assertTrue(stage + " status bar must be reserved: WebView=" + origin[1] + ", safeTop=" + (root[1] + safe.top), origin[1] >= root[1] + safe.top);
            assertTrue(stage + " left cutout", origin[0] >= root[0] + safe.left);
            assertTrue(stage + " right cutout", origin[0] + web.getWidth() <= root[0] + decor.getWidth() - safe.right);
            assertTrue(stage + " navigation bar", origin[1] + web.getHeight() <= root[1] + decor.getHeight() - safe.bottom);
        });
    }

    private void pairChat() throws Exception {
        var fixture = new JSONObject(new String(java.util.Base64.getDecoder().decode(
            InstrumentationRegistry.getArguments().getString("fixture")), StandardCharsets.UTF_8));
        js("document.querySelector('.pairing-import-actions button.primary').click()");
        await("!!document.querySelector('.scanner-text-input')");
        js("(()=>{const input=document.querySelector('.scanner-text-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input," + JSONObject.quote(fixture.getString("link")) + ");input.dispatchEvent(new Event('input',{bubbles:true}));})()");
        await("document.querySelector('.scanner-actions button.primary')?.disabled === false");
        js("document.querySelector('.scanner-actions button.primary').click()");
        await("!!document.querySelector('.pairing-review button.primary')");
        js("document.querySelector('.pairing-review button.primary').click()");
        await("!!document.querySelector('.pair-code')");
        String code = new org.json.JSONTokener(js("document.querySelector('.pair-code').textContent")).nextValue().toString();
        try (Socket socket = new Socket("10.0.2.2", fixture.getInt("controlPort"))) {
            socket.setSoTimeout(10000);
            socket.getOutputStream().write(("GET /approve?code=" + code + " HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            assertTrue(new String(socket.getInputStream().readAllBytes(), StandardCharsets.UTF_8).startsWith("HTTP/1.1 200"));
        }
        await("!!document.querySelector('.mobile-home')");
        // This fixture has history but deliberately no model/Gateway process.
        js("window.fixturePrefsDone=false;(()=>{const r=indexedDB.open('tarocub-hosts-v1');r.onsuccess=()=>{const db=r.result,tx=db.transaction('meta','readwrite'),store=tx.objectStore('meta'),get=store.get('preferences');get.onsuccess=()=>store.put(JSON.stringify({...JSON.parse(get.result||'{}'),showDisconnectedBots:true}),'preferences');tx.oncomplete=()=>{db.close();window.fixturePrefsDone=true;};};})()");
        await("window.fixturePrefsDone === true"); js("location.reload()");
        await("Array.from(document.querySelectorAll('.mh-row')).some(b=>b.textContent.includes('原生配对验收'))");
        js("Array.from(document.querySelectorAll('.mh-row')).find(b=>b.textContent.includes('原生配对验收')).click()");
        await("!!document.querySelector('.composer textarea')");
    }

    @Test public void repeatedChatKeyboardTransitionsKeepNativeSafeRectangle() throws Exception {
        var instrument = InstrumentationRegistry.getInstrumentation(); var context = instrument.getTargetContext();
        assertTrue("Must use isolated test app", context.getPackageName().endsWith(".insettest"));
        activity = (MainActivity) instrument.startActivitySync(new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        var frames = new ArrayList<String>();
        var failures = new ArrayList<String>();
        android.view.ViewTreeObserver.OnPreDrawListener observer = () -> {
            var decor = activity.getWindow().getDecorView(); var web = activity.getBridge().getWebView();
            var insets = ViewCompat.getRootWindowInsets(decor); if (insets == null) return true;
            var safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            int[] root = new int[2], origin = new int[2]; decor.getLocationOnScreen(root); web.getLocationOnScreen(origin);
            int bottom = origin[1] + web.getHeight(), safeBottom = root[1] + decor.getHeight() - safe.bottom;
            String line = System.currentTimeMillis() + " top=" + origin[1] + " safe=" + (root[1] + safe.top) + " bottom=" + bottom + " safeBottom=" + safeBottom + " decorPadding=" + decor.getPaddingTop() + " ime=" + insets.isVisible(WindowInsetsCompat.Type.ime());
            frames.add(line);
            if (origin[1] < root[1] + safe.top || bottom > safeBottom) failures.add(line);
            return true;
        };
        try {
            await("!!document.querySelector('.pairing-manual')"); pairChat(); assertSafeViewport("chat");
            instrument.runOnMainSync(() -> activity.getWindow().getDecorView().getViewTreeObserver().addOnPreDrawListener(observer));
            for (int cycle = 0; cycle < 12; cycle++) {
                js("document.querySelector('.composer textarea').focus()");
                instrument.runOnMainSync(() -> {
                    var web = activity.getBridge().getWebView(); web.requestFocus();
                    ((InputMethodManager) activity.getSystemService(Context.INPUT_METHOD_SERVICE)).showSoftInput(web, InputMethodManager.SHOW_IMPLICIT);
                });
                await("document.documentElement.dataset.keyboardOpen === 'true'");
                Thread.sleep(cycle % 3 * 200L);
                instrument.runOnMainSync(() -> NativeAppearance.restore(activity));
                Thread.sleep(450);
                assertSafeViewport("chat keyboard " + cycle);
                instrument.runOnMainSync(() -> ((InputMethodManager) activity.getSystemService(Context.INPUT_METHOD_SERVICE))
                    .hideSoftInputFromWindow(activity.getBridge().getWebView().getWindowToken(), 0));
                await("document.documentElement.dataset.keyboardOpen !== 'true'"); Thread.sleep(350);
                js("document.querySelector('.composer textarea').blur()");
            }
            assertFalse("Must observe actual WebView frames", frames.isEmpty());
            assertTrue("Rendered frames overlapping system bars: " + failures, failures.isEmpty());
        } finally {
            instrument.runOnMainSync(() -> activity.getWindow().getDecorView().getViewTreeObserver().removeOnPreDrawListener(observer));
            try (var out = new FileWriter(new File(context.getExternalFilesDir(null), "insets-frames.txt"))) { out.write(String.join("\n", frames)); }
            instrument.runOnMainSync(activity::finish);
        }
    }

    @Test public void keyboardAndCanvasRestorationKeepSystemBarsOutsideWebView() throws Exception {
        var instrument = InstrumentationRegistry.getInstrumentation();
        var context = instrument.getTargetContext();
        assertTrue("Must use isolated test app", context.getPackageName().endsWith(".insettest"));
        activity = (MainActivity) instrument.startActivitySync(new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        try {
            await("!!document.querySelector('.pairing-manual')");
            assertSafeViewport("startup");
            js("document.querySelector('.pairing-manual').click()");
            await("!!document.querySelector('.pairing-page input')");
            js("document.querySelector('.pairing-page input').focus()");
            instrument.runOnMainSync(() -> {
                var web = activity.getBridge().getWebView(); web.requestFocus();
                ((InputMethodManager) activity.getSystemService(Context.INPUT_METHOD_SERVICE)).showSoftInput(web, InputMethodManager.SHOW_IMPLICIT);
            });
            await("document.documentElement.dataset.keyboardOpen === 'true'");
            instrument.waitForIdleSync();
            Thread.sleep(600); // Let the OS IME animation finish before the focus/appearance refresh.
            assertSafeViewport("keyboard shown");
            // The Activity restores its canvas on window focus/configuration.
            // This must not erase the already delivered safe rectangle.
            instrument.runOnMainSync(() -> {
                var decor = activity.getWindow().getDecorView();
                var before = ViewCompat.getRootWindowInsets(decor).getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
                NativeAppearance.restore(activity);
                // Do not rely on a later WebView resize to request another
                // inset dispatch. Native appearance must preserve its owner.
                assertEquals("Canvas refresh must keep the delivered top inset synchronously", before.top, decor.getPaddingTop());
                assertEquals("Canvas refresh must keep the delivered bottom inset synchronously", before.bottom, decor.getPaddingBottom());
            });
            instrument.waitForIdleSync();
            Thread.sleep(350);
            assertSafeViewport("canvas restored with keyboard");
            instrument.runOnMainSync(() -> ((InputMethodManager) activity.getSystemService(Context.INPUT_METHOD_SERVICE))
                .hideSoftInputFromWindow(activity.getBridge().getWebView().getWindowToken(), 0));
            await("document.documentElement.dataset.keyboardOpen !== 'true'");
            instrument.waitForIdleSync();
            assertSafeViewport("keyboard hidden");
            instrument.runOnMainSync(() -> activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
            await("innerWidth > innerHeight"); instrument.waitForIdleSync();
            assertSafeViewport("landscape");
            instrument.runOnMainSync(() -> activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
            await("innerHeight > innerWidth"); instrument.waitForIdleSync();
            assertSafeViewport("portrait");
            // Reader full-screen still owns zero padding and returns to the
            // current window's rectangle when its lease ends.
            instrument.runOnMainSync(() -> { NativeAppearance.setImmersive(activity, true); NativeAppearance.restore(activity); });
            Thread.sleep(400);
            instrument.runOnMainSync(() -> assertEquals("Full-screen reader remains edge-to-edge", 0, activity.getWindow().getDecorView().getPaddingTop()));
            instrument.runOnMainSync(() -> NativeAppearance.setImmersive(activity, false));
            Thread.sleep(400); instrument.waitForIdleSync();
            assertSafeViewport("reader closed");
            // A reloaded page has no JavaScript reader lease to clean up.
            // Native initialization must keep its page-start listener alive.
            instrument.runOnMainSync(() -> {
                NativeAppearance.setReader(activity, android.graphics.Color.BLACK, false);
                NativeAppearance.setImmersive(activity, true);
            });
            Thread.sleep(400);
            js("window.insetsBeforeReload=true; location.reload()");
            await("window.insetsBeforeReload !== true && !!document.querySelector('.pairing-manual')");
            instrument.waitForIdleSync(); Thread.sleep(400);
            assertSafeViewport("document reloaded with reader open");
            instrument.runOnMainSync(() -> assertTrue("Reload must release the old full-screen lease",
                ViewCompat.getRootWindowInsets(activity.getWindow().getDecorView()).isVisible(WindowInsetsCompat.Type.statusBars() | WindowInsetsCompat.Type.navigationBars())));
        } finally { instrument.runOnMainSync(activity::finish); }
    }
}
