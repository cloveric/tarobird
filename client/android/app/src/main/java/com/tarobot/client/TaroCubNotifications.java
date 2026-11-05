package com.tarobot.client;

import android.Manifest;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import java.util.Map;

final class TaroCubNotifications {
    static boolean valid(String value) { return value != null && value.matches("^[A-Za-z0-9_-]{1,128}$"); }
    static void show(Context context, Map<String, String> data) {
        String id = data.get("id"), conversation = data.get("conversationId"), target = data.get("messageId"), host = data.get("hostId");
        if (!valid(id) || !valid(conversation) || !valid(target) || host != null && !host.matches("^hub_[0-9a-f]{64}$")) return;
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        MessageNotificationChannel.ensure(context, manager);
        Uri link = Uri.parse("tarocub://conversation/" + conversation + "?message=" + target + (host == null ? "" : "&host=" + host));
        Intent intent = new Intent(Intent.ACTION_VIEW, link, context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        // Preview text remains plain and bounded; navigation uses only the
        // validated host/conversation/message IDs, never text or remote URLs.
        String body = NotificationMessage.body(data);
        String appName = context.getString(R.string.app_name);
        android.app.Notification redacted = new NotificationCompat.Builder(context, MessageNotificationChannel.ID)
            .setSmallIcon(R.drawable.ic_notification).setContentTitle(appName).setContentText(NotificationMessage.genericBody(data)).build();
        NotificationCompat.Builder notification = new NotificationCompat.Builder(context, MessageNotificationChannel.ID).setSmallIcon(R.drawable.ic_notification).setContentTitle(NotificationMessage.title(data, appName)).setContentText(body).setStyle(new NotificationCompat.BigTextStyle().bigText(body)).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPublicVersion(redacted).setContentIntent(tap).setAutoCancel(true).setOnlyAlertOnce(true).setPriority(NotificationCompat.PRIORITY_HIGH);
        if (Build.VERSION.SDK_INT < 26) notification.setSound(Settings.System.DEFAULT_NOTIFICATION_URI).setVibrate(MessageNotificationChannel.VIBRATION);
        manager.notify((host == null ? "" : host + ":") + id, 0, notification.build());
    }
}
