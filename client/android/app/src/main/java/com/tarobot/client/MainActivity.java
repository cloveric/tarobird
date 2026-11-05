package com.tarobot.client;

import com.getcapacitor.BridgeActivity;
import android.content.res.Configuration;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
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
