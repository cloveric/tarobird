package com.tarobot.client;

import android.app.Activity;
import android.os.Build;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

/** Keep the whole WebView inside the OS safe rectangle, including its dialogs.
 * This does not depend on a WebView version or JavaScript injection timing.
 * The soft keyboard is reported to the page instead (see viewport.ts). */
final class NativeInsets {
    // An immersive reader keeps the whole screen until close. Its overlay
    // controls receive separate safe insets, without resizing the photo.
    private static boolean immersive;
    // Keep the framework's constant-typed field when saving the mode. A plain
    // int with a -1 sentinel loses that contract when it is restored.
    private static WindowManager.LayoutParams savedCutout;

    private NativeInsets() {}

    static void install(Activity activity) {
        WindowCompat.setDecorFitsSystemWindows(activity.getWindow(), false);
        var decor = activity.getWindow().getDecorView();
        var bridge = activity instanceof BridgeActivity ? ((BridgeActivity) activity).getBridge() : null;
        var keyboard = new long[] { 0, 0 };
        var readerInsets = new int[] { 0, 0, 0, 0 };
        // A reloaded page starts without the last report: give it the current
        // state. Its old dispatch time makes the page apply it without motion.
        if (bridge != null) bridge.addWebViewListener(new WebViewListener() {
            @Override public void onPageLoaded(WebView webView) {
                publishKeyboard(activity, webView, (int) keyboard[0], keyboard[1]);
                publishReaderInsets(activity, webView, readerInsets);
            }
        });
        ViewCompat.setOnApplyWindowInsetsListener(decor, (view, insets) -> {
            var safe = immersive ? Insets.NONE : insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            // Ignoring visibility keeps overlay controls clear of cutouts and
            // transient system bars even after immersive mode hides the bars.
            var readerSafe = immersive ? insets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()) : Insets.NONE;
            if (readerInsets[0] != readerSafe.top || readerInsets[1] != readerSafe.right || readerInsets[2] != readerSafe.bottom || readerInsets[3] != readerSafe.left) {
                readerInsets[0] = readerSafe.top; readerInsets[1] = readerSafe.right; readerInsets[2] = readerSafe.bottom; readerInsets[3] = readerSafe.left;
                publishReaderInsets(activity, bridge == null ? null : bridge.getWebView(), readerInsets);
            }
            var ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            // The IME overlays the WebView. During an IME animation this listener
            // receives the animation's end state, so padding for it here resized
            // the WebView before the keyboard moved. The page animates instead.
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            var overlap = Math.max(0, ime.bottom - safe.bottom);
            if (overlap != keyboard[0]) {
                keyboard[0] = overlap; keyboard[1] = System.currentTimeMillis();
                publishKeyboard(activity, bridge == null ? null : bridge.getWebView(), overlap, keyboard[1]);
            }
            // Native padding already reserves these areas. Pass zero to WebView
            // so its env() values cannot reserve the system bars a second time,
            // nor a WebView handle the IME again. Capacitor Keyboard reads its
            // visibility from the root insets, not from these.
            return new WindowInsetsCompat.Builder(insets)
                .setInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(), Insets.NONE)
                .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
                .build();
        });
        ViewCompat.requestApplyInsets(decor);
    }

    /** Viewer-only CSS padding; never applies to the chat or shrinks the canvas. */
    private static void publishReaderInsets(Activity activity, WebView webView, int[] insets) {
        if (webView == null) return;
        var density = activity.getResources().getDisplayMetrics().density;
        webView.evaluateJavascript("(()=>{const s=document.documentElement.style;"
            + "s.setProperty('--image-safe-top','" + insets[0] / density + "px');"
            + "s.setProperty('--image-safe-right','" + insets[1] / density + "px');"
            + "s.setProperty('--image-safe-bottom','" + insets[2] / density + "px');"
            + "s.setProperty('--image-safe-left','" + insets[3] / density + "px');})()", null);
    }

    /** Sends the IME's end-state overlap of the WebView (CSS px) with its
     * dispatch time, so the page can start its transition with the IME. The
     * page keeps the latest report for a controller installed after it. */
    private static void publishKeyboard(Activity activity, WebView webView, int overlap, long at) {
        if (webView == null) return;
        var height = overlap / activity.getResources().getDisplayMetrics().density;
        webView.evaluateJavascript("window.__tarobotKeyboard={height:" + height + ",at:" + at + "};window.dispatchEvent(new CustomEvent('tarobot-keyboard',{detail:window.__tarobotKeyboard}))", null);
    }

    /** Before hiding bars: also let Android 9-14 draw into a short-edge cutout.
     * After showing them: restore the window's cutout mode and safe padding. */
    static void setImmersive(Activity activity, boolean value) {
        if (immersive == value) return;
        immersive = value;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            var window = activity.getWindow();
            var attributes = window.getAttributes();
            if (value) {
                savedCutout = new WindowManager.LayoutParams();
                savedCutout.layoutInDisplayCutoutMode = attributes.layoutInDisplayCutoutMode;
                attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                window.setAttributes(attributes);
            } else if (savedCutout != null) {
                attributes.layoutInDisplayCutoutMode = savedCutout.layoutInDisplayCutoutMode;
                savedCutout = null;
                window.setAttributes(attributes);
            }
        }
        ViewCompat.requestApplyInsets(activity.getWindow().getDecorView());
    }
}
