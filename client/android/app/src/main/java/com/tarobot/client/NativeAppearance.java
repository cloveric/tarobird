package com.tarobot.client;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

/** The WebView is inset inside decor padding. Paint that padding with the same
 * canvas as the web app; theme-color alone cannot paint native system areas. */
final class NativeAppearance {
    // A full-screen reader paints its own dark canvas over the saved theme.
    // Never persisted: a new page or Activity has no reader and starts clean.
    private static Integer readerColor;
    private static boolean readerDarkIcons;
    private static boolean immersive;

    static void restore(Activity activity) {
        var prefs = activity.getSharedPreferences("appearance", Context.MODE_PRIVATE);
        int color = readerColor != null ? readerColor : prefs.getInt("background", Color.WHITE);
        apply(activity, color, readerColor != null ? readerDarkIcons : prefs.getBoolean("darkIcons", true));
        // Focus and resume can reveal hidden bars; re-hide them while the reader asks.
        if (immersive) hideBars(activity);
    }
    static void save(Activity activity, int color, boolean darkIcons) {
        activity.getSharedPreferences("appearance", Context.MODE_PRIVATE).edit()
            .putInt("background", color).putBoolean("darkIcons", darkIcons).apply();
        restore(activity);
    }
    static void setReader(Activity activity, Integer color, boolean darkIcons) {
        readerColor = color; readerDarkIcons = darkIcons;
        restore(activity);
    }
    static void setImmersive(Activity activity, boolean value) {
        if (immersive == value) { restore(activity); return; }
        immersive = value;
        if (value) {
            // The WebView grows into the hidden bars; the reader re-anchors on resize.
            NativeInsets.setImmersive(activity, true);
            hideBars(activity);
        } else {
            var window = activity.getWindow();
            WindowCompat.getInsetsController(window, window.getDecorView()).show(WindowInsetsCompat.Type.systemBars());
            NativeInsets.setImmersive(activity, false);
        }
    }
    /** A reloaded page or recreated Activity cannot release an older reader. */
    static void resetReader(Activity activity) {
        readerColor = null;
        if (immersive) setImmersive(activity, false);
        restore(activity);
    }
    private static void hideBars(Activity activity) {
        var window = activity.getWindow();
        var controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
    }
    @SuppressWarnings("deprecation")
    private static void apply(Activity activity, int color, boolean darkIcons) {
        var window = activity.getWindow();
        window.setBackgroundDrawable(new ColorDrawable(color));
        window.getDecorView().setBackgroundColor(color);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }
        var controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(darkIcons);
        controller.setAppearanceLightNavigationBars(darkIcons);
        // DecorView's background update can clear the padding owned by
        // NativeInsets. Restore it synchronously, before the next layout/paint.
        NativeInsets.restorePadding(activity);
    }
}
