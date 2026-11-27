package com.tarobot.client;

import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static boolean isNotificationDeepLink(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return false;
        Uri data = intent.getData();
        return data != null && "tarocub".equals(data.getScheme()) && "conversation".equals(data.getHost());
    }
    @Override public void onCreate(Bundle savedInstanceState) {
        Intent launch = getIntent();
        boolean fromHistory = launch != null && (launch.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0;
        if (isNotificationDeepLink(launch) && (savedInstanceState != null || fromHistory)) {
            setIntent(new Intent(Intent.ACTION_MAIN));
        }
        registerPlugin(AppearancePlugin.class);
        registerPlugin(AttachmentOpenerPlugin.class);
        registerPlugin(AttachmentSaverPlugin.class);
        registerPlugin(QrPhotoSaverPlugin.class);
        registerPlugin(AndroidUpdaterPlugin.class);
        registerPlugin(UnifiedPushPlugin.class);
        registerPlugin(ShareInboxPlugin.class);
        registerPlugin(HubTransportPlugin.class);
        registerPlugin(DeviceIdentityPlugin.class);
        super.onCreate(savedInstanceState);
        // Bridge has already captured intentUri and dispatched onNewIntent for cold launch.
        // Clear the consumed notification link so later Activity recreation never replays it.
        if (isNotificationDeepLink(getIntent())) setIntent(new Intent(Intent.ACTION_MAIN));
        NativeInsets.install(this);
        // Reader state is process-wide; a recreated Activity starts without one.
        NativeAppearance.resetReader(this);
    }
    @Override public void onResume() { super.onResume(); NativeAppearance.restore(this); }
    @Override public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // Capacitor SystemBars still reapplies the Android theme here even with
        // insetsHandling disabled. Our saved web canvas must win afterwards.
        NativeAppearance.restore(this);
    }
    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Resume precedes window focus (including returns from native readers,
        // permission dialogs and recents), so restore contrast at that boundary too.
        if (hasFocus) NativeAppearance.restore(this);
    }
}
