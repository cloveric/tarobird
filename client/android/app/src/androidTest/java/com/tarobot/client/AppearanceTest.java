package com.tarobot.client;

import static org.junit.Assert.*;
import android.content.Intent;
import android.app.UiAutomation;
import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Bitmap;
import android.graphics.drawable.ColorDrawable;
import android.os.ParcelFileDescriptor;
import android.view.inputmethod.InputMethodManager;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Uses a disposable APK and the real WebView-to-native plugin bridge. */
@RunWith(AndroidJUnit4.class)
public class AppearanceTest {
    private MainActivity activity;
    private String js(String expression) throws Exception {
        var done = new CountDownLatch(1); var result = new AtomicReference<String>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> activity.getBridge().getWebView().evaluateJavascript(expression, value -> { result.set(value); done.countDown(); }));
        assertTrue(done.await(10, TimeUnit.SECONDS)); return result.get();
    }
    private String shell(String command) throws Exception {
        try (var input = new ParcelFileDescriptor.AutoCloseInputStream(
                InstrumentationRegistry.getInstrumentation().getUiAutomation().executeShellCommand(command))) {
            return new String(input.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8).trim();
        }
    }
    private void waitFor(String expression) throws Exception {
        long until = System.currentTimeMillis() + 30000;
        while (System.currentTimeMillis() < until) {
            if ("true".equals(js(expression))) return;
            Thread.sleep(100);
        }
        fail("UI condition timed out: " + expression);
    }
    private void setCanvas(String color, boolean darkIcons) throws Exception {
        js("document.documentElement.dataset.palette='mono';document.documentElement.dataset.theme='"
            + (darkIcons ? "light" : "dark") + "';window.canvasDone=false;Capacitor.nativePromise('TaroBotAppearance','setCanvas',{color:'"
            + color + "',darkIcons:" + darkIcons + "}).then(()=>window.canvasDone=true)");
        long until = System.currentTimeMillis() + 10000;
        while (!"true".equals(js("window.canvasDone")) && System.currentTimeMillis() < until) Thread.sleep(100);
        assertEquals("Appearance bridge completed", "true", js("window.canvasDone"));
    }
    private void waitForKeyboard(boolean visible) throws Exception {
        var instrument = InstrumentationRegistry.getInstrumentation();
        long until = System.currentTimeMillis() + 10000;
        while (System.currentTimeMillis() < until) {
            var matched = new AtomicReference<>(false);
            instrument.runOnMainSync(() -> {
                var decor = activity.getWindow().getDecorView();
                var insets = ViewCompat.getRootWindowInsets(decor);
                matched.set(insets != null && insets.isVisible(WindowInsetsCompat.Type.ime()) == visible);
                if (visible && Boolean.TRUE.equals(matched.get())) {
                    assertTrue("Keyboard remains outside the WebView", decor.getPaddingBottom() >= insets.getInsets(WindowInsetsCompat.Type.ime()).bottom);
                }
            });
            if (matched.get()) return;
            Thread.sleep(100);
        }
        fail("Keyboard visibility did not become " + visible);
    }
    private void checkCanvas(String color, boolean darkIcons, String evidence) throws Exception {
        var instrument = InstrumentationRegistry.getInstrumentation();
        instrument.waitForIdleSync();
        Thread.sleep(300); // Allow the compositor to present the native system bars.
        var screenshot = instrument.getUiAutomation().takeScreenshot();
        var folder = instrument.getTargetContext().getExternalFilesDir("evidence"); folder.mkdirs();
        try (var file = new FileOutputStream(new File(folder, evidence + ".png"))) {
            screenshot.compress(Bitmap.CompressFormat.PNG, 100, file);
        }
        instrument.runOnMainSync(() -> {
            var decor = activity.getWindow().getDecorView();
            assertEquals("Native canvas after " + evidence, Color.parseColor(color), ((ColorDrawable) decor.getBackground()).getColor());
            var controller = WindowCompat.getInsetsController(activity.getWindow(), decor);
            assertEquals("Status icon contrast", darkIcons, controller.isAppearanceLightStatusBars());
            assertEquals("Navigation icon contrast", darkIcons, controller.isAppearanceLightNavigationBars());
            assertTrue("Status bar still reserved", decor.getPaddingTop() > 0);
            assertTrue("Navigation bar still reserved", decor.getPaddingBottom() > 0);
        });
        // Sample away from status icons, the cutout and the gesture handle.
        assertEquals("Visible status bar canvas", Color.parseColor(color), screenshot.getPixel(screenshot.getWidth() / 3, 8));
        assertEquals("Visible navigation bar canvas", Color.parseColor(color), screenshot.getPixel(screenshot.getWidth() / 4, screenshot.getHeight() - 8));
        screenshot.recycle();
    }
    @Test public void coldStartupUsesSavedWebThemeInsteadOfStaleNativeCanvas() throws Exception {
        var instrument = InstrumentationRegistry.getInstrumentation(); var context = instrument.getTargetContext();
        assertTrue("Must use isolated test app", context.getPackageName().endsWith(".appearancetest"));
        String originalNight = shell("cmd uimode night").replace("Night mode: ", "");
        try {
            shell("cmd uimode night yes");
            activity = (MainActivity) instrument.startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
            waitFor("!!document.querySelector('.pairing-page')");
            for (String mode : new String[]{"light", "dark", "light"}) {
                // Seed persisted user settings, then let the packaged application
                // perform its own startup synchronization. Never call setCanvas
                // from JS here: that bypassed the failing path in the older test.
                js("window.prefsDone=false;(()=>{const prefs={theme:'" + mode + "',palette:'mono'};localStorage.setItem('tarocub-appearance',JSON.stringify(prefs));const request=indexedDB.open('tarocub-hosts-v1');request.onsuccess=()=>{const db=request.result,tx=db.transaction('meta','readwrite');tx.objectStore('meta').put(JSON.stringify(prefs),'preferences');tx.oncomplete=()=>{db.close();window.prefsDone=true;};};})()");
                waitFor("window.prefsDone");
                boolean light = mode.equals("light");
                instrument.runOnMainSync(() -> { NativeAppearance.save(activity, light ? Color.rgb(20,20,20) : Color.WHITE, !light); activity.finish(); });
                activity = (MainActivity) instrument.startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
                waitFor("!!document.querySelector('.pairing-page') && document.documentElement.dataset.theme === '" + mode + "' && document.documentElement.dataset.palette === 'mono'");
                var evidence = context.getExternalFilesDir("evidence"); evidence.mkdirs();
                try (var file = new java.io.FileWriter(new File(evidence, "cold-start-" + mode + "-state.json"))) {
                    file.write(js("JSON.stringify({bg:getComputedStyle(document.documentElement).getPropertyValue('--bg'),page:getComputedStyle(document.body).backgroundColor,theme:document.documentElement.dataset.theme,palette:document.documentElement.dataset.palette,platform:Capacitor.getPlatform(),appearancePlugin:Capacitor.PluginHeaders?.find(p=>p.name==='TaroBotAppearance'),meta:document.querySelector('meta[name=\"theme-color\"]')?.content})"));
                }
                checkCanvas(light ? "#ffffff" : "#141414", light, "cold-start-" + mode);
            }
        } finally {
            if (activity != null) instrument.runOnMainSync(activity::finish);
            if (originalNight.matches("yes|no|auto|custom")) shell("cmd uimode night " + originalNight);
        }
    }
    @Test public void canvasSurvivesReturnAndLateWindowConfiguration() throws Exception {
        var instrument = InstrumentationRegistry.getInstrumentation(); var context = instrument.getTargetContext();
        assertTrue("Must use isolated test app", context.getPackageName().endsWith(".appearancetest"));
        String originalNight = shell("cmd uimode night").replace("Night mode: ", "");
        try {
            shell("cmd uimode night yes");
            instrument.getUiAutomation().setRotation(UiAutomation.ROTATION_FREEZE_0);
            activity = (MainActivity) instrument.startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
            waitFor("!!window.Capacitor?.nativePromise && !!document.querySelector('.pairing-page')");
            for (String color : new String[]{"#ffffff", "#141414", "#fff8ed"}) {
                boolean darkIcons = !color.equals("#141414");
                setCanvas(color, darkIcons);
                checkCanvas(color, darkIcons, "initial-" + color.substring(1));
                for (int cycle = 0; cycle < 2; cycle++) {
                    shell("input keyevent KEYCODE_HOME");
                    Thread.sleep(500);
                    shell("am start -W -n " + context.getPackageName() + "/com.tarobot.client.MainActivity");
                    checkCanvas(color, darkIcons, "resume-" + color.substring(1) + "-" + cycle);
                    // Android can deliver display/UI configuration after onResume.
                    // Rotation exercises the real Capacitor configuration callback.
                    instrument.getUiAutomation().setRotation(UiAutomation.ROTATION_FREEZE_90);
                    Thread.sleep(500);
                    instrument.getUiAutomation().setRotation(UiAutomation.ROTATION_FREEZE_0);
                    Thread.sleep(500);
                    checkCanvas(color, darkIcons, "configuration-" + color.substring(1) + "-" + cycle);
                }
            }
            setCanvas("#ffffff", true);
            var dialog = new AtomicReference<AlertDialog>();
            instrument.runOnMainSync(() -> dialog.set(new AlertDialog.Builder(activity).setMessage("Appearance regression").setPositiveButton("OK", null).show()));
            Thread.sleep(300);
            instrument.runOnMainSync(() -> dialog.get().dismiss());
            checkCanvas("#ffffff", true, "native-dialog-return");

            // Keep the app's explicit light canvas while Android changes themes
            // in the background; the subsequent configuration must not own it.
            shell("input keyevent KEYCODE_HOME");
            shell("cmd uimode night no");
            shell("am start -W -n " + context.getPackageName() + "/com.tarobot.client.MainActivity");
            checkCanvas("#ffffff", true, "system-theme-return");

            js("document.querySelector('.pairing-manual').click()");
            waitFor("!!document.querySelector('.pairing-page input')");
            js("document.querySelector('.pairing-page input').focus()");
            instrument.runOnMainSync(() -> {
                var web = activity.getBridge().getWebView(); web.requestFocus();
                ((InputMethodManager) activity.getSystemService(Context.INPUT_METHOD_SERVICE)).showSoftInput(web, InputMethodManager.SHOW_IMPLICIT);
            });
            waitForKeyboard(true);
            shell("input keyevent KEYCODE_BACK");
            waitForKeyboard(false);
            checkCanvas("#ffffff", true, "keyboard-dismissed");
        } finally {
            instrument.getUiAutomation().setRotation(UiAutomation.ROTATION_UNFREEZE);
            if (activity != null) instrument.runOnMainSync(activity::finish);
            if (originalNight.matches("yes|no|auto|custom")) shell("cmd uimode night " + originalNight);
        }
    }
    /** Test actual painted pixels, not just onload/naturalWidth or DOM visibility.
     * Package the isolated image-viewer-phone fixture; no Host or upload is used. */
    @Test public void draftPhotoPaintsAfterOpeningAndReopening() throws Exception {
        var instrument = InstrumentationRegistry.getInstrumentation(); var context = instrument.getTargetContext();
        assertTrue("Must use isolated test app", context.getPackageName().endsWith(".appearancetest"));
        String originalHint = shell("settings get secure immersive_mode_confirmations");
        try {
            // Do not let Android's one-time education overlay cover our pixels.
            shell("settings put secure immersive_mode_confirmations confirmed");
            activity = (MainActivity) instrument.startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
            waitFor("!!document.querySelector('#add-draft')"); js("document.querySelector('#add-draft').click()");
            waitFor("!!document.querySelector('.draft-file-open')");
            var evidence = context.getExternalFilesDir("evidence"); evidence.mkdirs();
            for (int cycle = 0; cycle < 3; cycle++) {
                js("document.querySelector('.draft-file-open').click()");
                waitFor("document.querySelector('.image-preview-lightbox img')?.naturalWidth===1440");
                Thread.sleep(800); // Native immersive transition and first paint.
                var screenshot = instrument.getUiAutomation().takeScreenshot();
                try {
                    try (var output = new FileOutputStream(new File(evidence, "draft-photo-" + cycle + ".png"))) {
                        screenshot.compress(Bitmap.CompressFormat.PNG, 100, output);
                    }
                    // The lower image is a solid green JPEG, away from controls.
                    int pixel = screenshot.getPixel(screenshot.getWidth() / 2, screenshot.getHeight() * 2 / 3);
                    assertTrue("Decoded draft must paint, cycle " + cycle + ": " + Integer.toHexString(pixel),
                        Color.red(pixel) > 55 && Color.red(pixel) < 95 && Color.green(pixel) > 137 && Color.green(pixel) < 177
                        && Color.blue(pixel) > 92 && Color.blue(pixel) < 132);
                } finally { screenshot.recycle(); }
                js("document.querySelector('.lightbox-close').click()"); waitFor("!document.querySelector('.image-preview-lightbox')");
                assertEquals("Unsent attachment remains in draft", "1", js("document.querySelectorAll('.draft-file-open').length"));
                Thread.sleep(350);
            }
        } finally {
            if (activity != null) instrument.runOnMainSync(activity::finish);
            if (originalHint.equals("confirmed")) shell("settings put secure immersive_mode_confirmations confirmed");
            else shell("settings delete secure immersive_mode_confirmations");
        }
    }

    /** Package the isolated image-viewer-phone fixture for this method. */
    @Test public void imageToolbarDoesNotResizeNativeCanvas() throws Exception {
        var instrument = InstrumentationRegistry.getInstrumentation(); var context = instrument.getTargetContext();
        assertTrue("Must use isolated test app", context.getPackageName().endsWith(".appearancetest"));
        activity = (MainActivity) instrument.startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        try {
            waitFor("!!document.querySelector('#open-reader')");
            js("document.querySelector('#open-reader').click()");
            waitFor("!!document.querySelector('.image-preview-lightbox img')?.naturalWidth");
            Thread.sleep(700); // let initial native fullscreen and layout settle
            // A fresh emulator can show Android's first-fullscreen education
            // overlay. Dismiss its actual button, not a guessed screen tap.
            long hintDeadline = System.currentTimeMillis() + 2500;
            boolean hintDismissed = false;
            while (!hintDismissed && System.currentTimeMillis() < hintDeadline) {
                var root = instrument.getUiAutomation().getRootInActiveWindow();
                if (root != null) for (var node : root.findAccessibilityNodeInfosByViewId("com.android.systemui:id/ok")) {
                    if (node.isClickable()) hintDismissed = node.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK);
                }
                if (!hintDismissed) Thread.sleep(100);
            }
            Thread.sleep(300);
            String geometry = "JSON.stringify((()=>{const r=document.querySelector('.image-preview-lightbox img').getBoundingClientRect();return [innerWidth,innerHeight,r.x,r.y,r.width,r.height]})())";
            String before = js(geometry);
            var evidence = context.getExternalFilesDir("evidence"); evidence.mkdirs();
            try (var file = new FileOutputStream(new File(evidence, "reader-controls.png"))) {
                instrument.getUiAutomation().takeScreenshot().compress(Bitmap.CompressFormat.PNG, 100, file);
            }
            js("window.readerFrames=[];window.readerSampling=true;(()=>{const tick=()=>{if(!window.readerSampling)return;window.readerFrames.push(" + geometry + ");requestAnimationFrame(tick)};requestAnimationFrame(tick)})()");
            for (int cycle = 0; cycle < 2; cycle++) {
                // Empty canvas below the toolbar; inject actual Android touch.
                String point = js("JSON.stringify([Math.round(innerWidth*.5*devicePixelRatio),Math.round(innerHeight*.22*devicePixelRatio)])");
                var xy = new org.json.JSONArray(new org.json.JSONTokener(point).nextValue().toString());
                shell("input tap " + xy.getInt(0) + " " + xy.getInt(1));
                waitFor("document.querySelector('.image-preview-lightbox')?.dataset.controls==='hidden'");
                Thread.sleep(700);
                assertEquals("Image geometry after hiding controls", before, js(geometry));
                assertEquals("Touch never paints a viewport-sized focus ring", "\"none\"", js("getComputedStyle(document.querySelector('.image-preview-scroll')).outlineStyle"));
                if (cycle == 0) try (var file = new FileOutputStream(new File(evidence, "reader-hidden.png"))) {
                    instrument.getUiAutomation().takeScreenshot().compress(Bitmap.CompressFormat.PNG, 100, file);
                }
                shell("input tap " + xy.getInt(0) + " " + xy.getInt(1));
                waitFor("document.querySelector('.image-preview-lightbox')?.dataset.controls==='visible'");
                Thread.sleep(700);
                assertEquals("Image geometry after showing controls", before, js(geometry));
            }
            js("window.readerSampling=false");
            try (var file = new java.io.FileWriter(new File(evidence, "reader-frames.json"))) { file.write(js("JSON.stringify(window.readerFrames)")); }
            assertEquals("No intermediate resize while controls fade", "1", js("new Set(window.readerFrames).size"));
            assertEquals("Overlay close button clears native safe top", "true", js("document.querySelector('.lightbox-close').getBoundingClientRect().top >= parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--image-safe-top'))"));
            instrument.runOnMainSync(() -> {
                var decor = activity.getWindow().getDecorView();
                assertEquals(0, decor.getPaddingTop()); assertEquals(0, decor.getPaddingBottom());
            });
            js("document.querySelector('.lightbox-close').click()");
            waitFor("!document.querySelector('.image-preview-lightbox')");
            Thread.sleep(700);
            instrument.runOnMainSync(() -> {
                var decor = activity.getWindow().getDecorView();
                assertTrue("Chat restores status safe area", decor.getPaddingTop() > 0);
                assertTrue("Chat restores navigation safe area", decor.getPaddingBottom() > 0);
            });
        } finally { js("window.readerSampling=false"); instrument.runOnMainSync(activity::finish); }
    }
    @Test public void nativePaddingMatchesLightAndDarkCanvas() throws Exception {
        var instrument = InstrumentationRegistry.getInstrumentation(); var context = instrument.getTargetContext();
        assertTrue("Must use isolated test app", context.getPackageName().endsWith(".appearancetest"));
        activity = (MainActivity) instrument.startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        try {
            long ready = System.currentTimeMillis() + 30000;
            while (!"true".equals(js("!!window.Capacitor?.nativePromise && !!document.querySelector('.pairing-page')")) && System.currentTimeMillis() < ready) Thread.sleep(100);
            for (boolean light : new boolean[]{true, false, true}) {
                String color = light ? "#ffffff" : "#141414";
                js("document.documentElement.dataset.palette='mono';document.documentElement.dataset.theme='" + (light ? "light" : "dark") + "';window.canvasDone=false;Capacitor.nativePromise('TaroBotAppearance','setCanvas',{color:'" + color + "',darkIcons:" + light + "}).then(()=>window.canvasDone=true)");
                long until = System.currentTimeMillis() + 10000;
                while (!"true".equals(js("window.canvasDone")) && System.currentTimeMillis() < until) Thread.sleep(100);
                assertEquals("true", js("window.canvasDone"));
                instrument.runOnMainSync(() -> {
                    var decor = activity.getWindow().getDecorView();
                    assertEquals(Color.parseColor(color), ((ColorDrawable) decor.getBackground()).getColor());
                    assertEquals(light, WindowCompat.getInsetsController(activity.getWindow(), decor).isAppearanceLightStatusBars());
                    assertTrue("Status bar still reserved", decor.getPaddingTop() > 0);
                });
                var folder = context.getExternalFilesDir("evidence"); folder.mkdirs();
                Thread.sleep(200);
                try (var file = new FileOutputStream(new File(folder, light ? "canvas-light.png" : "canvas-dark.png"))) {
                    instrument.getUiAutomation().takeScreenshot().compress(Bitmap.CompressFormat.PNG, 100, file);
                }
            }
            instrument.runOnMainSync(() -> {
                NativeAppearance.restore(activity);
                assertEquals(Color.WHITE, ((ColorDrawable) activity.getWindow().getDecorView().getBackground()).getColor());
            });
        } finally { instrument.runOnMainSync(activity::finish); }
    }
}
