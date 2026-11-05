package com.tarobot.client;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;

final class MessageNotificationChannel {
    // Persisted Android channel identity: keep it across upgrades so system
    // settings and the user's silent/blocked choices are never bypassed.
    static final String ID = "tarocub";
    static final long[] VIBRATION = { 0, 200 };

    static void ensure(Context context, NotificationManager manager) {
        if (Build.VERSION.SDK_INT < 26 || manager.getNotificationChannel(ID) != null) return;
        NotificationChannel channel = new NotificationChannel(ID, context.getString(R.string.app_name), NotificationManager.IMPORTANCE_HIGH);
        channel.setSound(Settings.System.DEFAULT_NOTIFICATION_URI, new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        channel.setVibrationPattern(VIBRATION);
        channel.enableVibration(true);
        manager.createNotificationChannel(channel);
    }

    /** Read only: no channel creation, permission prompt, registration or sound. */
    static JSObject status(Context context) {
        JSObject result = new JSObject();
        result.put("appEnabled", NotificationManagerCompat.from(context).areNotificationsEnabled());
        result.put("channel", "not-required");
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (manager == null) throw new IllegalStateException("notification_status_unavailable");
            NotificationChannel channel = manager.getNotificationChannel(ID);
            result.put("channel", channel == null ? "missing" : channel.getImportance() == NotificationManager.IMPORTANCE_NONE ? "disabled" : "enabled");
            if (channel != null) {
                boolean alerts = channel.getImportance() >= NotificationManager.IMPORTANCE_DEFAULT;
                result.put("soundEnabled", alerts && channel.getSound() != null);
                result.put("vibrationEnabled", alerts && channel.shouldVibrate());
            }
        }
        return result;
    }

    static Intent settingsIntent(Context context) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (manager != null && manager.getNotificationChannel(ID) != null && NotificationManagerCompat.from(context).areNotificationsEnabled()) {
                return new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName()).putExtra(Settings.EXTRA_CHANNEL_ID, ID);
            }
            return new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
        }
        return appSettingsIntent(context);
    }

    static Intent appSettingsIntent(Context context) {
        return new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.getPackageName()));
    }
}
